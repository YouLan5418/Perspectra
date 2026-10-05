import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { openActionWorld, setupRead, actionContext, actionResult, evidenceDecision, staffText } from '../experiments/notice-board-action-fixture.ts'
import { bringSecondBoard, secondBoardId } from '../experiments/notice-board-conflict-fixture.ts'
import { npc } from '../experiments/notice-board-fixture.ts'
import { privateText } from '../experiments/notice-board-capability.ts'
import { rawHistorySnapshot, deliverRawHistory, historyBytes } from '../experiments/raw-history-delivery.ts'
const clean: (() => void)[] = []
afterEach(() => { for (const close of clean.splice(0).reverse()) close() })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'raw-history-'))
  clean.push(() => rmSync(dir, { recursive: true, force: true }))
  const f = openActionWorld(dir); clean.push(f.close)
  await setupRead(f, 'entity:hall-board'); await bringSecondBoard(f); await setupRead(f, secondBoardId)
  await new PrototypeCharacterTurn({ ...f, rulebooks: f.rules, projectContext: actionContext, executionResult: actionResult,
    decide: async () => evidenceDecision() }).run(npc, { maxCalls: 1 })
  for (let i = 0; i < 6; i++) await f.submitPlayer('聊聊电影。', 'gap-' + i)
  let request: PrototypeTurnRequest | undefined
  await new PrototypeCharacterTurn({ ...f, rulebooks: f.rules, projectContext: actionContext, executionResult: actionResult,
    recentObservations: 4, recentSelfObservations: 4, decide: async r => { request = r; return { decision: 'abstain' } } }).run(npc, { maxCalls: 1 })
  return { f, request: request!, snapshot: rawHistorySnapshot(f) }
}
it('naturally delivers opposing boards and attributed staff speech with no cognition or private evidence', async () => {
  const { f, request, snapshot } = await fixture(), before = f.store.head(f.address)
  const result = deliverRawHistory(snapshot, request, 24000), text = JSON.stringify(result.memories)
  expect(text).toContain('登记处：二楼203'); expect(text).toContain('登记处：一楼105'); expect(text).toContain(staffText)
  expect(text).toContain('reported_speech'); expect(text).not.toContain(privateText)
  expect(result.trace.semanticCalls).toBe(0); expect(result.trace.observationBodiesDelivered).toBe(false)
  expect(result.trace.delivered.every(r => r.sourceRef.sourceHash)).toBe(true)
  expect(result.memories.every(m => m.memoryLevel === 'source')).toBe(true)
  expect(f.store.head(f.address)).toEqual(before)
})
it('does not treat the observer or self actor as a universal association', async () => {
  const { request, snapshot } = await fixture()
  const unrelated: WorldJsonObject = { ...snapshot.sources[0]!, sourceId: 'unrelated', worldSeq: 0, knownTick: 0,
    text: '自己的旧表达', content: { actorId: npc, description: '自己的旧表达' } }
  const result = deliverRawHistory({ ...snapshot, sources: [...snapshot.sources, unrelated] }, request, 24000)
  expect(result.memories.some(m => (m.sourceIds as string[]).includes('unrelated'))).toBe(false)
  expect(result.trace.excluded).toContainEqual({ sourceId: 'unrelated', reason: 'no-explicit-association' })
})
it('budgets complete Sources, uses chronological order, reports omissions and deduplicates source IDs', async () => {
  const { request, snapshot } = await fixture()
  const full = deliverRawHistory(snapshot, request, 24000)
  const small = deliverRawHistory({ ...snapshot, sources: [...snapshot.sources, snapshot.sources[0]!] }, request, 700)
  expect(historyBytes(small.memories)).toBeLessThanOrEqual(700)
  expect(small.trace.omittedSourceIds.length).toBeGreaterThan(0); expect(small.trace.complete).toBe(false)
  for (const m of small.memories) expect(full.memories).toContainEqual(m)
  const seqs = small.memories.map(m => Number(m.worldSeq)); expect(seqs).toEqual(seqs.toSorted((a, b) => a - b))
  expect(new Set(small.memories.flatMap(m => m.sourceIds as string[])).size).toBe(small.memories.length)
})
it.each(['character', 'world', 'sequence', 'time', 'duplicate'])('rejects %s scope or identity violations before delivery', async kind => {
  const { request, snapshot } = await fixture(), source: Record<string, WorldJsonValue> = { ...snapshot.sources[0]! }
  if (kind === 'character') source.characterId = 'character:bob'
  if (kind === 'world') source.worldAddress = { ...snapshot.scope.worldAddress as WorldJsonObject, branchId: 'foreign' }
  if (kind === 'sequence') source.worldSeq = Number(snapshot.scope.asOfWorldSeq) + 1
  if (kind === 'time') source.knownTick = snapshot.tick + 1
  if (kind === 'duplicate') source.sourceHash = 'changed'
  expect(() => deliverRawHistory({ ...snapshot, sources: [...snapshot.sources, source] }, request, 24000)).toThrow()
})
it('does not repeat any Source already delivered in recent observations', async () => {
  const { request, snapshot } = await fixture(), result = deliverRawHistory(snapshot, request, 24000)
  expect(result.trace.recentSourceIds.length).toBeGreaterThan(0)
  expect(result.memories.flatMap(m => m.sourceIds as string[]).some(id => result.trace.recentSourceIds.includes(id))).toBe(false)
})
it('host rejects altered Source text even when event identity still matches', async () => {
  const { f } = await fixture(), sourceRows = f.sources
  f.sources = () => sourceRows().map((row, i) => i === 0 ? { ...row, text_value: 'forged source text' } : row)
  expect(() => rawHistorySnapshot(f)).toThrow('Source text or epistemic kind changed')
})
it('uses an explicit addressee relation for older self speech without admitting unrelated self expressions', async () => {
  const { request, snapshot } = await fixture()
  const ownSpeech: WorldJsonObject = { ...snapshot.sources[0]!, sourceId: 'old-own-speech', worldSeq: 0, knownTick: 0,
    text: 'character:npc said: 之前谈过的事情', epistemicKind: 'reported_speech',
    content: { speech: { characterId: npc, text: '之前谈过的事情', addresseeIds: ['character:player'] } } }
  const result = deliverRawHistory({ ...snapshot, sources: [...snapshot.sources, ownSpeech] }, request, 24000)
  expect(result.memories.some(m => (m.sourceIds as string[]).includes('old-own-speech'))).toBe(true)
})
