import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { StoredWorldEvent } from '@harness-world/contracts'
import { JevShadow, type ShadowRecord } from './jev-shadow.ts'

const source = resolve(process.argv[2] ?? ''), output = resolve(process.argv[3] ?? '')
if (!process.argv[2] || !process.argv[3] || existsSync(output)) throw new Error('provide source live run and new output')
mkdirSync(output, { recursive: true })
const records = readFileSync(resolve(source, 'jev-shadow.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s) as ShadowRecord)
const old = records.find(r => r.publication?.seq === 265 && r.item?.entityId === 'entity:pocket-watch')!
const events = JSON.parse(readFileSync(resolve(source, 'events.json'), 'utf8')) as StoredWorldEvent[]
const results: ShadowRecord[] = []
const shadow = new JevShadow({ address: old.address, initialSeq: old.claims.find(c => c.status === 'CONFLICT')!.window.fromSeq,
  characters: [{ characterId: 'character:companion', name: '陆舟' }, { characterId: 'character:friend', name: '程雨' }, { characterId: 'character:player', name: '玩家' }],
  items: [{ entityId: 'entity:pocket-watch', name: '铜怀表' }], readEvents: seq => events.slice(0, seq),
  classify: async q => {
    const record = records.find(r => r.publication?.seq === q.publication.seq && r.item?.entityId === q.item.entityId)
    if (!record?.answer) throw new Error('missing saved answer')
    return record.answer // Exact real model response; no new model request or prompt retuning.
  }, write: async record => { results.push(record) } })
const before = JSON.stringify(events)
shadow.observe(old.postHeadSeq); await shadow.close()
const result = results.find(r => r.publication?.seq === 265)!
if (result.status !== 'UNCERTAIN' || result.claims.some(c => c.rootPublicationSeq !== null)) throw new Error('expected unresolved, rootless finding')
if (before !== JSON.stringify(events)) throw new Error('events changed')
writeFileSync(resolve(output, 'results.json'), JSON.stringify({ old, result }, null, 2))
writeFileSync(resolve(output, 'reconciler-source.ts'), readFileSync('tests/experiments/jev-shadow.ts'))
console.log(JSON.stringify({ seq: 265, originalStatus: old.status, finalStatus: result.status, root: result.claims.map(c => c.rootPublicationSeq), newModelCalls: 0 }))
