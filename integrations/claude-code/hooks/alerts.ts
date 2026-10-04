// The alert batcher: turns warnings and failures into as few CieLinux alert
// requests as possible. CieLinux shows one alert at a time and silently drops
// any request that arrives while one is showing, so the batcher never sends
// while it believes an alert is on screen; it keeps counting and sends one
// combined request once the screen is free. Pure and time-injected.

import type { AlertsConfig } from './config'

export type AlertBody = { failed?: number; warning?: number; duration: number }

export type AlertStep = {
  send?: AlertBody
  wakeAt?: number
}

/** CieLinux limits: each kind 1..16 tiles, at most 16 together. */
export const MAX_TILES = 16
/** Slack after an alert's duration before the next one is sent. */
export const BUSY_SLACK_MS = 500

export class AlertBatcher {
  private pendingFailed = 0
  private failedDueAt: number | undefined
  private pendingWarning = false
  private lastWarningAt = Number.NEGATIVE_INFINITY
  private busyUntil = Number.NEGATIVE_INFINITY

  constructor(private config: AlertsConfig) {}

  configure(config: AlertsConfig): void {
    this.config = config
  }

  /** The user is being asked something: warn now, unless within the cooldown. */
  warning(now: number): AlertStep {
    const { enabled, cooldownMs } = this.config.warning
    if (!enabled || now - this.lastWarningAt < cooldownMs) return this.update(now)
    this.lastWarningAt = now
    this.pendingWarning = true
    return this.update(now)
  }

  /** A watched tool failed: count it into the current batch window. */
  failed(now: number): AlertStep {
    if (!this.config.failed.enabled) return this.update(now)
    this.pendingFailed++
    this.failedDueAt ??= now + this.config.failed.batchMs
    return this.update(now)
  }

  update(now: number): AlertStep {
    const hasPending = this.pendingWarning || this.pendingFailed > 0
    if (!hasPending) return {}
    if (now < this.busyUntil) return { wakeAt: this.busyUntil }

    const isFailedDue = this.pendingFailed > 0 && this.failedDueAt !== undefined && now >= this.failedDueAt
    if (!this.pendingWarning && !isFailedDue) return { wakeAt: this.failedDueAt }

    const body = this.buildBody()
    this.busyUntil = now + body.duration * 1000 + BUSY_SLACK_MS
    this.pendingFailed = 0
    this.failedDueAt = undefined
    this.pendingWarning = false
    return { send: body }
  }

  reset(): void {
    this.pendingFailed = 0
    this.failedDueAt = undefined
    this.pendingWarning = false
    this.lastWarningAt = Number.NEGATIVE_INFINITY
    this.busyUntil = Number.NEGATIVE_INFINITY
  }

  private buildBody(): AlertBody {
    const warningTiles = this.pendingWarning ? 1 : 0
    const failedTiles = Math.min(this.pendingFailed, MAX_TILES - warningTiles)
    const durations: number[] = []
    const body: AlertBody = { duration: 0 }
    if (failedTiles > 0) {
      body.failed = failedTiles
      durations.push(this.config.failed.duration)
    }
    if (warningTiles > 0) {
      body.warning = warningTiles
      durations.push(this.config.warning.duration)
    }
    body.duration = clampDuration(Math.max(...durations))
    return body
  }
}

/** CieLinux accepts whole seconds 1..60. */
const clampDuration = (seconds: number): number => Math.min(60, Math.max(1, Math.round(seconds)))
