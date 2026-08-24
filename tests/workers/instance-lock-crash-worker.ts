import { WorldHostInstanceLock } from '@harness-world/operations'

const [lockPath, worldPath] = process.argv.slice(2)
if (lockPath === undefined || worldPath === undefined) {
  throw new Error('usage: instance-lock-crash-worker <lock-path> <world-path>')
}
WorldHostInstanceLock.acquire(lockPath, worldPath)
process.send?.({ type: 'fault-reached', point: 'instance-lock.after-acquire' })
await new Promise(() => undefined)
