import { WorldApplication } from '@harness-world/application'
import { LocalJsonRpcRouter, executeLocalCli } from '../src/index.ts'

const [worldPath, sessionPath, ...command] = process.argv.slice(2)
if (worldPath === undefined || sessionPath === undefined) {
  throw new TypeError('usage: worldappctl <world.sqlite> <session.sqlite> <command>')
}
const application = new WorldApplication({ worldPath, sessionPath })
const router = new LocalJsonRpcRouter(worldPath, application)
try {
  process.stdout.write(await executeLocalCli(command, router))
} finally {
  router.close()
  await application.close()
}
