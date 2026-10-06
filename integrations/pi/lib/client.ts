// The CieLinux HTTP client: POSTs JSON with the bearer token, never throws,
// Ported from integrations/claude-code/hooks/client.ts; keep the two in sync.
// retries once on 401 with the token re-read from `tokenFile` (also when an
// inline token was rejected: CieLinux may have regenerated it), and backs off after a connection failure so
// an absent CieLinux is not asked again on every event. Held warnings read the
// reply text too: `ok id=<n>` names the alert to clear later.

import type { ServerConfig } from './config.ts'

export type ClientIo = {
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ status: number; text?: string }>
  /** The file's text, or undefined when it cannot be read. */
  readFile: (path: string) => Promise<string | undefined>
  now: () => Promise<number>
  home: () => Promise<string | undefined>
}

export type SendOutcome = 'sent' | 'rejected' | 'unauthorized' | 'unreachable' | 'backing-off' | 'no-token'

/** What a held-warning request got: an id to clear, none (busy), a 400, or nothing usable. */
export type HoldReply = { kind: 'held'; id: number } | { kind: 'busy' } | { kind: 'unsupported' } | { kind: 'failed' }

type Reply = { outcome: SendOutcome; status?: number; text?: string }

export const BACKOFF_MS = 30_000
/** `{"warning":1,"duration":0}`: a warning CieLinux holds until it is cleared. */
export const HOLD_BODY = { warning: 1, duration: 0 }
const HELD_ID = /^ok id=(\d+)/

export const expandHome = (path: string, home: string | undefined): string =>
  home !== undefined && (path === '~' || path.startsWith('~/')) ? home + path.slice(1) : path

export class CieClient {
  private cachedToken: string | undefined
  /** The inline token was answered 401; use the token file until it changes. */
  private isInlineRejected = false
  private backoffUntil = Number.NEGATIVE_INFINITY

  private readonly io: ClientIo
  private server: ServerConfig

  constructor(io: ClientIo, server: ServerConfig) {
    this.io = io
    this.server = server
  }

  configure(server: ServerConfig): void {
    if (server.token !== this.server.token) this.isInlineRejected = false
    if (server.token !== this.server.token || server.tokenFile !== this.server.tokenFile) {
      this.cachedToken = undefined
    }
    this.server = server
  }

  sendScene(scene: string): Promise<SendOutcome> {
    return this.post(this.server.sceneRoute, { scene })
  }

  sendAlert(body: object): Promise<SendOutcome> {
    return this.post(this.server.alertsRoute, body)
  }

  /** Opens a held warning. Never rejects. */
  async sendHold(): Promise<HoldReply> {
    const reply = await this.request(this.server.alertsRoute, HOLD_BODY)
    if (reply.status === 400) return { kind: 'unsupported' }
    if (reply.outcome !== 'sent') return { kind: 'failed' }
    const match = HELD_ID.exec(reply.text?.trim() ?? '')
    return match === null ? { kind: 'busy' } : { kind: 'held', id: Number(match[1]) }
  }

  /** Clears alert `id` (held or timed) on the route next to the alerts route. */
  clearAlert(id: number): Promise<SendOutcome> {
    return this.post(`${this.server.alertsRoute}/clear`, { id })
  }

  /** Never rejects. */
  async post(route: string, body: object): Promise<SendOutcome> {
    return (await this.request(route, body)).outcome
  }

  private async request(route: string, body: object): Promise<Reply> {
    try {
      if ((await this.io.now()) < this.backoffUntil) return { outcome: 'backing-off' }
      const first = await this.attempt(route, body, false)
      if (first.outcome !== 'unauthorized') return first
      if (this.usesInline()) this.isInlineRejected = true
      return await this.attempt(route, body, true)
    } catch {
      return { outcome: 'unreachable' }
    }
  }

  private async attempt(route: string, body: object, isRetry: boolean): Promise<Reply> {
    const token = await this.token(isRetry)
    if (token === undefined) return { outcome: 'no-token' }
    let response: { status: number; text?: string }
    try {
      response = await this.io.fetch(this.server.baseUrl + route, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      this.backoffUntil = (await this.io.now()) + BACKOFF_MS
      return { outcome: 'unreachable' }
    }
    const { status, text } = response
    if (status === 401) return { outcome: 'unauthorized', status, text }
    return { outcome: status >= 200 && status < 300 ? 'sent' : 'rejected', status, text }
  }

  private usesInline(): boolean {
    return this.server.token !== '' && !this.isInlineRejected
  }

  private async token(isFresh: boolean): Promise<string | undefined> {
    if (this.usesInline()) return this.server.token
    if (!isFresh && this.cachedToken !== undefined) return this.cachedToken
    const path = expandHome(this.server.tokenFile, await this.io.home())
    const text = (await this.io.readFile(path))?.trim()
    this.cachedToken = text === undefined || text === '' ? undefined : text
    return this.cachedToken
  }
}
