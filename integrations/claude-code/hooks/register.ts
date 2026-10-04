// cielinux-scenes: observes Claude Code activity and drives the CieLinux
// wallpaper over its local HTTP API. Every hook passes its event on unchanged
// (`next(e)`) and returns what `next` answered: the plugin only observes.
// Nothing here may throw into the session: side effects are wrapped in `safe`.
//
// `$` may only be spelled `$.noun.method(...)` at a call site, never stored or
// passed. The hooks that start a session or a turn therefore build `Ports`, a
// set of closures over their `$`, and keep it for timers and later hooks.

import type { Register, Timer } from 'claude-code'
import { AlertBatcher, type AlertStep } from './alerts'
import { CieClient, type ClientIo, type HoldReply } from './client'
import { DEFAULT_CONFIG, matchesAny, mergeConfig, resolveActivity, type Config } from './config'
import { HoldTracker } from './holds'
import { SceneEngine, type Step } from './scenes'

/** The engine calls the plugin needs, as closures built inside a hook. */
export type Ports = ClientIo & {
  after: (ms: number, fn: () => void) => Timer
  sleep: (ms: number) => Promise<void>
  exists: (path: string) => Promise<boolean>
  configHome: () => Promise<string | undefined>
  toast: (text: string) => void
  root: string
}

const USER_CONFIG_PATH = 'claude-cielinux/config.json'
const SESSION_END_BUDGET_MS = 1000
const INTERRUPTED = /request interrupted|interrupted by user/i

/** A tool call whose `next(e)` (permission prompt, then the tool) is still running. */
type PendingCall = { id: string; tool: string; agentId: string | undefined }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Runs a side effect; any failure is swallowed so the session never sees it. */
const safe = async (work: () => unknown): Promise<void> => {
  try {
    await work()
  } catch {
    // Observing only: a failed side effect must never affect the session.
  }
}

export const register: Register = on => {
  let config: Config = DEFAULT_CONFIG
  let ports: Ports | undefined
  let hasWarnedInvalidConfig = false
  let sceneTimer: Timer | undefined
  let alertTimer: Timer | undefined
  let pendingCalls: PendingCall[] = []

  const scenes = new SceneEngine(config.timing, config.scenes.idle.scene)
  const alerts = new AlertBatcher(config.alerts)

  const port = (): Ports => {
    if (ports === undefined) throw new Error('cielinux-scenes: no session yet')
    return ports
  }

  const client = new CieClient(
    {
      fetch: (url, init) => port().fetch(url, init),
      readFile: path => port().readFile(path),
      now: () => port().now(),
      home: () => port().home(),
    },
    config.server,
  )

  const holds = new HoldTracker({
    // Sent from a timer like every request, so it outlives the hook's dispatch.
    open: () =>
      new Promise<HoldReply>(resolve => {
        port().after(0, () => void client.sendHold().then(resolve))
      }),
    clear: id => client.clearAlert(id),
  })

  // ---- configuration -------------------------------------------------------

  type JsonRead = { value?: unknown; isInvalid: boolean }

  const readJson = async (io: Ports, path: string): Promise<JsonRead> => {
    if (!(await io.exists(path))) return { isInvalid: false }
    const text = await io.readFile(path)
    if (text === undefined) return { isInvalid: false }
    try {
      return { value: JSON.parse(text), isInvalid: false }
    } catch {
      return { isInvalid: true }
    }
  }

  const loadConfig = () =>
    safe(async () => {
      const io = port()
      const configHome = (await io.configHome()) || `${await io.home()}/.config`
      const bundled = await readJson(io, `${io.root}/config.json`)
      const user = await readJson(io, `${configHome}/${USER_CONFIG_PATH}`)
      if (bundled.isInvalid || user.isInvalid) {
        // Keep the last good configuration; say so once per session.
        if (!hasWarnedInvalidConfig) io.toast('cielinux-scenes: config.json is not valid JSON; keeping the last good config')
        hasWarnedInvalidConfig = true
        return
      }
      config = mergeConfig(mergeConfig(DEFAULT_CONFIG, bundled.value), user.value)
      scenes.configure(config.timing, config.scenes.idle.scene)
      alerts.configure(config.alerts)
      client.configure(config.server)
    })

  // ---- scheduling ----------------------------------------------------------

  /** Fire-and-forget from a timer, so the request outlives the hook's dispatch. */
  const dispatch = (send: () => Promise<unknown>) => {
    port().after(0, () => void safe(send))
  }

  const applySceneStep = (step: Step, now: number) => {
    const scene = step.send
    if (scene !== undefined) dispatch(() => client.sendScene(scene))
    sceneTimer?.cancel()
    sceneTimer = undefined
    if (step.wakeAt === undefined) return
    sceneTimer = port().after(Math.max(0, step.wakeAt - now), () =>
      void safe(async () => {
        const at = await port().now()
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
    alertTimer = port().after(Math.max(0, step.wakeAt - now), () =>
      void safe(async () => {
        const at = await port().now()
        applyAlertStep(alerts.update(at), at)
      }),
    )
  }

  const sceneChange = (change: (now: number) => Step) =>
    safe(async () => {
      if (ports === undefined || !config.enabled) return
      const now = await port().now()
      applySceneStep(change(now), now)
    })

  const alertChange = (change: (now: number) => AlertStep) =>
    safe(async () => {
      if (ports === undefined || !config.enabled) return
      const now = await port().now()
      applyAlertStep(change(now), now)
    })

  const startAgent = (agentId: string, agentType: string) => {
    const target = resolveActivity(config.scenes, 'agent', agentType)
    if (target === undefined) return Promise.resolve()
    return sceneChange(now => scenes.add(`agent:${agentId}`, target, now))
  }

  const endAgent = (agentId: string) => sceneChange(now => scenes.remove(`agent:${agentId}`, now))

  // ---- held warnings -------------------------------------------------------

  const canHold = () => config.enabled && config.alerts.warning.enabled && config.alerts.warning.hold && !holds.isUnsupported

  /** Holds a warning for tool call `id`; a 400 falls back to the timed warning. */
  const openHold = (id: string) =>
    safe(() => {
      void holds.open(id)?.then(reply => {
        if (reply.kind === 'unsupported') void alertChange(now => alerts.warning(now))
      })
    })

  const closeHold = (id: string) =>
    safe(() => {
      if (holds.has(id)) dispatch(() => holds.close(id))
    })

  /**
   * The tool call a permission prompt belongs to. `classic.PermissionRequest`
   * carries no tool_use_id, but it fires inside the guarded call's `tool.call`
   * `next(e)`: take the oldest pending call of that tool without a hold yet,
   * preferring one from the same agent. A call that already holds means the
   * prompt is a repeat; undefined means no such call is pending.
   */
  const callForPrompt = (tool: string, agentId: string | undefined): PendingCall | 'held' | undefined => {
    const calls = pendingCalls.filter(call => call.tool === tool)
    if (calls.length === 0) return undefined
    const free = calls.filter(call => !holds.has(call.id))
    if (free.length === 0) return 'held'
    return free.find(call => call.agentId === agentId) ?? free[0]
  }

  const clearTimers = () => {
    sceneTimer?.cancel()
    alertTimer?.cancel()
    sceneTimer = undefined
    alertTimer = undefined
  }

  // ---- session and turn ----------------------------------------------------

  on('session.start', async ($, e, next) => {
    ports = {
      fetch: (url, init) => $.http.fetch(url, init),
      readFile: async path => {
        try {
          return await $.fs.read(path)
        } catch {
          return undefined
        }
      },
      exists: path => $.fs.exists(path),
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      sleep: ms => $.clock.sleep(ms),
      home: () => $.env.get('HOME'),
      configHome: () => $.env.get('XDG_CONFIG_HOME'),
      toast: text => $.ui.toast(text),
      root: $.plugin.root,
    }
    clearTimers()
    scenes.reset()
    alerts.reset()
    holds.reset()
    pendingCalls = []
    await loadConfig()
    return next(e)
  })

  on('session.end', async (_$, e, next) => {
    await safe(async () => {
      if (ports === undefined) return
      clearTimers()
      alerts.reset()
      pendingCalls = []
      const idle = scenes.end(await port().now())
      const work: Promise<unknown>[] = [holds.closeAll()]
      if (idle !== undefined && config.enabled) work.push(client.sendScene(idle))
      // Bounded: session.end has a short wall-clock budget.
      await Promise.race([Promise.all(work), port().sleep(SESSION_END_BUDGET_MS)])
    })
    return next(e)
  })

  on('turn.start', async (_$, e, next) => {
    await loadConfig()
    await sceneChange(now => scenes.add('turn', config.scenes.turn, now))
    return next(e)
  })

  on('turn.complete', async (_$, e, next) => {
    await (e.agentId === undefined ? sceneChange(now => scenes.remove('turn', now)) : endAgent(e.agentId))
    return next(e)
  })

  // ---- subagents -----------------------------------------------------------

  on('agent.spawn', async (_$, e, next) => {
    const result = await next(e)
    const agentId = result.deny === undefined ? result.agentId : undefined
    if (agentId !== undefined) await startAgent(agentId, e.subagentType)
    return result
  })

  on('classic.SubagentStart', async (_$, e, next) => {
    await startAgent(e.agent_id, e.agent_type)
    return next(e)
  })

  on('classic.SubagentStop', async (_$, e, next) => {
    await endAgent(e.agent_id)
    return next(e)
  })

  // ---- the user is asked something ----------------------------------------

  on('classic.PermissionRequest', async (_$, e, next) => {
    // AskUserQuestion warns from its own tool.call; don't count it twice.
    const isWatched = e.tool_name !== 'AskUserQuestion' && matchesAny(config.alerts.warning.on, 'PermissionRequest')
    const call = isWatched && canHold() ? callForPrompt(e.tool_name, e.agent_id) : undefined
    if (typeof call === 'object') await openHold(call.id)
    else if (isWatched && call === undefined) await alertChange(now => alerts.warning(now))
    return next(e)
  })

  // ---- tool calls ----------------------------------------------------------

  on('tool.call', async (_$, e, next) => {
    const tool = String(e.tool)
    const activityId = `tool:${e.tool_use_id}`
    const isInherited = e.agentId !== undefined && config.scenes.inheritAgentScene
    const target = isInherited ? undefined : resolveActivity(config.scenes, 'tool', tool)

    if (target !== undefined) await sceneChange(now => scenes.add(activityId, target, now))
    if (matchesAny(config.alerts.warning.on, tool)) {
      await (canHold() ? openHold(e.tool_use_id) : alertChange(now => alerts.warning(now)))
    }
    const pending: PendingCall = { id: e.tool_use_id, tool, agentId: e.agentId }
    pendingCalls.push(pending)

    try {
      const result = await next(e)
      const failed = config.alerts.failed
      if (result.isError === true && matchesAny(failed.tools, tool)) {
        const record: unknown = result.result
        const isInterrupted =
          next.signal.aborted ||
          (isRecord(record) && record.interrupted === true) ||
          INTERRUPTED.test(result.text ?? '')
        if (!(failed.ignoreInterrupted && isInterrupted)) await alertChange(now => alerts.failed(now))
      }
      return result
    } finally {
      pendingCalls = pendingCalls.filter(call => call !== pending)
      await closeHold(e.tool_use_id)
      if (target !== undefined) await sceneChange(now => scenes.remove(activityId, now))
    }
  })
}
