import { describe, expect, test } from 'claude-code/testing'
import { AlertBatcher } from '../hooks/alerts'

const CONFIG = {
  warning: { enabled: true, hold: false, duration: 5, cooldownMs: 10000, on: ['AskUserQuestion', 'PermissionRequest'] },
  failed: { enabled: true, duration: 8, batchMs: 3000, tools: ['Bash'], ignoreInterrupted: true },
}

const make = () => new AlertBatcher(CONFIG)

describe('alert batcher', () => {
  test('a warning is sent at once with its duration', () => {
    expect(make().warning(0).send).toEqual({ warning: 1, duration: 5 })
  })

  test('a second warning inside the cooldown is ignored', () => {
    const alerts = make()
    alerts.warning(0)
    const again = alerts.warning(9000)
    expect(again.send).toBe(undefined)
    expect(again.wakeAt).toBe(undefined)
    expect(alerts.update(60000).send).toBe(undefined)
  })

  test('failures in one window produce one request', () => {
    const alerts = make()
    expect(alerts.failed(0).wakeAt).toBe(3000)
    expect(alerts.failed(1000).send).toBe(undefined)
    expect(alerts.failed(2000).send).toBe(undefined)
    expect(alerts.update(2999).send).toBe(undefined)
    expect(alerts.update(3000).send).toEqual({ failed: 3, duration: 8 })
    expect(alerts.update(9000).send).toBe(undefined)
  })

  test('the failed count is capped at 16 tiles', () => {
    const alerts = make()
    for (let i = 0; i < 40; i++) alerts.failed(i)
    expect(alerts.update(3000).send).toEqual({ failed: 16, duration: 8 })
  })

  test('nothing is sent while an alert is still showing', () => {
    const alerts = make()
    alerts.warning(0)
    alerts.failed(1000)
    const due = alerts.update(4000)
    expect(due.send).toBe(undefined)
    expect(due.wakeAt).toBe(5500)
    expect(alerts.update(5500).send).toEqual({ failed: 1, duration: 8 })
  })

  test('pending kinds are merged into one request once free', () => {
    const alerts = make()
    alerts.failed(0)
    expect(alerts.update(3000).send).toEqual({ failed: 1, duration: 8 })
    alerts.failed(4000)
    alerts.failed(5000)
    expect(alerts.warning(9000)).toEqual({ wakeAt: 11500 })
    expect(alerts.update(11499).send).toBe(undefined)
    expect(alerts.update(11500).send).toEqual({ failed: 2, warning: 1, duration: 8 })
  })

  test('a warning sent while failures are batching carries them along', () => {
    const alerts = make()
    alerts.failed(0)
    expect(alerts.warning(1000).send).toEqual({ failed: 1, warning: 1, duration: 8 })
    expect(alerts.update(3000).send).toBe(undefined)
  })

  test('combined tiles never exceed 16', () => {
    const alerts = make()
    for (let i = 0; i < 20; i++) alerts.failed(i)
    expect(alerts.warning(100).send).toEqual({ failed: 15, warning: 1, duration: 8 })
  })

  test('disabled kinds send nothing', () => {
    const alerts = new AlertBatcher({
      warning: { ...CONFIG.warning, enabled: false },
      failed: { ...CONFIG.failed, enabled: false },
    })
    expect(alerts.warning(0).send).toBe(undefined)
    alerts.failed(0)
    expect(alerts.update(5000).send).toBe(undefined)
  })

  test('reset clears pending and busy state', () => {
    const alerts = make()
    alerts.warning(0)
    alerts.failed(100)
    alerts.reset()
    expect(alerts.update(10000).send).toBe(undefined)
    expect(alerts.warning(100).send).toEqual({ warning: 1, duration: 5 })
  })
})
