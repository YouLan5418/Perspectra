import { LocalJsonRpcRouter, executeLocalCli } from '../src/index.ts'

const [worldPath, ...command] = process.argv.slice(2)
if (worldPath === undefined) throw new TypeError('usage: worldctl <world.sqlite> <command>')
const router = new LocalJsonRpcRouter(worldPath)
try {
  process.stdout.write(await executeLocalCli(command, router))
} finally {
  await router.close()
}
