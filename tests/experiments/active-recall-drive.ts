import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { brandId, hashWorldJson, RECALL_KEYWORD_TOKENIZER_ID, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry, currentEntityState } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { createChatProvider } from '@harness-world/provider-chat'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { frozenInteractionWorld, basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'

const root = resolve(process.argv[2] ?? '')
if (!process.argv[2] || existsSync(root)) throw new Error('provide a new output directory')
if (process.argv.includes('--offscreen-drop') && !process.argv.includes('--away')) {
  throw new Error('--offscreen-drop requires --away')
}
const model = process.env.HCW_LOCAL_MODEL?.trim() || 'gemini-3.7-flash'
const endpoint = process.env.HCW_LOCAL_ENDPOINT?.trim() || 'http://127.0.0.1:8045/v1/chat/completions'
const apiKey = process.env.HCW_LOCAL_API_KEY?.trim()
const hideSourceAge = process.argv.includes('--hide-source-age')
const ageTicks = process.argv.includes('--age-twenty-ticks') ? 20
  : process.argv.includes('--age-two-ticks') ? 2 : 0
if (hideSourceAge && ageTicks === 0) throw new Error('--hide-source-age requires an age tick option')
const currentQuestion = process.argv.includes('--current-question')
if (currentQuestion && ageTicks === 0) throw new Error('--current-question requires an age tick option')
const sourceAgeInstruction = '记忆的 sourceAgeTicks 是其最新来源距当前的轮次差，不是现实时间；听到转述的轮次也不证明转述之事发生于那时，旧记录不自动代表现状。'
mkdirSync(root, { recursive: true })
const provider = createChatProvider({ endpoint: new URL(endpoint), model,
  ...(apiKey === undefined ? {} : { apiKey }),
  toolName: 'character_decision', timeoutMs: 60_000 })
const npc = brandId('character:npc', 'CharacterId')
const bob = brandId('character:bob', 'CharacterId')
const player = brandId('character:player', 'CharacterId')
const observation = (id: string, observerId: string, content: WorldJsonObject): WorldEventDraft => ({
  eventType: 'observation.upsert', eventVersion: 1, data: { id, value: { observerId, content } },
})
const prompts = currentQuestion ? [
  '那只杯子现在还在鲍勃手里吗？我听他说已经交给我了。',
] : process.argv.includes('--indirect') ? [
  '你刚才听到的说法和你自己看到的好像不一样。能先翻一下旧经历，再告诉我你亲眼看到的是什么吗？',
] : process.argv.includes('--opaque') ? [
  '上次从桌上被拿走的那件东西究竟到了谁手里？我听到不同说法。你可以先核对自己的旧经历。',
] : [
  '你还记得那只杯子最初是谁保管的吗？我听到不同说法，你怎么想？',
  '关于那只杯子，我听到相反说法。你能先核对自己的旧经历，再说你记得谁说过什么吗？',
]
writeFileSync(resolve(root, 'protocol.json'), JSON.stringify({ prompts, model,
  realModel: true, noForcedRecall: true, offscreenDrop: process.argv.includes('--offscreen-drop'),
  ageTicks, hideSourceAge, currentQuestion,
  cases: 'same contradictory authorized evidence, only question changes' }, null, 2))
const summaries = []
for (const [index, prompt] of prompts.entries()) {
  const dir = resolve(root, `case-${index + 1}`)
  mkdirSync(dir)
  const path = resolve(dir, 'world.sqlite')
  const store = new WorldStore(path), leases = new WriterLeaseService(path)
  const availability = new CharacterRuntimeAvailabilityService(path)
  let memory: CognitiveMemoryService | undefined
  try {
    const world = frozenInteractionWorld()
    const transfer: WorldEventDraft = { eventType: 'entity.transferred', eventVersion: 1, data: {
      entityId: 'entity:cup', characterId: bob, interactionId: 'base:take',
      fromHolderId: null, fromLocationId: 'location:room', toHolderId: bob, toLocationId: null } }
    const away: WorldEventDraft[] = process.argv.includes('--away') ? [{ eventType: 'character.moved', eventVersion: 1,
      data: { characterId: bob, fromLocationId: 'location:room', toLocationId: 'location:next' } }] : []
    const offscreenDrop: WorldEventDraft[] = process.argv.includes('--offscreen-drop')
      ? [{ eventType: 'entity.transferred', eventVersion: 1, data: {
        entityId: 'entity:cup', characterId: bob, interactionId: 'base:drop',
        fromHolderId: bob, fromLocationId: null, toHolderId: null, toLocationId: 'location:next' } }]
      : []
    const questionEvent = observation('observation:current-question', npc, { actorId: player,
      actionType: 'speak', status: 'accepted', speech: { characterId: player, text: prompt } })
    const events = [...world.genesisEvents, transfer,
      observation('observation:actual-transfer', npc, { actorId: bob, actionType: 'interact', status: 'accepted',
        interaction: transfer.data, resultDescription: '鲍勃取得了杯子的保管。' }),
      observation('observation:false-report', npc, { actorId: bob, actionType: 'speak', status: 'accepted',
        speech: { characterId: bob, text: '我早把杯子交给玩家了。' } }),
      observation('observation:private-other', bob, { actorId: player, actionType: 'speak', status: 'accepted',
        speech: { characterId: player, text: '只对鲍勃说：密码是深海灯。' } }),
      ...away, ...offscreenDrop,
      ...Array.from({ length: 18 }, (_, n) => observation(`observation:filler-${n}`, npc,
        { actorId: player, actionType: 'speak', status: 'accepted',
          speech: { characterId: player, text: `今天雨还没停，我们已经等了${n + 1}分钟。` } })),
      ...(currentQuestion ? [] : [questionEvent]),
    ]
    store.activateBranch({ ...world, genesisEvents: events, genesisHash: hashWorldJson('world-genesis-plan', events),
      address: world.manifest.address, transactionId: brandId(`transaction:active-recall:${index}`, 'TransactionId'),
      roundId: brandId(`round:active-recall:${index}`, 'InteractionRoundId'), correlationId: 'active-recall-playtest' })
    if (ageTicks > 0) {
      for (let tick = 1; tick <= ageTicks; tick += 1) {
        const head = store.head(world.manifest.address)
        const roundId = brandId('round:active-recall-age:' + index + ':' + tick, 'InteractionRoundId')
        await store.commitRound({ address: world.manifest.address,
          transactionId: brandId('transaction:active-recall-age:' + index + ':' + tick, 'TransactionId'),
          roundId, expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1,
          events: [{ eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: head.tick + 1, roundId } },
            ...(currentQuestion && tick === ageTicks ? [questionEvent] : [])],
          outbox: [], correlationId: 'active-recall-age:' + index + ':' + tick,
        })
      }
    }
    memory = new CognitiveMemoryService(resolve(dir, 'memory.sqlite'), store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
    const requests: unknown[] = [], decisions: unknown[] = []
    const before = store.head(world.manifest.address).headSeq
    const turn = new PrototypeCharacterTurn({ address: world.manifest.address, store, memory, leases, availability,
      rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }),
      decide: async (request, signal) => {
        const visibleRequest = hideSourceAge ? JSON.parse(JSON.stringify(request, (key, value) =>
          key === 'sourceAgeTicks' ? undefined : value)) as PrototypeTurnRequest : request
        requests.push(visibleRequest)
        const call = localPrototypeTurnCall(visibleRequest)
        if (hideSourceAge && !call.messages[0]?.content.includes(sourceAgeInstruction)) throw new Error('missing source age instruction')
        const modelCall = hideSourceAge ? { ...call, messages: call.messages.map(message =>
          message.role === 'system' ? { ...message, content: message.content.replace(sourceAgeInstruction, '') } : message) } : call
        const answer = await provider.decide(modelCall, signal)
        decisions.push(answer)
        return answer
      } })
    const result = await turn.run(npc, { maxCalls: 1, stimulus: [{ sourceText: prompt, actorId: player }] })
    const all = store.readEvents(world.manifest.address)
    const firstRequest = JSON.stringify(requests[0])
    const initialContext = (requests[0] as { readonly context?: {
      readonly memories?: readonly { readonly sourceMaxSeq: number }[]
      readonly observations?: readonly { readonly sourceSeq: number }[]
    } }).context
    const recallResults = requests.flatMap(request => {
      const evidence = (request as { readonly recallEvidence?: {
        readonly memories?: readonly { readonly sourceMaxSeq: number }[]
      } }).recallEvidence
      return evidence === undefined ? [] : [evidence]
    })
    const retrievedSourceSeqs = recallResults.flatMap(evidence =>
      (evidence.memories ?? []).map(memory => memory.sourceMaxSeq))
    const summary = { prompt, result, decisions,
      initialTransferDescriptionVisible: firstRequest.includes('鲍勃取得了杯子的保管'),
      initialReportTextVisible: firstRequest.includes('我早把杯子交给玩家了'),
      initialMemorySourceSeqs: initialContext?.memories?.map(memory => memory.sourceMaxSeq) ?? [],
      initialRecentSourceSeqs: initialContext?.observations?.map(record => record.sourceSeq) ?? [],
      voluntaryRecall: decisions.some(d => (d as WorldJsonObject).decision === 'recall'),
      recallResultPresent: recallResults.length > 0,
      evidenceReturned: retrievedSourceSeqs.length > 0, retrievedSourceSeqs,
      leakedOtherPrivate: JSON.stringify(requests).includes('深海灯'),
      worldUnchangedByRecall: all.filter(e => e.seq > before && e.eventType === 'entity.transferred').length === 0,
      finalHolder: currentEntityState(all, 'entity:cup')?.holderId }
    writeFileSync(resolve(dir, 'requests.json'), JSON.stringify(requests, null, 2))
    writeFileSync(resolve(dir, 'events.json'), JSON.stringify(all, null, 2))
    writeFileSync(resolve(dir, 'summary.json'), JSON.stringify(summary, null, 2))
    summaries.push(summary)
    process.stdout.write(JSON.stringify({ case: index + 1, ...summary }) + '\n')
  } finally { memory?.close(); availability.close(); leases.close(); store.close() }
}
writeFileSync(resolve(root, 'summary.json'), JSON.stringify(summaries, null, 2))
