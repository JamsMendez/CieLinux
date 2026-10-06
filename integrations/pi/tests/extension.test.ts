// Wiring tests: the extension driven through a fake `pi` (it collects the
// `pi.on` handlers), with the clock, the filesystem and the network faked.
import { test } from 'node:test'
import { cieLinuxScenes, type Io, type Timer } from '../extension.ts'
import { expect } from './expect.ts'

type Handler = (event: unknown, ctx: unknown) => unknown
type Sent = { url: string; body: unknown; headers: Record<string, string> }
type Reply = { status: number; text?: string }

const HOME = '/home/u'
const TOKEN_FILE = `${HOME}/.local/state/cielinux/http.token`
const USER_CONFIG = `${HOME}/.config/pi-cielinux/config.json`

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
}

const world = (options: { env?: Record<string, string>; files?: Record<string, string>; reply?: (url: string, body: unknown) => Reply } = {}) => {
  const handlers = new Map<string, Handler[]>()
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
  }
  const files: Record<string, string> = { [TOKEN_FILE]: 'tok\n', ...options.files }
  const sent: Sent[] = []
  const notices: string[] = []
  let time = 1_000_000
  let timers: Array<{ at: number; fn: () => void; isCancelled: boolean }> = []

  const io: Io = {
    fetch: async (url, init) => {
      const body: unknown = JSON.parse(init.body)
      sent.push({ url, body, headers: init.headers })
      return options.reply?.(url, body) ?? { status: 202, text: 'ok' }
    },
    readFile: async path => files[path],
    exists: async path => path in files,
    now: () => time,
    after: (ms, fn): Timer => {
      const timer = { at: time + ms, fn, isCancelled: false }
      timers.push(timer)
      return { cancel: () => void (timer.isCancelled = true) }
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))),
  }

  cieLinuxScenes(pi, { io, env: { HOME, ...options.env }, root: '/ext' })

  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => void notices.push(message) },
    signal: undefined as AbortSignal | undefined,
  }

  const emit = async (type: string, event: Record<string, unknown> = {}, context: unknown = ctx) => {
    for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, context)
    await flush()
  }

  const advance = async (ms: number) => {
    const end = time + ms
    for (;;) {
      timers = timers.filter(timer => !timer.isCancelled)
      const next = timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (next === undefined) break
      time = next.at
      timers = timers.filter(timer => timer !== next)
      next.fn()
      await flush()
    }
    time = end
    await flush()
  }

  const bodies = (suffix: string) => sent.filter(s => s.url.endsWith(suffix)).map(s => s.body)

  return { handlers, sent, notices, ctx, emit, advance, bodies, files }
}

test('a child process (GENTLE_PI_AGENTS_CHILD=1) registers nothing', () => {
  const { handlers } = world({ env: { GENTLE_PI_AGENTS_CHILD: '1' } })
  expect(handlers.size).toBe(0)
})

test('a turn shows raphael once settled, and idle after it settles', async () => {
  const w = world()
  await w.emit('session_start')
  await w.emit('agent_start')
  await w.advance(1000)
  expect(w.sent).toHaveLength(0)
  await w.advance(600)
  expect(w.bodies('/scene')).toEqual([{ scene: 'raphael' }])
  expect(w.sent[0]?.url).toBe('http://127.0.0.1:43811/v1/wallpaper/scene')
  expect(w.sent[0]?.headers).toEqual({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' })
  await w.emit('agent_end')
  await w.emit('agent_settled')
  await w.advance(8000)
  expect(w.bodies('/scene')).toEqual([{ scene: 'raphael' }, { scene: 'idle' }])
})

test('agent_end alone ends the turn after a short fallback', async () => {
  const w = world()
  await w.emit('session_start')
  await w.emit('agent_start')
  await w.advance(1500)
  await w.emit('agent_end')
  await w.advance(30_000)
  expect(w.bodies('/scene')).toEqual([{ scene: 'raphael' }, { scene: 'idle' }])
})

test('a burst of tool calls shorter than settleMs sends nothing', async () => {
  const w = world()
  await w.emit('session_start')
  await w.emit('tool_execution_start', { toolCallId: 'a', toolName: 'read', args: {} })
  await w.advance(500)
  await w.emit('tool_execution_end', { toolCallId: 'a', toolName: 'read', result: {}, isError: false })
  await w.advance(60_000)
  expect(w.sent).toHaveLength(0)
})

test('an edit outranks the turn baseline', async () => {
  const w = world()
  await w.emit('session_start')
  await w.emit('agent_start')
  await w.emit('tool_execution_start', { toolCallId: 'a', toolName: 'edit', args: {} })
  await w.advance(1500)
  expect(w.bodies('/scene')).toEqual([{ scene: 'processing' }])
})

test('repeated bash failures produce one failed alert', async () => {
  const w = world()
  await w.emit('session_start')
  for (const id of ['1', '2', '3']) {
    await w.emit('tool_execution_start', { toolCallId: id, toolName: 'bash', args: { command: 'false' } })
    await w.emit('tool_execution_end', {
      toolCallId: id,
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'Command exited with code 1' }] },
      isError: true,
    })
  }
  await w.advance(3000)
  expect(w.bodies('/v1/alerts')).toEqual([{ failed: 3, duration: 8 }])
})

test('an aborted bash call raises no alert', async () => {
  const w = world()
  await w.emit('session_start')
  const end = { toolName: 'bash', isError: true }
  await w.emit('tool_execution_end', { ...end, toolCallId: '1', result: { content: [{ type: 'text', text: 'Command aborted' }] } })
  const controller = new AbortController()
  controller.abort()
  await w.emit('tool_execution_end', { ...end, toolCallId: '2', result: { content: [] } }, { ...w.ctx, signal: controller.signal })
  await w.advance(10_000)
  expect(w.bodies('/v1/alerts')).toEqual([])
})

test('a failed read is not a watched failure', async () => {
  const w = world()
  await w.emit('session_start')
  await w.emit('tool_execution_end', { toolCallId: '1', toolName: 'read', result: {}, isError: true })
  await w.advance(10_000)
  expect(w.bodies('/v1/alerts')).toEqual([])
})

test('a blocking prompt sends a timed warning, at most once per cooldown', async () => {
  const w = world()
  await w.emit('session_start')
  await w.emit('ui_prompt_start', { reason: 'ui_prompt', kind: 'confirm', title: 'Allow?' })
  expect(w.bodies('/v1/alerts')).toEqual([{ warning: 1, duration: 5 }])
  await w.emit('ui_prompt_end', { reason: 'ui_prompt', kind: 'confirm', title: 'Allow?' })
  await w.advance(6000)
  await w.emit('ui_prompt_start', { reason: 'ui_prompt', kind: 'select' })
  await w.emit('ui_prompt_end', { reason: 'ui_prompt', kind: 'select' })
  expect(w.bodies('/v1/alerts')).toEqual([{ warning: 1, duration: 5 }])
})

test('with hold, a prompt holds a warning until it closes, then clears it by id', async () => {
  const w = world({
    files: { [USER_CONFIG]: JSON.stringify({ alerts: { warning: { hold: true } } }) },
    reply: url => (url.endsWith('/v1/alerts') ? { status: 202, text: 'ok id=7' } : { status: 202, text: 'ok' }),
  })
  await w.emit('session_start')
  await w.emit('ui_prompt_start', { reason: 'ui_prompt', kind: 'custom' })
  expect(w.bodies('/v1/alerts')).toEqual([{ warning: 1, duration: 0 }])
  expect(w.bodies('/clear')).toEqual([])
  await w.emit('ui_prompt_end', { reason: 'ui_prompt', kind: 'custom' })
  expect(w.bodies('/clear')).toEqual([{ id: 7 }])
})

test('with hold, a 400 falls back to the timed warning', async () => {
  const w = world({
    files: { [USER_CONFIG]: JSON.stringify({ alerts: { warning: { hold: true } } }) },
    reply: (_url, body) => ((body as { duration?: number }).duration === 0 ? { status: 400, text: 'bad' } : { status: 202, text: 'ok' }),
  })
  await w.emit('session_start')
  await w.emit('ui_prompt_start', { reason: 'ui_prompt', kind: 'confirm' })
  await w.emit('ui_prompt_end', { reason: 'ui_prompt', kind: 'confirm' })
  expect(w.bodies('/v1/alerts')).toEqual([{ warning: 1, duration: 0 }, { warning: 1, duration: 5 }])
  expect(w.bodies('/clear')).toEqual([])
})

test('session shutdown clears an open hold and sends idle at once', async () => {
  const w = world({
    files: { [USER_CONFIG]: JSON.stringify({ alerts: { warning: { hold: true } } }) },
    reply: url => (url.endsWith('/v1/alerts') ? { status: 202, text: 'ok id=3' } : { status: 202, text: 'ok' }),
  })
  await w.emit('session_start')
  await w.emit('agent_start')
  await w.advance(1500)
  await w.emit('ui_prompt_start', { reason: 'ui_prompt', kind: 'confirm' })
  await w.emit('session_shutdown', { reason: 'quit' })
  expect(w.bodies('/clear')).toEqual([{ id: 3 }])
  expect(w.bodies('/scene')).toEqual([{ scene: 'raphael' }, { scene: 'idle' }])
})

test('subagent_run is an agent activity keyed by the agent name for the call', async () => {
  const w = world()
  await w.emit('session_start')
  await w.emit('agent_start')
  await w.emit('tool_execution_start', { toolCallId: 's1', toolName: 'subagent_run', args: { agent: 'review-risk', task: 'x' } })
  await w.emit('tool_execution_start', { toolCallId: 'b1', toolName: 'bash', args: {} })
  await w.advance(1500)
  expect(w.bodies('/scene')).toEqual([{ scene: 'raphael' }])
  await w.emit('tool_execution_end', { toolCallId: 's1', toolName: 'subagent_run', result: {}, isError: false })
  await w.advance(4000)
  expect(w.bodies('/scene')).toEqual([{ scene: 'raphael' }, { scene: 'processing' }])
})

test('an explore subagent shows explorer', async () => {
  const w = world()
  await w.emit('session_start')
  await w.emit('tool_execution_start', { toolCallId: 's1', toolName: 'subagent_run', args: { agent: 'gentle-ai-explore' } })
  await w.advance(1500)
  expect(w.bodies('/scene')).toEqual([{ scene: 'explorer' }])
})

const subagentResult = (taskId: string, mode: string) => ({
  content: [{ type: 'text', text: 'started' }],
  details: { gentleAgents: { taskId, agent: 'gentle-ai-explore', status: 'running', mode, cwd: '/w' } },
})

const subagentDone = (taskId: string, customType = 'gentle-agents.result') => ({
  message: { role: 'custom', customType, content: 'done', display: true, details: { gentleAgents: { taskId } } },
})

test('a background subagent stays busy until its gentle-agents.result message', async () => {
  const w = world()
  await w.emit('session_start')
  await w.emit('tool_execution_start', { toolCallId: 's1', toolName: 'subagent_run', args: { agent: 'gentle-ai-explore' } })
  await w.advance(1500)
  await w.emit('tool_execution_end', { toolCallId: 's1', toolName: 'subagent_run', result: subagentResult('t1', 'background'), isError: false })
  await w.advance(60_000)
  expect(w.bodies('/scene')).toEqual([{ scene: 'explorer' }])
  await w.emit('message_end', subagentDone('t1'))
  await w.advance(10_000)
  expect(w.bodies('/scene')).toEqual([{ scene: 'explorer' }, { scene: 'idle' }])
})

test('an unrelated message does not end a background subagent', async () => {
  const w = world()
  await w.emit('session_start')
  await w.emit('tool_execution_start', { toolCallId: 's1', toolName: 'subagent_run', args: { agent: 'gentle-ai-explore' } })
  await w.advance(1500)
  await w.emit('tool_execution_end', { toolCallId: 's1', toolName: 'subagent_run', result: subagentResult('t1', 'background'), isError: false })
  await w.emit('message_end', subagentDone('t2'))
  await w.emit('message_end', subagentDone('t1', 'other.result'))
  await w.emit('message_end', { message: { role: 'assistant', content: [] } })
  await w.advance(60_000)
  expect(w.bodies('/scene')).toEqual([{ scene: 'explorer' }])
})

test('a task-mode subagent ends with its call', async () => {
  const w = world()
  await w.emit('session_start')
  await w.emit('tool_execution_start', { toolCallId: 's1', toolName: 'subagent_run', args: { agent: 'gentle-ai-explore' } })
  await w.advance(1500)
  await w.emit('tool_execution_end', { toolCallId: 's1', toolName: 'subagent_run', result: subagentResult('t1', 'task'), isError: false })
  await w.advance(10_000)
  expect(w.bodies('/scene')).toEqual([{ scene: 'explorer' }, { scene: 'idle' }])
})

test('a failed background subagent start ends with its call', async () => {
  const w = world()
  await w.emit('session_start')
  await w.emit('tool_execution_start', { toolCallId: 's1', toolName: 'subagent_run', args: { agent: 'gentle-ai-explore' } })
  await w.advance(1500)
  await w.emit('tool_execution_end', { toolCallId: 's1', toolName: 'subagent_run', result: subagentResult('t1', 'background'), isError: true })
  await w.advance(10_000)
  expect(w.bodies('/scene')).toEqual([{ scene: 'explorer' }, { scene: 'idle' }])
})

const subagentReadback = (taskId: string, status: string) => ({
  content: [{ type: 'text', text: status }],
  details: { gentleAgents: { taskId, agent: 'gentle-ai-explore', status, mode: 'background', cwd: '/w' } },
})

const startBackground = async (w: ReturnType<typeof world>, taskId: string) => {
  await w.emit('tool_execution_start', { toolCallId: 's1', toolName: 'subagent_run', args: { agent: 'gentle-ai-explore' } })
  await w.advance(1500)
  await w.emit('tool_execution_end', { toolCallId: 's1', toolName: 'subagent_run', result: subagentResult(taskId, 'background'), isError: false })
}

test('reading a finished background subagent result ends its activity', async () => {
  const w = world()
  await w.emit('session_start')
  await startBackground(w, 't1')
  await w.emit('tool_execution_start', { toolCallId: 'r1', toolName: 'subagent_result', args: { task_id: 't1' } })
  await w.emit('tool_execution_end', { toolCallId: 'r1', toolName: 'subagent_result', result: subagentReadback('t1', 'completed'), isError: false })
  await w.advance(10_000)
  expect(w.bodies('/scene')).toEqual([{ scene: 'explorer' }, { scene: 'idle' }])
})

test('a running status readback keeps a background subagent busy', async () => {
  const w = world()
  await w.emit('session_start')
  await startBackground(w, 't1')
  await w.emit('tool_execution_end', { toolCallId: 'r1', toolName: 'subagent_status', result: subagentReadback('t1', 'running'), isError: false })
  await w.advance(60_000)
  expect(w.bodies('/scene')).toEqual([{ scene: 'explorer' }])
})

test('a finished readback for an untracked task is harmless', async () => {
  const w = world()
  await w.emit('session_start')
  await startBackground(w, 't1')
  await w.emit('tool_execution_end', { toolCallId: 'r1', toolName: 'subagent_result', result: subagentReadback('t2', 'failed'), isError: false })
  await w.advance(60_000)
  expect(w.bodies('/scene')).toEqual([{ scene: 'explorer' }])
})

test('a background subagent_continue stays busy until its gentle-agents.result message', async () => {
  const w = world()
  await w.emit('session_start')
  await w.emit('tool_execution_start', { toolCallId: 'c1', toolName: 'subagent_continue', args: { task_id: 't1', prompt: 'more' } })
  await w.emit('tool_execution_end', { toolCallId: 'c1', toolName: 'subagent_continue', result: subagentResult('t2', 'background'), isError: false })
  await w.advance(60_000)
  expect(w.bodies('/scene')).toEqual([{ scene: 'explorer' }])
  await w.emit('message_end', subagentDone('t2'))
  await w.advance(10_000)
  expect(w.bodies('/scene')).toEqual([{ scene: 'explorer' }, { scene: 'idle' }])
})

test('a task-mode subagent_continue changes nothing', async () => {
  const w = world()
  await w.emit('session_start')
  await w.emit('tool_execution_start', { toolCallId: 'c1', toolName: 'subagent_continue', args: { task_id: 't1', prompt: 'more' } })
  await w.emit('tool_execution_end', { toolCallId: 'c1', toolName: 'subagent_continue', result: subagentResult('t2', 'task'), isError: false })
  await w.advance(60_000)
  expect(w.bodies('/scene')).toEqual([])
})

test('an invalid user config keeps the defaults and notifies once per session', async () => {
  const w = world({ files: { [USER_CONFIG]: '{ not json' } })
  await w.emit('session_start')
  await w.emit('agent_start')
  await w.emit('agent_start')
  expect(w.notices).toHaveLength(1)
  await w.advance(1500)
  expect(w.bodies('/scene')).toEqual([{ scene: 'raphael' }])
})

test('enabled: false sends nothing', async () => {
  const w = world({ files: { [USER_CONFIG]: JSON.stringify({ enabled: false }) } })
  await w.emit('session_start')
  await w.emit('agent_start')
  await w.emit('ui_prompt_start', { reason: 'ui_prompt', kind: 'confirm' })
  await w.advance(10_000)
  expect(w.sent).toHaveLength(0)
})

test('the user config is read from XDG_CONFIG_HOME when set', async () => {
  const w = world({
    env: { XDG_CONFIG_HOME: '/xdg' },
    files: { '/xdg/pi-cielinux/config.json': JSON.stringify({ scenes: { turn: { scene: 'explorer' } } }) },
  })
  await w.emit('session_start')
  await w.emit('agent_start')
  await w.advance(1500)
  expect(w.bodies('/scene')).toEqual([{ scene: 'explorer' }])
})

test('a failing network never throws into pi', async () => {
  const handlers = new Map<string, Handler[]>()
  const pi = { on: (event: string, handler: Handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]) }
  const io: Io = {
    fetch: async () => {
      throw new Error('down')
    },
    readFile: async () => {
      throw new Error('fs down')
    },
    exists: async () => {
      throw new Error('fs down')
    },
    now: () => 0,
    after: (_ms, fn) => {
      fn()
      return { cancel: () => {} }
    },
    sleep: async () => {},
  }
  cieLinuxScenes(pi, { io, env: { HOME }, root: '/ext' })
  for (const [type, list] of handlers) {
    for (const handler of list) await handler({ type, toolCallId: 'x', toolName: 'bash', isError: true, kind: 'confirm' }, {})
  }
  await flush()
})
