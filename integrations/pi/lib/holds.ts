// Held warnings: one CieLinux warning per pending question, kept up until that
// Ported from integrations/claude-code/hooks/holds.ts; keep the two in sync.
// question resolves. Each hold is keyed by the prompt it waits on. A hold
// may close before its reply arrives; the clear then waits for the id. Holds
// bypass the alert batcher: CieLinux lets a failed alert preempt a held one,
// so a hold never makes the batcher wait. Pure bookkeeping, I/O injected.

import type { HoldReply } from './client.ts'

export type HoldIo = {
  /** Sends `{"warning":1,"duration":0}`; resolves with what came back. */
  open: () => Promise<HoldReply>
  /** Sends `POST /v1/alerts/clear {"id": id}`. */
  clear: (id: number) => Promise<unknown>
}

type Hold = { reply: Promise<HoldReply> }

export class HoldTracker {
  private readonly holds = new Map<string, Hold>()
  /** CieLinux answered 400 to a hold: it predates held warnings. */
  isUnsupported = false

  private readonly io: HoldIo

  constructor(io: HoldIo) {
    this.io = io
  }

  has(key: string): boolean {
    return this.holds.has(key)
  }

  /** Opens a hold for `key`, or returns undefined when one is already open for it. */
  open(key: string): Promise<HoldReply> | undefined {
    if (this.holds.has(key)) return undefined
    const hold = { reply: this.request() }
    this.holds.set(key, hold)
    return hold.reply
  }

  /** Clears the hold for `key` once its id is known; no id, nothing to clear. */
  async close(key: string): Promise<void> {
    const hold = this.holds.get(key)
    if (hold === undefined) return
    this.holds.delete(key)
    const reply = await hold.reply
    if (reply.kind !== 'held') return
    await this.io.clear(reply.id)
    await this.reopenWaiting()
  }

  /** Clears every open hold (session end); waiting ones are not reopened. */
  async closeAll(): Promise<void> {
    const open = [...this.holds.values()]
    this.holds.clear()
    await Promise.all(
      open.map(async hold => {
        const reply = await hold.reply
        if (reply.kind === 'held') await this.io.clear(reply.id)
      }),
    )
  }

  /** Forgets every hold without clearing it, and tries holds again (new session). */
  reset(): void {
    this.holds.clear()
    this.isUnsupported = false
  }

  private request(): Promise<HoldReply> {
    return this.io.open().then(
      reply => {
        if (reply.kind === 'unsupported') this.isUnsupported = true
        return reply
      },
      (): HoldReply => ({ kind: 'failed' }),
    )
  }

  /**
   * CieLinux answers a hold made while another warning is held without an id
   * (busy): once that one is cleared, the oldest such question gets its own
   * hold, unless another hold still shows.
   */
  private async reopenWaiting(): Promise<void> {
    const open = [...this.holds.entries()]
    const replies = await Promise.all(open.map(([, hold]) => hold.reply))
    if (replies.some(reply => reply.kind === 'held')) return
    const index = replies.findIndex(reply => reply.kind === 'busy')
    const waiting = open[index]
    if (waiting === undefined) return
    const [key, hold] = waiting
    // Closed or replaced while the replies were awaited: leave it alone.
    if (this.holds.get(key) !== hold) return
    this.holds.set(key, { reply: this.request() })
  }
}
