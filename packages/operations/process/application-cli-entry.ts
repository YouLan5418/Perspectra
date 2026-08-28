import { WorldApplication } from '@harness-world/application'
import {
  LocalJsonRpcRouter,
  WorldHealthService,
  WorldHostInstanceLock,
  ensureWorldHostLayout,
  executeLocalCli,
  parseWorldApplicationCliInvocation,
  resolveWorldHostConfig,
  runPersistentWorldChat,
  selectPlayerChatScope,
} from '../src/index.ts'

const invocation = parseWorldApplicationCliInvocation(process.argv.slice(2))
if (invocation.kind === 'chat') {
  const config = resolveWorldHostConfig(invocation.configArgs)
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
    try {
      const scope = selectPlayerChatScope(application.listPlayerChatScopes())
      const health = new WorldHealthService(config.worldPath)
      await runPersistentWorldChat(process.stdin, process.stdout, application, scope, { health: () => health.check() })
    } finally {
      await application.close()
    }
  } finally {
    lock.release()
  }
} else {
  const application = new WorldApplication({
    worldPath: invocation.worldPath,
    sessionPath: invocation.sessionPath,
    leaseTtlMs: 5_000,
  })
  const router = new LocalJsonRpcRouter(invocation.worldPath, application)
  try {
    process.stdout.write(await executeLocalCli(invocation.command, router, { busyRetryTimeoutMs: 6_000, busyRetryDelayMs: 100 }))
  } finally {
    await router.close()
    await application.close()
  }
}
