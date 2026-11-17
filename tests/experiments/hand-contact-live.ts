import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WorldHostRuntime } from '../../apps/host/src/runtime/world-runtime.ts'
import { WorldStore } from '@perspectra/core/store'
import { fakeModels } from '../support/fake-provider.ts'

const model = process.env.PERSPECTRA_CONTACT_MODEL ?? 'opencode-go/deepseek-v4.1-flash'
const endpoint = process.env.PERSPECTRA_CONTACT_ENDPOINT ?? 'http://127.0.0.1:8025/v1/chat/completions'
const root = mkdtempSync(join(tmpdir(), 'perspectra-contact-live-'))
const pack = join(root, 'pack')
cpSync(resolve('examples/world-packs/hand-in-hand'), pack, { recursive: true })
const characters = JSON.parse(readFileSync(join(pack, 'characters.json'), 'utf8'))
characters.characters.find((character: any) => character.characterId === 'character:friend').initialLocationId = 'location:ridge-path'
characters.characters.find((character: any) => character.characterId === 'character:companion').portrayal.speakingStyle = '简短自然地回应。玩家请求结束牵手时，自行选择正式松手操作完成，再回应。'
writeFileSync(join(pack, 'characters.json'), JSON.stringify(characters))
const scenes = JSON.parse(readFileSync(join(pack, 'scenes.json'), 'utf8'))
scenes.scenes[0].participantIds = ['character:player', 'character:companion']
writeFileSync(join(pack, 'scenes.json'), JSON.stringify(scenes))
const data = join(root, 'data')
const runtime = await WorldHostRuntime.create({
  packPath: pack, dataDirectory: data,
  models: fakeModels(endpoint, 'openai', model, process.env.PERSPECTRA_CONTACT_API_KEY),
})
const events = () => { const store = new WorldStore(join(data, 'world.sqlite')); try { return store.readEvents(runtime.address) } finally { store.close() } }
const partners = (actorId: string) => events().filter(event => event.eventType === 'status.updated').flatMap(event => (event.data as any).changes).findLast(change => change.key === 'contact-partners' && change.holderId === actorId)?.value
const action = (id: string) => '/act interact ' + JSON.stringify({ targetRef: { kind: 'character', id: 'character:companion' }, bindingId: 'gameplay', definitionRef: { id, version: 1 }, arguments: { partnerId: 'character:companion' } })
try {
  for (const text of [action('contact:hold-hand'), '/act speak {"text":"请你现在松开我的手，使用正式行动完成，然后告诉我。"}', action('contact:hold-hand'), '/act move {"locationId":"location:ridge-path"}']) {
    const state = await runtime.submit(text)
    console.log(JSON.stringify({ phase: text.startsWith('/act speak') ? 'request-npc-release' : text.startsWith('/act move') ? 'depart' : 'hold', error: state.error, notice: state.notice, playerPartners: partners('character:player'), npcPartners: partners('character:companion') }))
  }
  const all = events()
  const npcRelease = all.filter(event => event.eventType === 'status.updated' && (event.data as any).source.operation === 'contact:end-contact' && (event.data as any).source.actorId === 'character:companion')
  const moved = all.findLast(event => event.eventType === 'character.moved' && (event.data as any).characterId === 'character:player')
  const releasedWithMove = all.some(event => event.eventType === 'status.updated' && event.transactionId === moved?.transactionId && (event.data as any).changes.some((change: any) => change.key === 'contact-partners' && change.value.length === 0))
  const contactTransactions = new Set(all.filter(event => event.eventType === 'status.updated' && ['contact:hold-hand', 'contact:end-contact'].includes((event.data as any).source.operation)).map(event => event.transactionId))
  const privateLeak = all.some(event => event.eventType === 'observation.upsert' && contactTransactions.has(event.transactionId) && (event.data as any).value.observerId === 'character:friend')
  const result = { model, npcReleaseCount: npcRelease.length, releasedWithMove, privateLeak, playerPartners: partners('character:player'), npcPartners: partners('character:companion') }
  mkdirSync(resolve('.tmp/hand-contact-live'), { recursive: true })
  writeFileSync(resolve('.tmp/hand-contact-live/result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  if (!npcRelease.length || !releasedWithMove || privateLeak) process.exitCode = 1
} finally { await runtime.close() }
