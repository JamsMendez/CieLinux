import { describe, expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, globMatch, mergeConfig, resolveActivity } from '../hooks/config'

describe('glob matching', () => {
  test('star matches any run of characters, case-sensitive', () => {
    expect(globMatch('review-*', 'review-risk')).toBe(true)
    expect(globMatch('mcp__*engram*', 'mcp__plugin_engram_engram__mem_save')).toBe(true)
    expect(globMatch('Read', 'read')).toBe(false)
    expect(globMatch('*', 'anything')).toBe(true)
    expect(globMatch('a.b', 'axb')).toBe(false)
  })
})

describe('default rules', () => {
  const scenes = DEFAULT_CONFIG.scenes
  const cases: Array<[kind: 'agent' | 'tool', name: string, scene: string | null, priority?: number]> = [
    ['agent', 'review-risk', 'raphael', 40],
    ['agent', 'jd-judge-a', 'raphael', 40],
    ['agent', 'sdd-design', 'raphael', 40],
    ['agent', 'Plan', 'raphael', 40],
    ['agent', 'sdd-apply', 'processing', 30],
    ['agent', 'jd-fix-agent', 'processing', 30],
    ['agent', 'Explore', 'explorer', 20],
    ['agent', 'sdd-research', 'explorer', 20],
    ['agent', 'general-purpose', 'processing', 25],
    ['agent', 'some-plugin:custom', 'processing', 25],
    ['tool', 'Bash', 'processing', 30],
    ['tool', 'Edit', 'processing', 30],
    ['tool', 'Read', 'explorer', 20],
    ['tool', 'mcp__codegraph__codegraph_explore', 'explorer', 20],
    ['tool', 'Agent', null],
    ['tool', 'AskUserQuestion', null],
    ['tool', 'mcp__plugin_engram_engram__mem_save', null],
    ['tool', 'SomethingUnknown', null],
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
      scenes: { rules: [{ kind: 'tool', match: 'Read', scene: 'raphael', priority: 1 }] },
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
})
