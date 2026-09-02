import { WorldApplication } from '@harness-world/application'
import {
  ensureWorldHostLayout,
  LocalJsonRpcRouter,
  resolveWorldHostConfig,
  runHeadlessJsonRpc,
  WorldHostInstanceLock,
} from '../src/index.ts'

const config = resolveWorldHostConfig(process.argv.slice(2))
ensureWorldHostLayout(config)
const lock = WorldHostInstanceLock.acquire(config.lockPath, config.worldPath)
try {
  const application = new WorldApplication({
    worldPath: config.worldPath,
    sessionPath: config.sessionPath,
    memoryPath: config.memoryPath,
    contextPath: config.contextPath,
    leaseTtlMs: config.leaseTtlMs,
    runtimeOwnerId: lock.record.writerOwnerPrefix,
  })
  const router = new LocalJsonRpcRouter(config.worldPath, application, {
    maxConcurrentBranches: config.maxConcurrentBranches,
    rescanIntervalMs: config.rescanIntervalMs,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  })
  const shutdown = new AbortController()
  const stop = () => shutdown.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    router.recoverAcceptedRounds('worldhost:startup')
    await runHeadlessJsonRpc(process.stdin, process.stdout, router, { signal: shutdown.signal })
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    try {
      await router.close()
    } finally {
      await application.close()
    }
  }
} finally {
  lock.release()
}
