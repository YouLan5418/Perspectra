import { expect, it, vi } from 'vitest'
import { brandId, type StoredWorldEvent, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { JevShadow, holderChoice, holderCriteria, parseAuditItems,
  type HolderAnswer, type HolderQuestion, type ShadowRecord } from '../experiments/jev-shadow.ts'
import { holderRequest, parseHolderAnswer } from '../experiments/jev-shadow-client.ts'

const address: WorldAddress = { tenantId: brandId('t', 'TenantId'), worldId: brandId('w', 'WorldId'), branchId: brandId('b', 'BranchId') }
const characters = [{ characterId: 'char:a', name: '林澄' }, { characterId: 'char:b', name: '陆遥' }, { characterId: 'char:c', name: '新来者' }]
const items = [{ entityId: 'item:key', name: '黄铜钥匙', aliases: ['钥匙'] }]
function event(seq: number, eventType: string, data: WorldJsonObject, tx = seq): StoredWorldEvent {
  return { address, seq, eventType, data, eventVersion: 1, tick: tx, previousHash: 'genesis', eventHash: `sha256:${'0'.repeat(64)}`,
    transactionId: brandId(`tx:${tx}`, 'TransactionId'), eventOrdinal: 0 }
}
const initial = [
  ...characters.map((character, index) => event(index + 1, 'character.created', { ...character, locationId: 'room' })),
  event(4, 'entity.upsert', { entityId: 'item:key', kind: 'key', locationId: 'room' }),
]
const speak = (seq: number, tx = seq) => event(seq, 'character.speak', { characterId: 'char:a', text: '已经给你了。', narration: '她看着窗外。' }, tx)
const take = (seq: number, tx = seq) => event(seq, 'entity.transferred', { entityId: 'item:key', fromHolderId: null,
  fromLocationId: 'room', toHolderId: 'char:b', toLocationId: null, characterId: 'char:b', interactionId: 'take' }, tx)
function answer(choice: string): HolderAnswer {
  return { choice, probabilities: Object.fromEntries(Object.keys(holderCriteria(characters)).map(label => [label, label === choice ? 1 : 0])),
    confidence: 1, model: 'fixture', inputTokens: 1, outputTokens: 1, costUsd: 0 }
}
function setup(events: readonly StoredWorldEvent[], classify: (question: HolderQuestion) => Promise<HolderAnswer>) {
  const records: ShadowRecord[] = []
  const readEvents = vi.fn((seq: number) => events.filter(entry => entry.seq <= seq))
  const shadow = new JevShadow({ address, characters, items, initialSeq: 4, readEvents, classify,
    write: async record => { records.push(record) } })
  return { shadow, records, readEvents }
}

it('enqueue does no synchronous reading or classification; close drains every queued publication', async () => {
  const classify = vi.fn(async () => answer('NO_CLAIM'))
  const { shadow, records, readEvents } = setup([...initial, speak(5), speak(6)], classify)
  shadow.observe(5); shadow.observe(6)
  expect(readEvents).not.toHaveBeenCalled()
  expect(classify).not.toHaveBeenCalled()
  expect(records).toHaveLength(0)
  await shadow.close()
  expect(records.map(row => row.publication?.seq)).toEqual([5, 6])
  shadow.observe(7)
  expect(shadow.stats().pendingWindows).toBe(0)
})

it.each(['NO_CLAIM', 'SPEECH_ONLY'])('does not convert %s into an unchanged-holder claim after a real transfer', async choice => {
  const { shadow, records } = setup([...initial, speak(5, 5), take(6, 5)], async () => answer(choice))
  shadow.observe(6); await shadow.close()
  expect(records[0]).toMatchObject({ preHeadSeq: 4, postHeadSeq: 6, beforeHolder: null, worldHolder: 'char:b', status: 'NO_CLAIM' })
})

it.each([
  [holderChoice('char:b'), 'SUPPORTED'], [holderChoice('char:c'), 'CONFLICT'], ['GROUND', 'CONFLICT'], ['UNCERTAIN', 'UNCERTAIN'],
])('World compares %s against the formal terminal holder: %s', async (choice, status) => {
  const { shadow, records } = setup([...initial, speak(5, 5), take(6, 5)], async () => answer(choice))
  shadow.observe(6); await shadow.close()
  expect(records[0]).toMatchObject({ status, holderEventSeq: 6 })
})

it('uses each original transaction prefix despite a later transfer; keeps speaker and text channels', async () => {
  const future = event(7, 'entity.transferred', { entityId: 'item:key', fromHolderId: 'char:b', fromLocationId: null,
    toHolderId: 'char:c', toLocationId: null, characterId: 'char:b', interactionId: 'give' })
  const questions: HolderQuestion[] = []
  const { shadow, records } = setup([...initial, take(5), speak(6), future], async question => {
    questions.push(question); return answer(holderChoice('char:b'))
  })
  shadow.observe(6); shadow.observe(7); await shadow.close()
  expect(records[0]).toMatchObject({ preHeadSeq: 5, postHeadSeq: 6, worldHolder: 'char:b', status: 'SUPPORTED', holderEventSeq: 5 })
  expect(questions[0]?.publication).toEqual({ seq: 6, actorId: 'char:a', speech: '已经给你了。', narration: '她看着窗外。' })
  expect(questions[0]?.characters.map(character => character.characterId)).toContain('char:c')
  expect(Object.keys(questions[0]!).sort()).toEqual(['characters', 'item', 'items', 'publication'])
})

it('marks API failure separately, sanitizes errors, and continues later publications', async () => {
  const { shadow, records } = setup([...initial, speak(5), speak(6)], async question => {
    if (question.publication.seq === 5) throw new Error('secret bearer key')
    return answer('NO_CLAIM')
  })
  shadow.observe(6); await shadow.close()
  expect(records.map(row => row.status)).toEqual(['CALL_FAILED', 'NO_CLAIM'])
  expect(JSON.stringify(records)).not.toContain('secret bearer key')
  expect(shadow.stats().errors).toBe(1)
})

it('rejects a missing event prefix before requesting Jev', async () => {
  const classify = vi.fn(async () => answer('NO_CLAIM'))
  const { shadow, records } = setup([...initial.slice(0, 2), initial[3]!, speak(5)], classify)
  shadow.observe(5); await shadow.close()
  expect(records[0]?.status).toBe('AUDIT_FAILED')
  expect(classify).not.toHaveBeenCalled()
})

it('bounds queued work and records the exact skipped interval', async () => {
  const { shadow, records } = setup([...initial, ...Array.from({ length: 34 }, (_, index) => speak(index + 5))], async () => answer('NO_CLAIM'))
  for (let seq = 5; seq <= 38; seq++) shadow.observe(seq)
  expect(shadow.stats()).toMatchObject({ pendingWindows: 32, skippedWindows: 2 })
  await shadow.close()
  expect(records).toHaveLength(33)
  expect(records.at(-1)).toMatchObject({ status: 'QUEUE_SKIPPED', preHeadSeq: 36, postHeadSeq: 38 })
})

it('a broken log sink cannot reject close or escape through the error observer', async () => {
  const shadow = new JevShadow({ address, characters, items, initialSeq: 4,
    readEvents: () => [...initial, speak(5)], classify: async () => answer('NO_CLAIM'),
    write: async () => { throw new Error('disk full') }, onError: () => { throw new Error('observer broken') } })
  shadow.observe(5); await expect(shadow.close()).resolves.toBeUndefined()
  expect(shadow.stats()).toMatchObject({ records: 0, errors: 1 })
})

it('Jev request has no world holder; native response retains probabilities and usage', () => {
  const question: HolderQuestion = { item: items[0]!, items, characters,
    publication: { seq: 5, actorId: 'char:a', speech: '', narration: '钥匙由新来者保管。' } }
  const wire = holderRequest(question)
  expect(Object.keys(wire.state as object).sort()).toEqual(['characters', 'items', 'publication', 'target'])
  const fixture = answer(holderChoice('char:c'))
  const body = { model: 'typesafe/jev-live', answers: { item_holder: { type: 'choice', ...fixture } },
    usage: { input_tokens: 100, output_tokens: 10, cost: 0.00001 } }
  expect(parseHolderAnswer(body, question)).toMatchObject({ choice: holderChoice('char:c'), model: 'typesafe/jev-live', inputTokens: 100 })
  expect(() => parseHolderAnswer({ ...body, answers: { item_holder: { type: 'choice', choice: 'GROUND' } } }, question)).toThrow()
  expect(() => parseAuditItems([{ entityId: 'key', name: '钥匙' }, { entityId: 'key', name: '钥匙' }])).toThrow()
})

it('same-name item identity is undecidable even if Jev would confidently choose a holder', async () => {
  const records: ShadowRecord[] = []
  const classify = vi.fn(async () => answer(holderChoice('char:c')))
  const events = [...initial,
    event(5, 'entity.upsert', { entityId: 'item:other', kind: 'key', locationId: 'room' }), speak(6)]
  const shadow = new JevShadow({ address, characters, items: [...items, { ...items[0]!, entityId: 'item:other' }],
    initialSeq: 5, readEvents: () => events, classify, write: async row => { records.push(row) } })
  shadow.observe(6); await shadow.close()
  expect(records.map(row => row.status)).toEqual(['UNCERTAIN', 'UNCERTAIN'])
  expect(classify).not.toHaveBeenCalled()
})
