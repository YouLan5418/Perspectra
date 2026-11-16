import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
/** Temporary real Host / SQLite card table. No model credentials; deterministic NPCs. */
import { randomBytes } from 'node:crypto'
import { copyCards, startCards } from '../support/cards-fixture.ts'
import { openRpgWorld } from '../support/rpg-fixture.ts'
import { createHostServer } from '../../apps/host/src/runtime/http-server.ts'
import { listenOnSafePort } from '../../apps/host/src/safe-port.ts'
const authored = JSON.parse(readFileSync(resolve('examples/world-packs/card-table/cards.json'), 'utf8')) as WorldJsonObject
const fixture = copyCards({ ...authored, npcMode: 'deterministic' })
const world = await openRpgWorld(fixture.pack, fixture.data)
if (process.argv.includes('--identity')) await startCards(world, 'identity')
const token = randomBytes(32).toString('hex')
const server = createHostServer(world.runtime, token)
const port = await listenOnSafePort(server)
console.log(`Card table preview: http://127.0.0.1:${port}/#token=${token}`)
console.log('Temporary world; Ctrl+C closes and deletes it. No model keys or paid calls.')
let closing = false
const close = async () => {
  if (closing) return
  closing = true
  server.closeAllConnections()
  await new Promise<void>(done => server.close(() => done()))
  await world.close(); fixture.cleanup()
}
process.once('SIGINT', close)
process.once('SIGTERM', close)
