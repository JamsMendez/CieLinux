import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { DEFAULT_CONFIG, globMatch, mergeConfig, resolveActivity } from '../lib/config.ts'
import { expect } from './expect.ts'

describe('glob matching', () => {
  test('star matches any run of characters, case-sensitive', () => {
    expect(globMatch('review-*', 'review-risk')).toBe(true)
    expect(globMatch('*engram*', 'gentle_engram_save')).toBe(true)
    expect(globMatch('read', 'Read')).toBe(false)
    expect(globMatch('*', 'anything')).toBe(true)
    expect(globMatch('a.b', 'axb')).toBe(false)
  })
})

describe('default rules', () => {
  const scenes = DEFAULT_CONFIG.scenes
  const cases: Array<[kind: 'agent' | 'tool', name: string, scene: string | null, priority?: number]> = [
    ['agent', 'review-risk', 'raphael', 40],
    ['agent', 'jd-judge-a', 'raphael', 40],
    ['agent', 'gentle-ai-verify', 'raphael', 40],
    ['agent', 'sdd-design', 'raphael', 40],
    ['agent', 'jd-fix-agent', 'processing', 30],
    ['agent', 'gentle-ai-worker', 'processing', 30],
    ['agent', 'sdd-apply', 'processing', 30],
    ['agent', 'gentle-ai-explore', 'explorer', 20],
    ['agent', 'sdd-research', 'explorer', 20],
    ['agent', 'my-custom-agent', 'processing', 25],
    ['tool', 'bash', 'processing', 30],
    ['tool', 'edit', 'processing', 30],
    ['tool', 'write', 'processing', 30],
    ['tool', 'read', 'explorer', 20],
    ['tool', 'grep', 'explorer', 20],
    ['tool', 'web_search', 'explorer', 20],
    ['tool', 'fetch_content', 'explorer', 20],
    ['tool', 'codegraph', 'explorer', 20],
    ['tool', 'ask_user_question', null],
    ['tool', 'ask_user_choice', null],
    ['tool', 'todo', null],
    ['tool', 'mem_save', null],
    ['tool', 'subagent_status', null],
    ['tool', 'something_unknown', null],
  ]
  for (const [kind, name, scene, priority] of cases) {
    test(`${kind} ${name} -> ${scene ?? 'ignored'}`, () => {
      const target = resolveActivity(scenes, kind, name)
      if (scene === null) expect(target).toBe(undefined)
      else expect(target).toEqual({ scene, priority })
    })
  }
})

describe('config merge', () => {
  test('objects merge deeply and arrays replace', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      timing: { settleMs: 500 },
      scenes: { rules: [{ kind: 'tool', match: 'read', scene: 'raphael', priority: 1 }] },
    })
    expect(merged.timing).toEqual({ settleMs: 500, minHoldMs: 4000, idleDelayMs: 8000 })
    expect(merged.scenes.rules).toHaveLength(1)
    expect(merged.scenes.turn).toEqual(DEFAULT_CONFIG.scenes.turn)
    expect(merged.server.baseUrl).toBe('http://127.0.0.1:43811')
  })

  test('wrongly typed overrides keep the default', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { enabled: 'yes', timing: { settleMs: 'fast' } })
    expect(merged.enabled).toBe(true)
    expect(merged.timing.settleMs).toBe(1500)
  })

  test('the held warning is off by default and can be turned on', () => {
    expect(DEFAULT_CONFIG.alerts.warning.hold).toBe(false)
    expect(mergeConfig(DEFAULT_CONFIG, { alerts: { warning: { hold: true } } }).alerts.warning.hold).toBe(true)
    expect(mergeConfig(DEFAULT_CONFIG, { alerts: { warning: { hold: 'yes' } } }).alerts.warning.hold).toBe(false)
  })

  test('a non-object override changes nothing', () => {
    expect(mergeConfig(DEFAULT_CONFIG, 42)).toEqual(DEFAULT_CONFIG)
  })

  test('the bundled config.json mirrors DEFAULT_CONFIG', () => {
    const bundled: unknown = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'))
    expect(bundled).toEqual(DEFAULT_CONFIG)
  })
})
