import { addRpgEffectsExample } from '../support/rpg-effects-fixture.ts'
/** Real official rules and isolated SQLite; only a loopback fake provider, no model credentials. */
import { randomBytes } from 'node:crypto'
import { openRpgFixture } from '../support/rpg-fixture.ts'
import { createHostServer } from '../../apps/host/src/runtime/http-server.ts'
import { listenOnSafePort } from '../../apps/host/src/safe-port.ts'

const fixture = await openRpgFixture({
  config: addRpgEffectsExample,
  places: { 'character:player': 'location:ruin-1', 'character:cheng': 'location:living-room' },
})
await fixture.runtime.submit('准备战斗。')
const token = randomBytes(32).toString('hex')
const server = createHostServer(fixture.runtime, token)
const port = await listenOnSafePort(server)
console.log(`Official RPG effects preview: http://127.0.0.1:${port}/#token=${token}`)
console.log('Temporary single-player battle; Ctrl+C closes and removes its world. No real model calls.')
let closing = false
const close = async () => {
  if (closing) return
  closing = true
  server.closeAllConnections()
  await new Promise<void>(done => server.close(() => done()))
  await fixture.close()
}
process.once('SIGINT', close)
process.once('SIGTERM', close)
