import { WorldApplication } from '@harness-world/application'
import { LocalJsonRpcRouter, runHeadlessJsonRpc } from '../src/index.ts'

const [worldPath, sessionPath] = process.argv.slice(2)
if (worldPath === undefined || sessionPath === undefined) throw new TypeError('usage: worldhost <world.sqlite> <session.sqlite>')
const application = new WorldApplication({ worldPath, sessionPath, leaseTtlMs: 5_000 })
const router = new LocalJsonRpcRouter(worldPath, application)
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
  await router.close()
  await application.close()
}
