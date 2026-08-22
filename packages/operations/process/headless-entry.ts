import { WorldApplication } from '@harness-world/application'
import { LocalJsonRpcRouter, runHeadlessJsonRpc } from '../src/index.ts'

const [worldPath, sessionPath] = process.argv.slice(2)
if (worldPath === undefined || sessionPath === undefined) throw new TypeError('usage: worldhost <world.sqlite> <session.sqlite>')
const application = new WorldApplication({ worldPath, sessionPath, leaseTtlMs: 5_000 })
const router = new LocalJsonRpcRouter(worldPath, application)
try {
  await runHeadlessJsonRpc(process.stdin, process.stdout, router)
} finally {
  await router.close()
  await application.close()
}
