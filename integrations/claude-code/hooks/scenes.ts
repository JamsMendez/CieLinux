// The scene engine: which scene the wallpaper should show, and when to say so.
// Pure and time-injected: every call takes `now` (ms) and answers what to send,
// if anything, and when the caller should call `update` again.

import type { SceneTarget, TimingConfig } from './config'

export type Step = {
  /** A scene to send now; already recorded as committed. */
  send?: string
  /** When to call `update` next (absolute ms), if a change is pending. */
  wakeAt?: number
}

type Activity = SceneTarget & { startedAt: number; order: number }

/** Activities older than this are dropped (a subagent that never reported its end). */
export const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000

export class SceneEngine {
  private readonly activities = new Map<string, Activity>()
  private order = 0
  private desired: string | undefined
  private desiredSince = 0
  private committed: string | undefined
  private committedAt = Number.NEGATIVE_INFINITY

  constructor(
    private timing: TimingConfig,
    private idleScene: string,
    private readonly maxAgeMs: number = DEFAULT_MAX_AGE_MS,
  ) {}

  configure(timing: TimingConfig, idleScene: string): void {
    this.timing = timing
    this.idleScene = idleScene
  }

  size(): number {
    return this.activities.size
  }

  /** Starts an activity; a second add for the same id changes nothing. */
  add(id: string, target: SceneTarget, now: number): Step {
    if (!this.activities.has(id)) {
      this.activities.set(id, { ...target, startedAt: now, order: this.order++ })
    }
    return this.update(now)
  }

  remove(id: string, now: number): Step {
    this.activities.delete(id)
    return this.update(now)
  }

  /** Recomputes the desired scene and commits it when settled and held long enough. */
  update(now: number): Step {
    this.prune(now)
    const desired = this.computeDesired()
    if (desired !== this.desired) {
      this.desired = desired
      this.desiredSince = now
    }
    if (desired === undefined || desired === this.committed) return this.nextWake(now)

    const isIdle = this.activities.size === 0
    const settle = isIdle ? this.timing.idleDelayMs : this.timing.settleMs
    const dueAt = Math.max(this.desiredSince + settle, this.committedAt + this.timing.minHoldMs)
    if (now < dueAt) return { wakeAt: dueAt }

    this.committed = desired
    this.committedAt = now
    return { send: desired, ...this.nextWake(now) }
  }

  /** Session end: idle at once (no settle), when another scene was committed. */
  end(now: number): string | undefined {
    const shouldSend = this.committed !== undefined && this.committed !== this.idleScene
    this.reset()
    if (!shouldSend) return undefined
    this.committed = this.idleScene
    this.committedAt = now
    return this.idleScene
  }

  reset(): void {
    this.activities.clear()
    this.desired = undefined
    this.desiredSince = 0
    this.committed = undefined
    this.committedAt = Number.NEGATIVE_INFINITY
  }

  private computeDesired(): string | undefined {
    let best: Activity | undefined
    for (const activity of this.activities.values()) {
      const isBetter =
        best === undefined ||
        activity.priority > best.priority ||
        (activity.priority === best.priority && activity.order > best.order)
      if (isBetter) best = activity
    }
    if (best !== undefined) return best.scene
    // Never go idle before this session sent anything: leave the wallpaper alone.
    return this.committed === undefined ? undefined : this.idleScene
  }

  /** Nothing is pending; wake only to expire the oldest activity. */
  private nextWake(_now: number): Step {
    let oldest = Number.POSITIVE_INFINITY
    for (const activity of this.activities.values()) oldest = Math.min(oldest, activity.startedAt)
    return oldest === Number.POSITIVE_INFINITY ? {} : { wakeAt: oldest + this.maxAgeMs }
  }

  private prune(now: number): void {
    for (const [id, activity] of this.activities) {
      if (now - activity.startedAt >= this.maxAgeMs) this.activities.delete(id)
    }
  }
}
