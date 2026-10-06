// A minimal `expect` over node:assert, so the engine tests read like their
// Claude Code plugin originals (integrations/claude-code/tests).
import assert from 'node:assert/strict'

export const expect = (actual: unknown) => ({
  toBe: (expected: unknown) => assert.equal(actual, expected),
  toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
  toHaveLength: (length: number) => assert.equal((actual as { length: number }).length, length),
  not: {
    toBe: (expected: unknown) => assert.notEqual(actual, expected),
  },
})
