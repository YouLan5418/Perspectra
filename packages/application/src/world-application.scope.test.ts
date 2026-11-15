import { expect, it, vi } from 'vitest'
import { WorldApplication } from './world-application.ts'

it('creates isolated instance scopes from the application root and rejects them after close', async () => {
  const app = new WorldApplication({
    worldPath: 'unused-world.sqlite',
    sessionPath: 'unused-session.sqlite',
  })
  const scope = await app.createInstanceScope({ cleanupTimeoutMs: 10 })
  expect(scope.active).toBe(true)
  await scope.close()
  await app.close()
  await expect(app.createInstanceScope()).rejects.toThrow('WorldApplication is closed')
})

it('deactivates and closes application-owned scopes before waiting for application work', async () => {
  const app = new WorldApplication({
    worldPath: 'unused-world.sqlite',
    sessionPath: 'unused-session.sqlite',
  })
  const scope = await app.createInstanceScope({ cleanupTimeoutMs: 10 })
  const close = vi.fn()
  scope.own('host.resource', {}, close)
  let workEntered!: () => void
  const entered = new Promise<void>(resolve => {
    workEntered = resolve
  })
  const invoking = scope.invoke(() => {
    workEntered()
    return new Promise<void>(() => {})
  })
  await entered

  const closing = app.close()
  expect(scope.active).toBe(false)
  expect(scope.signal.aborted).toBe(true)
  expect(() => scope.assertActive()).toThrow('WorldInstanceScope is closed')
  await expect(invoking).rejects.toMatchObject({ name: 'AbortError' })
  await closing

  expect(close).toHaveBeenCalledOnce()
  const report = await scope.close()
  expect(report.closed).toContain('host.resource')
  expect(scope.resolve('host.resource')).toBeUndefined()
  await expect(scope.invoke(() => 'late')).rejects.toThrow('WorldInstanceScope is closed')
})
