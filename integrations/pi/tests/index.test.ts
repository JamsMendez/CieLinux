// The real entry point: registers handlers in the parent, nothing in a child,
// and starts no timer or request from the factory.
import { test } from 'node:test'
import factory from '../index.ts'
import { expect } from './expect.ts'

const collect = () => {
  const events: string[] = []
  return { events, pi: { on: (event: string) => void events.push(event) } }
}

test('the factory registers the observed events', () => {
  const previous = process.env.GENTLE_PI_AGENTS_CHILD
  delete process.env.GENTLE_PI_AGENTS_CHILD
  try {
    const { events, pi } = collect()
    factory(pi)
    expect([...events].sort()).toEqual(
      [
        'agent_end',
        'agent_settled',
        'agent_start',
        'message_end',
        'session_shutdown',
        'session_start',
        'tool_execution_end',
        'tool_execution_start',
        'ui_prompt_end',
        'ui_prompt_start',
      ].sort(),
    )
  } finally {
    if (previous !== undefined) process.env.GENTLE_PI_AGENTS_CHILD = previous
  }
})

test('the factory registers nothing in a gentle-pi child process', () => {
  const previous = process.env.GENTLE_PI_AGENTS_CHILD
  process.env.GENTLE_PI_AGENTS_CHILD = '1'
  try {
    const { events, pi } = collect()
    factory(pi)
    expect(events).toHaveLength(0)
  } finally {
    if (previous === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD
    else process.env.GENTLE_PI_AGENTS_CHILD = previous
  }
})
