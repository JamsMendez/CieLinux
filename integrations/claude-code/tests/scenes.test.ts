import { describe, expect, test } from 'claude-code/testing'
import { SceneEngine } from '../hooks/scenes'

const TIMING = { settleMs: 1500, minHoldMs: 4000, idleDelayMs: 8000 }
const IDLE = 'idle'

const make = () => new SceneEngine(TIMING, IDLE)

describe('scene engine', () => {
  test('sends nothing before the settle window has passed', () => {
    const engine = make()
    expect(engine.add('turn', { scene: 'raphael', priority: 5 }, 0).send).toBe(undefined)
    expect(engine.update(1499).send).toBe(undefined)
    expect(engine.update(1500).send).toBe('raphael')
  })

  test('asks to be woken when the pending change becomes due', () => {
    const engine = make()
    expect(engine.add('turn', { scene: 'raphael', priority: 5 }, 100).wakeAt).toBe(1600)
  })

  test('highest priority activity wins', () => {
    const engine = make()
    engine.add('turn', { scene: 'raphael', priority: 5 }, 0)
    engine.add('tool:1', { scene: 'explorer', priority: 20 }, 0)
    engine.add('agent:a', { scene: 'processing', priority: 30 }, 0)
    expect(engine.update(1500).send).toBe('processing')
  })

  test('ties go to the most recently started activity', () => {
    const engine = make()
    engine.add('tool:1', { scene: 'explorer', priority: 20 }, 0)
    engine.add('tool:2', { scene: 'processing', priority: 20 }, 10)
    expect(engine.update(2000).send).toBe('processing')
  })

  test('a burst shorter than settleMs sends nothing', () => {
    const engine = make()
    engine.add('turn', { scene: 'raphael', priority: 5 }, 0)
    expect(engine.update(1500).send).toBe('raphael')
    engine.add('tool:1', { scene: 'explorer', priority: 20 }, 6000)
    engine.remove('tool:1', 6800)
    expect(engine.update(9000).send).toBe(undefined)
    expect(engine.update(20000).send).toBe(undefined)
  })

  test('holds a committed scene for at least minHoldMs', () => {
    const engine = make()
    engine.add('turn', { scene: 'raphael', priority: 5 }, 0)
    expect(engine.update(1500).send).toBe('raphael')
    const added = engine.add('tool:1', { scene: 'processing', priority: 30 }, 1600)
    expect(added.wakeAt).toBe(5500)
    expect(engine.update(3200).send).toBe(undefined)
    expect(engine.update(5500).send).toBe('processing')
  })

  test('never sends the same scene twice in a row', () => {
    const engine = make()
    engine.add('turn', { scene: 'raphael', priority: 5 }, 0)
    expect(engine.update(1500).send).toBe('raphael')
    engine.add('agent:a', { scene: 'raphael', priority: 40 }, 2000)
    expect(engine.update(10000).send).toBe(undefined)
  })

  test('goes idle only after idleDelayMs of emptiness', () => {
    const engine = make()
    engine.add('turn', { scene: 'raphael', priority: 5 }, 0)
    expect(engine.update(1500).send).toBe('raphael')
    const removed = engine.remove('turn', 5000)
    expect(removed.wakeAt).toBe(13000)
    expect(engine.update(12999).send).toBe(undefined)
    expect(engine.update(13000).send).toBe(IDLE)
  })

  test('does not send idle before anything was sent', () => {
    const engine = make()
    engine.add('tool:1', { scene: 'explorer', priority: 20 }, 0)
    engine.remove('tool:1', 500)
    expect(engine.update(60000).send).toBe(undefined)
  })

  test('add is idempotent by id', () => {
    const engine = make()
    engine.add('agent:a', { scene: 'processing', priority: 30 }, 0)
    engine.add('agent:a', { scene: 'explorer', priority: 20 }, 100)
    expect(engine.update(2000).send).toBe('processing')
    engine.remove('agent:a', 2100)
    expect(engine.size()).toBe(0)
  })

  test('drops activities older than the max age', () => {
    const engine = new SceneEngine(TIMING, IDLE, 60000)
    engine.add('turn', { scene: 'raphael', priority: 5 }, 0)
    engine.add('agent:stuck', { scene: 'processing', priority: 30 }, 0)
    expect(engine.update(1500).send).toBe('processing')
    engine.remove('turn', 2000)
    expect(engine.update(60000).send).toBe(undefined)
    expect(engine.size()).toBe(0)
    expect(engine.update(68000).send).toBe(IDLE)
  })

  test('end sends idle at once when something else was committed', () => {
    const engine = make()
    engine.add('turn', { scene: 'raphael', priority: 5 }, 0)
    engine.update(1500)
    expect(engine.end(1600)).toBe(IDLE)
    expect(engine.size()).toBe(0)
    expect(engine.end(1700)).toBe(undefined)
  })

  test('reset forgets activities and the committed scene', () => {
    const engine = make()
    engine.add('turn', { scene: 'raphael', priority: 5 }, 0)
    engine.update(1500)
    engine.reset()
    expect(engine.size()).toBe(0)
    expect(engine.end(2000)).toBe(undefined)
  })
})
