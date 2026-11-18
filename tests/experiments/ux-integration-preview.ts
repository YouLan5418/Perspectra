/** Local player-route acceptance. Each invocation owns a new disposable world and loopback model stub. */
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { officialStageRenderers } from '../../apps/host/src/official-bundle.ts'
import { projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { createHostServer } from '../../apps/host/src/runtime/http-server.ts'
import { loadPackWeb } from '../../apps/host/src/runtime/pack-frontend.ts'
import { openRpgFixture } from '../support/rpg-fixture.ts'
import { addRpgValuesExample } from '../support/rpg-values-fixture.ts'

let greeting = true
const f = await openRpgFixture({
  config(raw) {
    addRpgValuesExample(raw)
    raw.maps[0].engage = 'optional'
    raw.enemies.golem.hp = 12
    delete raw.maps[1].chest
  },
  edit(pack) {
    const path = join(pack, 'entities.json')
    const rows = JSON.parse(readFileSync(path, 'utf8'))
    rows.entities.find((row: { entityId: string }) => row.entityId === 'entity:potion-2').locationId =
      'location:living-room'
    writeFileSync(path, JSON.stringify(rows))
  },
  async decide(input) {
    const c = input.context as { character?: { characterId?: string } }
    if (greeting && c.character?.characterId === 'character:cheng') {
      greeting = false
      return {
        decision: 'publish',
        segments: [
          { type: 'narration', text: '澄把手里的药瓶放回桌上。' },
          { type: 'speech', text: '药水就在桌上。准备好后，我们在遗迹入口见。' },
        ],
      }
    }
    return { decision: 'abstain' }
  },
})
await f.runtime.submit('大家准备好了吗？')
const art = await loadPackWeb(resolve('examples/world-packs/model-girls-sweet-days'))
if (!art) throw new Error('Demo assets missing')
const assets = new Map(art.assets)
for (const [from, to] of [
  ['portraits/claude.png', 'portraits/cheng.png'],
  ['portraits/gpt.png', 'portraits/aru.png'],
  ['backgrounds/entrance-shop.jpg', 'backgrounds/ruin-1.jpg'],
]) {
  const resource = assets.get('/frontend/custom/' + from)
  if (resource) assets.set('/frontend/custom/' + to, resource)
}
const token = randomBytes(32).toString('hex')
const server = createHostServer(
  f.runtime,
  token,
  { ...art, assets, stage: { characters: {} } },
  undefined,
  {},
  null,
  officialStageRenderers,
)
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Loopback fixture failed')
  const url = 'http://127.0.0.1:' + address.port + '/#token=' + token
  console.log('在本机浏览器打开 ' + url)
  process.send?.({ ready: true, url })
})
process.on('message', async (message: { id: number; command: string }) => {
  if (message.command === 'view') process.send?.({ id: message.id, view: projectPlayerView(await f.runtime.state()) })
})
async function close() {
  server.closeAllConnections()
  server.close()
  await f.close()
  process.exit(0)
}
process.once('SIGINT', close)
process.once('SIGTERM', close)
