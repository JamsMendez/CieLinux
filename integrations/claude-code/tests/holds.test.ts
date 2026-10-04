import { describe, expect, test } from 'claude-code/testing'
import type { HoldReply } from '../hooks/client'
import { HoldTracker } from '../hooks/holds'

/** Replies are handed out in order; each open waits until `release` resolves it. */
const fakeIo = (replies: HoldReply[]) => {
  const cleared: number[] = []
  const waiting: Array<() => void> = []
  let opens = 0
  const io = {
    open: () =>
      new Promise<HoldReply>(resolve => {
        opens++
        const reply: HoldReply = replies.shift() ?? { kind: 'failed' }
        waiting.push(() => resolve(reply))
      }),
    clear: async (id: number) => {
      cleared.push(id)
    },
  }
  const release = async () => {
    while (waiting.length > 0) waiting.shift()?.()
    await Promise.resolve()
  }
  return { io, cleared, release, opens: () => opens }
}

describe('hold tracker', () => {
  test('one hold per key, cleared by its id once known', async () => {
    const fake = fakeIo([{ kind: 'held', id: 3 }])
    const holds = new HoldTracker(fake.io)
    expect(holds.open('a')).not.toBe(undefined)
    expect(holds.open('a')).toBe(undefined)
    const closing = holds.close('a')
    expect(fake.cleared).toEqual([])
    await fake.release()
    await closing
    expect(fake.cleared).toEqual([3])
    expect(fake.opens()).toBe(1)
  })

  test('a busy question gets its own hold once the shown one is cleared', async () => {
    const fake = fakeIo([{ kind: 'held', id: 1 }, { kind: 'busy' }, { kind: 'held', id: 2 }])
    const holds = new HoldTracker(fake.io)
    holds.open('a')
    holds.open('b')
    await fake.release()
    const closingA = holds.close('a')
    await fake.release()
    await closingA
    expect(fake.opens()).toBe(3)
    const closingB = holds.close('b')
    await fake.release()
    await closingB
    expect(fake.cleared).toEqual([1, 2])
  })

  test('a 400 marks holds unsupported until reset', async () => {
    const fake = fakeIo([{ kind: 'unsupported' }])
    const holds = new HoldTracker(fake.io)
    const reply = holds.open('a')
    await fake.release()
    expect(await reply).toEqual({ kind: 'unsupported' })
    expect(holds.isUnsupported).toBe(true)
    await holds.close('a')
    expect(fake.cleared).toEqual([])
    holds.reset()
    expect(holds.isUnsupported).toBe(false)
  })

  test('closeAll clears every held id and reopens nothing', async () => {
    const fake = fakeIo([{ kind: 'held', id: 1 }, { kind: 'held', id: 2 }, { kind: 'busy' }])
    const holds = new HoldTracker(fake.io)
    holds.open('a')
    holds.open('b')
    holds.open('c')
    const closing = holds.closeAll()
    await fake.release()
    await closing
    expect(fake.cleared).toEqual([1, 2])
    expect(fake.opens()).toBe(3)
    expect(holds.has('a')).toBe(false)
  })
})
