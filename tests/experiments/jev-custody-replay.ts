import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StoredWorldEvent, WorldJsonObject } from '@harness-world/contracts'
import { currentEntityState } from '@harness-world/kernel'
import { createClaimClassifier } from './jev-shadow-claims-client.ts'
import { acquisitionWindow, holderEvidence, reconcilePlacement } from './jev-shadow-window.ts'
import type { ShadowRecord } from './jev-shadow.ts'

const directory = resolve(process.argv[2] ?? '')
if (!process.argv[2] || existsSync(directory)) throw new Error('provide new evidence directory')
mkdirSync(directory, { recursive: true })
const root = resolve('experiments/jev-narrative-auditor/holdout-2026-09-27')
const reviews = JSON.parse(readFileSync(resolve(root, 'repair-review.json'), 'utf8')) as { run: string; head: number; category: string }[]
const interventions = readFileSync(resolve(root, 'b1-interventions.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s))
const sample = JSON.parse(readFileSync(resolve(root, 'b1-jev-shadow.jsonl'), 'utf8').split('\n')[0]!) as ShadowRecord
const db = new DatabaseSync(resolve(process.argv[3] ?? ''), { readOnly: true })
const classify = createClaimClassifier(process.env.OPENROUTER_JEV_KEY ?? '')
const characters = [{ characterId: 'character:companion', name: '陆舟' }, { characterId: 'character:friend', name: '程雨' }, { characterId: 'character:player', name: '玩家' }]
const items = [{ entityId: 'entity:pocket-watch', name: '铜怀表' }, { entityId: 'entity:diary', name: '布面日记' }]
const output: { head: number; item: string; conflict: boolean; kinds: string[] }[] = []
try {
  for (const review of reviews.filter(r => r.category === 'unnecessary')) {
    const original = interventions.find(r => r.baseHeadSeq === review.head)
    const events = db.prepare('SELECT * FROM events WHERE seq <= ? ORDER BY seq').all(review.head).map(r => ({
      address: sample.address, seq: Number(r.seq), tick: Number(r.tick), eventType: String(r.event_type),
      eventVersion: Number(r.event_version), data: JSON.parse(String(r.data_json)),
      transactionId: String(r.transaction_id), eventOrdinal: Number(r.event_ordinal),
      previousHash: String(r.previous_hash), eventHash: String(r.event_hash),
    })) as StoredWorldEvent[]
    // Only expressions individually witnessed by this actor, matching the old pre-publication path.
    const seen = events.filter(e => e.eventType === 'observation.upsert' && (e.data as WorldJsonObject).value
      && ((e.data as WorldJsonObject).value as WorldJsonObject).observerId === original.actorId)
      .flatMap(e => {
        const content = (((e.data as WorldJsonObject).value as WorldJsonObject).content as WorldJsonObject)
        const speech = content?.speech as WorldJsonObject | undefined
        if (!speech) return []
        const source = events.findLast(p => p.eventType === 'character.speak' && p.transactionId === e.transactionId && JSON.stringify(p.data) === JSON.stringify(speech))
        return source ? [{ seq: source.seq, actorId: String(speech.characterId), speech: String(speech.text ?? ''), narration: String(speech.narration ?? '') }] : []
      })
    const earlierPublications = [...new Map(seen.map(p => [p.seq, p])).values()].slice(-12)
    const window = acquisitionWindow(events, { roundId: null, fromSeq: review.head, toSeq: review.head, kind: 'round' })
    for (const check of original.checks.filter((c: { conflicts: string[]; placement: { status: string } }) => c.conflicts.length || c.placement.status === 'CONFLICT')) {
      const item = items.find(i => i.entityId === check.itemId)!
      const question = { item, items, characters, earlierPublications, round: window,
        publication: { seq: review.head + 1, actorId: original.actorId,
          speech: original.original.speech ?? '', narration: original.original.narration ?? '' } }
      const answer = await classify(question)
      const placement = reconcilePlacement(events, window, item.entityId, original.actorId, review.head + 1, answer.placement)
      const claims = answer.claims.filter(c => {
        const evidence = holderEvidence(events, window, item.entityId, c.characterId)
        return c.kind === 'OBJECTIVE_NOW' ? currentEntityState(events, item.entityId)?.holderId !== c.characterId
          : c.kind === 'OBJECTIVE_NEW' ? evidence.enteredSeqs.length === 0
            : c.kind === 'OBJECTIVE_DURING' ? !evidence.heldAtWindowStart && evidence.enteredSeqs.length === 0 : false
      })
      const row = { head: review.head, item: item.entityId, conflict: placement.status === 'CONFLICT' || claims.length > 0,
        kinds: answer.claims.map(c => c.kind) }
      output.push(row)
      appendFileSync(resolve(directory, 'results.jsonl'), JSON.stringify({ ...row, question, answer, placement, conflicts: claims }) + '\n')
      console.log(JSON.stringify(row))
    }
  }
  writeFileSync(resolve(directory, 'summary.json'), JSON.stringify({ calls: output.length, conflicts: output.filter(r => r.conflict),
    source: '07 known unnecessary repairs, original draft and read-only original event prefix; not holdout', cases: output }, null, 2))
} finally { db.close() }
