// Hook-level tests: the plugin loaded by the engine, with the clock, the
// environment, the filesystem and the network mocked beneath it.
import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

type Sent = { url: string; body: unknown; headers: Record<string, string> }

const world = (on: On) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/u' })
  const sent: Sent[] = []
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: 'tok\n' }))
  on('http.fetch', (_$, e) => {
    sent.push({ url: e.url, body: JSON.parse(e.init?.body ?? 'null'), headers: e.init?.headers ?? {} })
    return { value: { status: 202, ok: true, headers: {}, text: 'ok' } }
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.end', () => ({ sessionId: 's' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.PermissionRequest', () => ({}))
  return { clock, sent }
}

const startSession = async ($: Engine) => {
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
}

test('a turn shows raphael once settled, and idle after it ends', async ($, on) => {
  const { clock, sent } = world(on)
  await startSession($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(1000)
  expect(sent).toHaveLength(0)
  await clock.advance(600)
  expect(sent.map(s => s.body)).toEqual([{ scene: 'raphael' }])
  expect(sent[0]?.headers).toEqual({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(8000)
  expect(sent.map(s => s.body)).toEqual([{ scene: 'raphael' }, { scene: 'idle' }])
})

test('repeated Bash failures produce one failed alert, and the result is unchanged', async ($, on) => {
  const { clock, sent } = world(on)
  on('tool.call', () => ({ isError: true as const, result: 'Exit code 1', text: 'Exit code 1' }))
  await startSession($)
  for (let i = 0; i < 3; i++) {
    const result = await $.tool.call({ tool: 'Bash', command: 'false' })
    expect(result.isError).toBe(true)
    expect(result.text).toBe('Exit code 1')
  }
  await clock.advance(3000)
  const alerts = sent.filter(s => s.url.endsWith('/v1/alerts'))
  expect(alerts.map(s => s.body)).toEqual([{ failed: 3, duration: 8 }])
})

test('an interrupted Bash call raises no alert', async ($, on) => {
  const { clock, sent } = world(on)
  on('tool.call', () => ({
    isError: true as const,
    result: '[Request interrupted by user for tool use]',
    text: '[Request interrupted by user for tool use]',
  }))
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: 'sleep 100' })
  await clock.advance(5000)
  expect(sent.filter(s => s.url.endsWith('/v1/alerts'))).toHaveLength(0)
})

test('a question sends one warning with duration 5', async ($, on) => {
  const { clock, sent } = world(on)
  on('tool.call', () => ({ result: { answers: {} }, text: 'answered' }))
  await startSession($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: {} } as never)
  await clock.settle()
  const alerts = sent.filter(s => s.url.endsWith('/v1/alerts'))
  expect(alerts.map(s => s.body)).toEqual([{ warning: 1, duration: 5 }])
})

test('a subagent outranks the turn, and its own tool calls are inherited', async ($, on) => {
  const { clock, sent } = world(on)
  on('classic.SubagentStart', () => ({}))
  on('classic.SubagentStop', () => ({}))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  await startSession($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)
  await clock.advance(1500)
  expect(sent.map(s => s.body)).toEqual([{ scene: 'explorer' }])
  await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'Explore' } as never)
  await clock.advance(4000)
  expect(sent.map(s => s.body)).toEqual([{ scene: 'explorer' }, { scene: 'raphael' }])
})

test('a user config under XDG_CONFIG_HOME overrides the defaults', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, { HOME: '/home/u', XDG_CONFIG_HOME: '/cfg' })
  const sent: unknown[] = []
  on('fs.exists', (_$, e) => ({ value: e.path === '/cfg/claude-cielinux/config.json' }))
  on('fs.read', (_$, e) => ({
    value:
      e.path === '/cfg/claude-cielinux/config.json'
        ? JSON.stringify({ server: { token: 'inline' }, scenes: { turn: { scene: 'processing', priority: 5 } } })
        : 'file-token',
  }))
  on('http.fetch', (_$, e) => {
    sent.push([e.init?.headers?.Authorization, JSON.parse(e.init?.body ?? 'null')])
    return { value: { status: 202, ok: true, headers: {}, text: 'ok' } }
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await startSession($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(1500)
  expect(sent).toEqual([['Bearer inline', { scene: 'processing' }]])
})

// ---- held warnings ---------------------------------------------------------

type HoldReply = { status: number; text: string } | (() => { status: number; text: string })

/** A world whose user config turns `alerts.warning.hold` on. */
const holdWorld = (on: On, reply: HoldReply = { status: 202, text: 'ok id=7' }) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/u', XDG_CONFIG_HOME: '/cfg' })
  const sent: Sent[] = []
  const userConfig = '/cfg/claude-cielinux/config.json'
  on('fs.exists', (_$, e) => ({ value: e.path === userConfig }))
  on('fs.read', (_$, e) => ({
    value: e.path === userConfig ? JSON.stringify({ alerts: { warning: { hold: true } } }) : 'tok\n',
  }))
  on('http.fetch', (_$, e) => {
    const body: unknown = JSON.parse(e.init?.body ?? 'null')
    sent.push({ url: e.url, body, headers: e.init?.headers ?? {} })
    const isHold = e.url.endsWith('/v1/alerts') && (body as { duration?: number }).duration === 0
    const answer = isHold ? (typeof reply === 'function' ? reply() : reply) : { status: 202, text: 'ok id=99' }
    return { value: { ...answer, ok: answer.status < 300, headers: {} } }
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.end', () => ({ sessionId: 's' }))
  on('classic.PermissionRequest', () => ({}))
  const alerts = () => sent.filter(s => s.url.endsWith('/v1/alerts')).map(s => s.body)
  const clears = () => sent.filter(s => s.url.endsWith('/v1/alerts/clear')).map(s => s.body)
  return { clock, sent, alerts, clears }
}

test('hold off by default: the bundled config keeps the timed warning', async ($, on) => {
  const { clock, sent } = world(on)
  on('tool.call', () => ({ result: { answers: {} }, text: 'answered' }))
  await startSession($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.settle()
  expect(sent.filter(s => s.url.includes('/clear'))).toHaveLength(0)
  expect(sent.filter(s => s.url.endsWith('/v1/alerts')).map(s => s.body)).toEqual([{ warning: 1, duration: 5 }])
})

test('a question opens a held warning and clears it by id once answered', async ($, on) => {
  const { clock, alerts, clears } = holdWorld(on)
  on('tool.call', async () => {
    await clock.sleep(30_000)
    return { result: { answers: {} }, text: 'answered' }
  })
  await startSession($)
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.settle()
  expect(alerts()).toEqual([{ warning: 1, duration: 0 }])
  expect(clears()).toEqual([])
  await clock.advance(30_000)
  await call
  await clock.settle()
  expect(clears()).toEqual([{ id: 7 }])
  expect(alerts()).toEqual([{ warning: 1, duration: 0 }])
})

test('a hold closed before its reply arrives is still cleared', async ($, on) => {
  const { clock, alerts, clears } = holdWorld(on)
  on('tool.call', () => ({ result: { answers: {} }, text: 'answered' }))
  await startSession($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.settle()
  expect(alerts()).toEqual([{ warning: 1, duration: 0 }])
  expect(clears()).toEqual([{ id: 7 }])
})

test('holds bypass the warning cooldown', async ($, on) => {
  const { clock, alerts, clears } = holdWorld(on)
  on('tool.call', () => ({ result: { answers: {} }, text: 'answered' }))
  await startSession($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.settle()
  expect(alerts()).toEqual([
    { warning: 1, duration: 0 },
    { warning: 1, duration: 0 },
  ])
  expect(clears()).toEqual([{ id: 7 }, { id: 7 }])
})

test('a busy reply without an id has nothing to clear', async ($, on) => {
  const { clock, alerts, clears } = holdWorld(on, { status: 202, text: 'ok' })
  on('tool.call', () => ({ result: { answers: {} }, text: 'answered' }))
  await startSession($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.settle()
  expect(alerts()).toEqual([{ warning: 1, duration: 0 }])
  expect(clears()).toEqual([])
})

test('a 400 to the hold falls back to the timed warning for the rest of the session', async ($, on) => {
  const { clock, alerts, clears } = holdWorld(on, { status: 400, text: "error: 'duration' must be 1-60" })
  on('tool.call', () => ({ result: { answers: {} }, text: 'answered' }))
  await startSession($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.settle()
  expect(alerts()).toEqual([
    { warning: 1, duration: 0 },
    { warning: 1, duration: 5 },
  ])
  await clock.advance(20_000)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.settle()
  expect(alerts()).toEqual([
    { warning: 1, duration: 0 },
    { warning: 1, duration: 5 },
    { warning: 1, duration: 5 },
  ])
  expect(clears()).toEqual([])
})

test('a permission prompt holds for its enclosing tool call, once', async ($, on) => {
  const { clock, alerts, clears } = holdWorld(on)
  on('tool.call', async () => {
    await clock.sleep(20_000)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
  })
  await startSession($)
  const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as never)
  await clock.settle()
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
  await clock.settle()
  expect(alerts()).toEqual([{ warning: 1, duration: 0 }])
  await clock.advance(20_000)
  await call
  await clock.settle()
  expect(clears()).toEqual([{ id: 7 }])
})

test('a permission prompt with no matching tool call gets the timed warning', async ($, on) => {
  const { clock, alerts, clears } = holdWorld(on)
  await startSession($)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
  await clock.settle()
  expect(alerts()).toEqual([{ warning: 1, duration: 5 }])
  expect(clears()).toEqual([])
})

test('failures are not held back by a held warning', async ($, on) => {
  const { clock, alerts } = holdWorld(on)
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Bash') return { isError: true as const, result: 'Exit code 1', text: 'Exit code 1' }
    await clock.sleep(60_000)
    return { result: { answers: {} }, text: 'answered' }
  })
  await startSession($)
  const question = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'false' } as never)
  await clock.advance(3000)
  expect(alerts()).toEqual([
    { warning: 1, duration: 0 },
    { failed: 1, duration: 8 },
  ])
  await clock.advance(60_000)
  await question
})

test('session end clears an outstanding hold', async ($, on) => {
  const { clock, clears } = holdWorld(on)
  on('tool.call', async () => {
    await clock.sleep(600_000)
    return { result: { answers: {} }, text: 'answered' }
  })
  await startSession($)
  void $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.settle()
  await $.session.end({ reason: 'other' } as never)
  expect(clears()).toEqual([{ id: 7 }])
})
