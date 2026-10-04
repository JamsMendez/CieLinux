import { describe, expect, test } from 'claude-code/testing'
import { BACKOFF_MS, CieClient, expandHome, type ClientIo } from '../hooks/client'
import { DEFAULT_CONFIG } from '../hooks/config'

type Request = { url: string; headers: Record<string, string>; body: string }

const fakeIo = (statuses: Array<number | 'down'>, tokens: string[] = ['file-token'], texts: string[] = []) => {
  const requests: Request[] = []
  const reads: string[] = []
  let time = 0
  const io: ClientIo = {
    fetch: async (url, init) => {
      const status = statuses.shift() ?? 202
      if (status === 'down') throw new Error('connection refused')
      requests.push({ url, headers: init.headers, body: init.body })
      return { status, text: texts.shift() ?? 'ok' }
    },
    readFile: async path => {
      reads.push(path)
      return tokens.length > 1 ? tokens.shift() : tokens[0]
    },
    now: async () => time,
    home: async () => '/home/u',
  }
  return { io, requests, reads, advance: (ms: number) => (time += ms) }
}

describe('client', () => {
  test('posts JSON with the bearer token from the token file and no Origin', async () => {
    const fake = fakeIo([202], ['  file-token\n'])
    const client = new CieClient(fake.io, DEFAULT_CONFIG.server)
    expect(await client.sendScene('idle')).toBe('sent')
    expect(fake.reads).toEqual(['/home/u/.local/state/cielinux/http.token'])
    expect(fake.requests[0]).toEqual({
      url: 'http://127.0.0.1:43811/v1/wallpaper/scene',
      headers: { Authorization: 'Bearer file-token', 'Content-Type': 'application/json' },
      body: '{"scene":"idle"}',
    })
  })

  test('caches the token between requests', async () => {
    const fake = fakeIo([202, 202])
    const client = new CieClient(fake.io, DEFAULT_CONFIG.server)
    await client.sendScene('idle')
    await client.sendAlert({ warning: 1, duration: 5 })
    expect(fake.reads).toHaveLength(1)
    expect(fake.requests[1]?.url).toBe('http://127.0.0.1:43811/v1/alerts')
  })

  test('re-reads the token file once on 401', async () => {
    const fake = fakeIo([401, 202], ['old', 'new'])
    const client = new CieClient(fake.io, DEFAULT_CONFIG.server)
    expect(await client.sendScene('idle')).toBe('sent')
    expect(fake.requests.map(r => r.headers.Authorization)).toEqual(['Bearer old', 'Bearer new'])
  })

  test('an inline token wins, and a 401 on it falls back to the token file', async () => {
    const fake = fakeIo([202, 401, 202, 202])
    const client = new CieClient(fake.io, { ...DEFAULT_CONFIG.server, token: 'inline' })
    await client.sendScene('idle')
    await client.sendScene('raphael')
    await client.sendScene('explorer')
    expect(fake.requests.map(r => r.headers.Authorization)).toEqual([
      'Bearer inline',
      'Bearer inline',
      'Bearer file-token',
      'Bearer file-token',
    ])
  })

  test('backs off after a connection failure', async () => {
    const fake = fakeIo(['down', 202])
    const client = new CieClient(fake.io, DEFAULT_CONFIG.server)
    expect(await client.sendScene('idle')).toBe('unreachable')
    expect(await client.sendScene('idle')).toBe('backing-off')
    fake.advance(BACKOFF_MS)
    expect(await client.sendScene('idle')).toBe('sent')
  })

  test('a missing token sends nothing', async () => {
    const io: ClientIo = { ...fakeIo([]).io, readFile: async () => undefined }
    expect(await new CieClient(io, DEFAULT_CONFIG.server).sendScene('idle')).toBe('no-token')
  })

  test('a hold reply carries its id; a reply without one is busy', async () => {
    const fake = fakeIo([202, 202], ['file-token'], ['ok id=12', 'ok'])
    const client = new CieClient(fake.io, DEFAULT_CONFIG.server)
    expect(await client.sendHold()).toEqual({ kind: 'held', id: 12 })
    expect(await client.sendHold()).toEqual({ kind: 'busy' })
    expect(fake.requests.map(r => r.body)).toEqual(['{"warning":1,"duration":0}', '{"warning":1,"duration":0}'])
  })

  test('a 400 to a hold means CieLinux does not support it', async () => {
    const fake = fakeIo([400, 500, 'down'])
    const client = new CieClient(fake.io, DEFAULT_CONFIG.server)
    expect(await client.sendHold()).toEqual({ kind: 'unsupported' })
    expect(await client.sendHold()).toEqual({ kind: 'failed' })
    expect(await client.sendHold()).toEqual({ kind: 'failed' })
  })

  test('clearing posts the id to the clear route next to the alerts route', async () => {
    const fake = fakeIo([202])
    const client = new CieClient(fake.io, DEFAULT_CONFIG.server)
    expect(await client.clearAlert(12)).toBe('sent')
    expect(fake.requests[0]?.url).toBe('http://127.0.0.1:43811/v1/alerts/clear')
    expect(fake.requests[0]?.body).toBe('{"id":12}')
  })

  test('expands a leading ~ only', () => {
    expect(expandHome('~/a', '/h')).toBe('/h/a')
    expect(expandHome('/x/~/a', '/h')).toBe('/x/~/a')
  })
})
