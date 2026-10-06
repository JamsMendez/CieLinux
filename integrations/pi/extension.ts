// cielinux-scenes for pi: observes agent activity and drives the CieLinux
// wallpaper over its local HTTP API. It only listens: no handler returns a
// value, blocks, or changes anything in the session. Nothing here may throw
// into pi: every side effect is wrapped in `safe`, and requests are sent
// fire-and-forget so a slow or absent CieLinux never delays the agent.
//
// All I/O (network, files, clock, timers) comes in through `Io`, so the wiring
// is tested with a fake `pi` and a fake clock; `index.ts` supplies the real one.

import { AlertBatcher, type AlertStep } from './lib/alerts.ts'
import { CieClient, type ClientIo } from './lib/client.ts'
import { DEFAULT_CONFIG, matchesAny, mergeConfig, resolveActivity, type Config, type SceneTarget } from './lib/config.ts'
import { HoldTracker } from './lib/holds.ts'
import { SceneEngine, type Step } from './lib/scenes.ts'

export type Timer = { cancel: () => void }

export type Io = {
  fetch: ClientIo['fetch']
  /** The file's text, or undefined when it cannot be read. */
  readFile: (path: string) => Promise<string | undefined>
  exists: (path: string) => Promise<boolean>
  now: () => number
  after: (ms: number, fn: () => void) => Timer
  sleep: (ms: number) => Promise<void>
}

export type Deps = {
  io: Io
  env: Record<string, string | undefined>
  /** The extension folder, where the bundled `config.json` lives. */
  root: string
}

/** The part of pi's `ExtensionAPI` this extension uses. */
export type PiLike = { on: (event: string, handler: (event: never, ctx: never) => unknown) => unknown }

type Ctx = {
  hasUI?: boolean
  ui?: { notify?: (message: string, level?: string) => void }
  signal?: AbortSignal
}

type ToolStart = { toolCallId?: unknown; toolName?: unknown; args?: unknown }
type ToolEnd = { toolCallId?: unknown; toolName?: unknown; result?: unknown; isError?: unknown }
type PromptEvent = { kind?: unknown }
type MessageEvent = { message?: unknown }

const USER_CONFIG_PATH = 'pi-cielinux/config.json'
const SESSION_END_BUDGET_MS = 1000
/** `agent_end` without a following `agent_settled` ends the turn after this. */
export const TURN_END_FALLBACK_MS = 5000
/** Heuristic: pi reports a cancelled tool with this wording in its result text. */
const INTERRUPTED = /\baborted\b|\binterrupted\b|\bcancell?ed\b/i
/** gentle-pi delivers a finished subagent task as a custom message of this type. */
const SUBAGENT_RESULT_TYPE = 'gentle-agents.result'
/** gentle-pi's tool that relaunches a finished task; its result names the new task. */
const SUBAGENT_CONTINUE = 'subagent_continue'
/** gentle-pi task statuses after which no further work (or result message) follows a readback. */
const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out'])

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Runs a side effect; any failure is swallowed so the session never sees it. */
const safe = async (work: () => unknown): Promise<void> => {
  try {
    await work()
  } catch {
    // Observing only: a failed side effect must never affect the session.
  }
}

/** gentle-pi's task metadata (`details.gentleAgents`) on a tool result or custom message. */
const gentleAgents = (value: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(value) || !isRecord(value.details)) return undefined
  const meta = value.details.gentleAgents
  return isRecord(meta) ? meta : undefined
}

/** The task id of a `subagent_run` result that queued a background task. */
const backgroundTaskId = (result: unknown): string | undefined => {
  const meta = gentleAgents(result)
  return meta?.mode === 'background' && typeof meta.taskId === 'string' ? meta.taskId : undefined
}

/** The text parts of a tool result (`{ content: [{ type: 'text', text }] }`). */
const resultText = (result: unknown): string => {
  if (typeof result === 'string') return result
  if (!isRecord(result) || !Array.isArray(result.content)) return ''
  return result.content
    .map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('\n')
}

export const cieLinuxScenes = (pi: PiLike, deps: Deps): void => {
  // Subagent children are separate pi processes that load extensions too; the
  // parent already represents them through its `subagent_run` call.
  if (deps.env.GENTLE_PI_AGENTS_CHILD === '1') return

  const { io, env, root } = deps
  const on = pi.on as (event: string, handler: (event: unknown, ctx: unknown) => unknown) => unknown

  let config: Config = DEFAULT_CONFIG
  let isSessionActive = false
  let hasWarnedInvalidConfig = false
  let sceneTimer: Timer | undefined
  let alertTimer: Timer | undefined
  let turnFallbackTimer: Timer | undefined
  /** Scene activity started for each running tool call, by toolCallId. */
  let toolActivities = new Map<string, string>()
  /** Agent activity of each background subagent still running, by gentle-pi taskId. */
  let backgroundTasks = new Map<string, string>()
  let promptDepth = 0
  let promptSeq = 0
  let promptKey: string | undefined

  const scenes = new SceneEngine(config.timing, config.scenes.idle.scene)
  const alerts = new AlertBatcher(config.alerts)
  const client = new CieClient(
    {
      fetch: (url, init) => io.fetch(url, init),
      readFile: path => io.readFile(path),
      now: async () => io.now(),
      home: async () => env.HOME,
    },
    config.server,
  )
  const holds = new HoldTracker({ open: () => client.sendHold(), clear: id => client.clearAlert(id) })

  // ---- configuration -------------------------------------------------------

  type JsonRead = { value?: unknown; isInvalid: boolean }

  const readJson = async (path: string): Promise<JsonRead> => {
    if (!(await io.exists(path))) return { isInvalid: false }
    const text = await io.readFile(path)
    if (text === undefined) return { isInvalid: false }
    try {
      return { value: JSON.parse(text), isInvalid: false }
    } catch {
      return { isInvalid: true }
    }
  }

  const loadConfig = (ctx: unknown) =>
    safe(async () => {
      const configHome = env.XDG_CONFIG_HOME || `${env.HOME ?? ''}/.config`
      const bundled = await readJson(`${root}/config.json`)
      const user = await readJson(`${configHome}/${USER_CONFIG_PATH}`)
      if (bundled.isInvalid || user.isInvalid) {
        // Keep the last good configuration; say so once per session.
        const { hasUI, ui } = (ctx ?? {}) as Ctx
        if (!hasWarnedInvalidConfig && hasUI === true) {
          ui?.notify?.('cielinux-scenes: config.json is not valid JSON; keeping the last good config', 'warning')
        }
        hasWarnedInvalidConfig = true
        return
      }
      config = mergeConfig(mergeConfig(DEFAULT_CONFIG, bundled.value), user.value)
      scenes.configure(config.timing, config.scenes.idle.scene)
      alerts.configure(config.alerts)
      client.configure(config.server)
    })

  // ---- scheduling ----------------------------------------------------------

  /** Fire-and-forget: pi awaits handlers, so a request must not hold one up. */
  const dispatch = (send: () => Promise<unknown>) => {
    void safe(send)
  }

  const applySceneStep = (step: Step, now: number) => {
    const scene = step.send
    if (scene !== undefined) dispatch(() => client.sendScene(scene))
    sceneTimer?.cancel()
    sceneTimer = undefined
    if (step.wakeAt === undefined) return
    sceneTimer = io.after(Math.max(0, step.wakeAt - now), () =>
      void safe(() => {
        const at = io.now()
        applySceneStep(scenes.update(at), at)
      }),
    )
  }

  const applyAlertStep = (step: AlertStep, now: number) => {
    const body = step.send
    if (body !== undefined) dispatch(() => client.sendAlert(body))
    alertTimer?.cancel()
    alertTimer = undefined
    if (step.wakeAt === undefined) return
    alertTimer = io.after(Math.max(0, step.wakeAt - now), () =>
      void safe(() => {
        const at = io.now()
        applyAlertStep(alerts.update(at), at)
      }),
    )
  }

  const sceneChange = (change: (now: number) => Step) =>
    safe(() => {
      if (!isSessionActive || !config.enabled) return
      const now = io.now()
      applySceneStep(change(now), now)
    })

  const alertChange = (change: (now: number) => AlertStep) =>
    safe(() => {
      if (!isSessionActive || !config.enabled) return
      const now = io.now()
      applyAlertStep(change(now), now)
    })

  const clearTimers = () => {
    sceneTimer?.cancel()
    alertTimer?.cancel()
    turnFallbackTimer?.cancel()
    sceneTimer = undefined
    alertTimer = undefined
    turnFallbackTimer = undefined
  }

  // ---- held warnings -------------------------------------------------------

  const canHold = () =>
    config.enabled && config.alerts.warning.enabled && config.alerts.warning.hold && !holds.isUnsupported

  /** Holds a warning for `key`; a 400 falls back to the timed warning. */
  const openHold = (key: string) =>
    safe(() => {
      void holds.open(key)?.then(reply => {
        if (reply.kind === 'unsupported') void alertChange(now => alerts.warning(now))
      })
    })

  const closeHold = (key: string) =>
    safe(() => {
      if (holds.has(key)) dispatch(() => holds.close(key))
    })

  // ---- session -------------------------------------------------------------

  on('session_start', async (_event, ctx) => {
    await safe(async () => {
      clearTimers()
      scenes.reset()
      alerts.reset()
      holds.reset()
      toolActivities = new Map()
      backgroundTasks = new Map()
      promptDepth = 0
      promptKey = undefined
      hasWarnedInvalidConfig = false
      isSessionActive = true
      await loadConfig(ctx)
    })
  })

  on('session_shutdown', async () => {
    await safe(async () => {
      if (!isSessionActive) return
      isSessionActive = false
      clearTimers()
      alerts.reset()
      toolActivities = new Map()
      backgroundTasks = new Map()
      promptDepth = 0
      promptKey = undefined
      const idle = scenes.end(io.now())
      const work: Promise<unknown>[] = [holds.closeAll()]
      if (idle !== undefined && config.enabled) work.push(client.sendScene(idle))
      // Bounded: pi is shutting down and must not wait on an absent CieLinux.
      await Promise.race([Promise.all(work), io.sleep(SESSION_END_BUDGET_MS)])
    })
  })

  // ---- the turn ------------------------------------------------------------

  const endTurn = () => {
    turnFallbackTimer?.cancel()
    turnFallbackTimer = undefined
    return sceneChange(now => scenes.remove('turn', now))
  }

  on('agent_start', async (_event, ctx) => {
    turnFallbackTimer?.cancel()
    turnFallbackTimer = undefined
    await loadConfig(ctx)
    await sceneChange(now => scenes.add('turn', config.scenes.turn, now))
  })

  // `agent_settled` is final: pi will not continue on its own. `agent_end` may
  // be followed by a retry or compaction, so it only ends the turn when no new
  // `agent_start` or `agent_settled` comes within TURN_END_FALLBACK_MS.
  on('agent_settled', () => endTurn())

  on('agent_end', () =>
    safe(() => {
      if (!isSessionActive) return
      turnFallbackTimer?.cancel()
      turnFallbackTimer = io.after(TURN_END_FALLBACK_MS, () => void endTurn())
    }),
  )

  // ---- tool calls and subagents --------------------------------------------

  on('tool_execution_start', event =>
    safe(async () => {
      const { toolCallId, toolName, args } = event as ToolStart
      if (typeof toolCallId !== 'string' || typeof toolName !== 'string') return
      let activityId: string
      let target: SceneTarget | undefined
      if (matchesAny(config.scenes.subagentTools, toolName)) {
        const agent = isRecord(args) && typeof args.agent === 'string' ? args.agent : undefined
        if (agent === undefined) return
        activityId = `agent:${toolCallId}`
        target = resolveActivity(config.scenes, 'agent', agent)
      } else {
        activityId = `tool:${toolCallId}`
        target = resolveActivity(config.scenes, 'tool', toolName)
      }
      if (target === undefined) return
      const resolved = target
      toolActivities.set(toolCallId, activityId)
      await sceneChange(now => scenes.add(activityId, resolved, now))
    }),
  )

  /**
   * gentle-pi's other `subagent_*` tools: a readback of a finished background
   * task consumes its result (no message follows), so it ends the activity; a
   * background `subagent_continue` launches a new task, tracked like a run.
   */
  const trackBackgroundReadback = async (toolCallId: unknown, toolName: string, result: unknown) => {
    const meta = gentleAgents(result)
    const taskId = meta?.taskId
    if (typeof taskId !== 'string') return
    const tracked = backgroundTasks.get(taskId)
    if (tracked !== undefined && typeof meta?.status === 'string' && FINISHED_STATUSES.has(meta.status)) {
      backgroundTasks.delete(taskId)
      await sceneChange(now => scenes.remove(tracked, now))
      return
    }
    if (toolName !== SUBAGENT_CONTINUE || typeof toolCallId !== 'string' || backgroundTaskId(result) === undefined) return
    const agent = meta?.agent
    const target = typeof agent === 'string' ? resolveActivity(config.scenes, 'agent', agent) : undefined
    if (target === undefined) return
    const activityId = `agent:${toolCallId}`
    backgroundTasks.set(taskId, activityId)
    await sceneChange(now => scenes.add(activityId, target, now))
  }

  on('tool_execution_end', (event, ctx) =>
    safe(async () => {
      const { toolCallId, toolName, result, isError } = event as ToolEnd
      if (typeof toolCallId === 'string') {
        const activityId = toolActivities.get(toolCallId)
        toolActivities.delete(toolCallId)
        // A background subagent outlives its call: keep its activity until the
        // task's result message arrives (or the engine prunes it as stale).
        const taskId =
          activityId !== undefined && isError !== true && typeof toolName === 'string' && matchesAny(config.scenes.subagentTools, toolName)
            ? backgroundTaskId(result)
            : undefined
        if (activityId !== undefined && taskId !== undefined) backgroundTasks.set(taskId, activityId)
        else if (activityId !== undefined) await sceneChange(now => scenes.remove(activityId, now))
      }
      if (isError !== true && typeof toolName === 'string' && toolName.startsWith('subagent_')) {
        await trackBackgroundReadback(toolCallId, toolName, result)
      }
      const failed = config.alerts.failed
      if (isError !== true || typeof toolName !== 'string' || !matchesAny(failed.tools, toolName)) return
      const isInterrupted = (ctx as Ctx | undefined)?.signal?.aborted === true || INTERRUPTED.test(resultText(result))
      if (failed.ignoreInterrupted && isInterrupted) return
      await alertChange(now => alerts.failed(now))
    }),
  )

  on('message_end', event =>
    safe(async () => {
      const { message } = (event ?? {}) as MessageEvent
      if (!isRecord(message) || message.role !== 'custom' || message.customType !== SUBAGENT_RESULT_TYPE) return
      const taskId = gentleAgents(message)?.taskId
      if (typeof taskId !== 'string') return
      const activityId = backgroundTasks.get(taskId)
      if (activityId === undefined) return
      backgroundTasks.delete(taskId)
      await sceneChange(now => scenes.remove(activityId, now))
    }),
  )

  // ---- the user is asked something ----------------------------------------

  // pi fires ui_prompt_start / ui_prompt_end around every blocking dialog
  // (select, confirm, input, editor, custom), outermost only; the depth count
  // guards against a host that reports nested prompts too.
  const isWatchedPrompt = (event: unknown) => {
    const { kind } = (event ?? {}) as PromptEvent
    return typeof kind === 'string' && matchesAny(config.alerts.warning.on, kind)
  }

  on('ui_prompt_start', event =>
    safe(async () => {
      if (!isSessionActive || !config.alerts.warning.enabled || !isWatchedPrompt(event)) return
      if (promptDepth++ > 0) return
      if (canHold()) {
        promptKey = `prompt:${++promptSeq}`
        await openHold(promptKey)
      } else {
        promptKey = undefined
        await alertChange(now => alerts.warning(now))
      }
    }),
  )

  on('ui_prompt_end', event =>
    safe(async () => {
      if (promptDepth === 0 || !isWatchedPrompt(event)) return
      if (--promptDepth > 0) return
      const key = promptKey
      promptKey = undefined
      if (key !== undefined) await closeHold(key)
    }),
  )
}
