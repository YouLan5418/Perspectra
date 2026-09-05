import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { WorldApplication } from '@harness-world/application'
import { brandId, hashWorldJson, type CharacterId, type ProposalContext, type ReactionProposalContext,
  type WorldJsonObject } from '@harness-world/contracts'
import type { CompiledWorldManifestV5, CompiledWorldSpec } from '@harness-world/kernel'
import { RAINY_ROAD_IDS, adaptRainyRoadPack, compileRainyRoadPack } from '@harness-world/simulation'
import { byteHash, renderExperiment, speechProposal, type ExperimentMessage } from './compact-context.ts'
import { comparisonMessages, comparisonResponse } from './provider-comparison.ts'

// Manual paid experiment only. Not a production Model Profile or automatic CI test.
const inputs = [
  'Bob，你迟到了。到底发生了什么？Alice，你也说说你现在最在意什么。',
  'Alice，听了 Bob 的解释，你愿意相信他吗？Bob，请回应 Alice 的顾虑，不要只重复刚才的话。',
  '我们先一起赶车。这件事还有什么没有说清楚的？如果已经说清楚，就不必再重复催促了。',
] as const

function responsive(compiled: CompiledWorldSpec): CompiledWorldSpec {
  const manifest = { ...compiled.manifest, schemaVersion: 5,
    reactionPolicy: { version: 'reaction-policy/v1', mode: 'responsive', profile: 'responsive/v1' },
  } as CompiledWorldManifestV5
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = compiled.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { ...(event.data as WorldJsonObject), manifestHash } } : event)
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}

async function main() {
  const promptVariant = process.env.HCW_FLASH_PROMPT ?? 'ownership_clear'
  if (promptVariant !== 'ownership_clear' && promptVariant !== 'turn_taking') throw new Error('unsupported experiment prompt')
  const key = process.env.DEEPSEEK_API_KEY?.trim()
  if (!key) throw new Error('credential unavailable')
  const directory = resolve('.tmp', `flash-playthrough-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`)
  mkdirSync(directory)
  const requests = resolve(directory, 'requests')
  mkdirSync(requests)
  console.log(JSON.stringify({ directory, promptVariant, model: 'deepseek-v4-flash', maximumCalls: 30, playerTurns: inputs.length }))
  const save = (name: string, value: unknown) => writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2), { flag: 'wx' })
  const address = { tenantId: brandId('tenant:flash-experiment', 'TenantId'),
    worldId: brandId('world:rainy-road-flash', 'WorldId'), branchId: brandId('branch:main', 'BranchId') }
  const compiled = responsive(adaptRainyRoadPack(await compileRainyRoadPack(), address))
  let callCount = 0
  let stopped = false
  const deadline = Date.now() + 6 * 60_000
  const calls: unknown[] = []
  const provider = (participantId: string, actorId: CharacterId) => ({
    async propose(context: ProposalContext | ReactionProposalContext) {
      if (stopped || callCount >= 30 || Date.now() >= deadline) {
        stopped = true
        throw new Error('experiment limit reached')
      }
      const exact = (context as unknown as { exactProviderRequest?: { messages: ExperimentMessage[] } }).exactProviderRequest
      if (!exact || !Array.isArray(exact.messages)) throw new Error('exact context unavailable')
      const rendered = renderExperiment(exact.messages, 'compact')
      const messages = comparisonMessages(rendered.messages, promptVariant)
      const wireBody = JSON.stringify({ model: 'deepseek-v4-flash', messages, stream: false,
        thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, temperature: 0.3, max_tokens: 256 })
      if (Buffer.byteLength(wireBody) > 48_000) {
        stopped = true
        throw new Error('experiment input bound exceeded')
      }
      const ordinal = ++callCount // Reserve synchronously before concurrent dispatch.
      const evidenceId = String(ordinal).padStart(2, '0')
      const reaction = 'origin' in context && context.origin.kind === 'reaction' ? context.origin : null
      save(`requests/${evidenceId}.request.json`, { ordinal, promptVariant, participantId, roundId: context.roundId,
        phase: reaction ? 'reaction' : 'root', wave: reaction?.wave ?? null,
        upstreamMessages: exact.messages, ...rendered, messages,
        wireBody, wireBodyHash: byteHash(wireBody), messagesHash: byteHash(JSON.stringify(messages)) })
      const started = performance.now()
      try {
        const response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: wireBody, signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const parsed = comparisonResponse('deepseek', await response.json())
        const proposal = speechProposal(JSON.parse(parsed.content), actorId, `action:flash:${actorId}:${context.roundId}`)
        const evidence = { ordinal, participantId, roundId: context.roundId, wave: reaction?.wave ?? null,
          durationMs: Math.round(performance.now() - started), status: 'valid', ...parsed, proposal }
        save(`requests/${evidenceId}.response.json`, evidence)
        calls.push(evidence)
        console.log(JSON.stringify({ ordinal, participantId, wave: reaction?.wave ?? null, status: 'valid' }))
        return proposal
      } catch {
        stopped = true // No retry or additional player turn after an ambiguous/invalid response.
        const failure = { ordinal, participantId, status: 'failed_or_ambiguous', retryAttempted: false }
        save(`requests/${evidenceId}.failure.json`, failure)
        calls.push(failure)
        throw new Error('Flash experiment call failed; vendor error body suppressed')
      }
    },
  })
  const participants = [
    { participantId: 'agent:alice', actorId: RAINY_ROAD_IDS.alice, priority: 2 },
    { participantId: 'agent:bob', actorId: RAINY_ROAD_IDS.bob, priority: 1 },
  ].map(binding => ({ ...binding, role: 'agent' as const, allowedActionTypes: ['speak'],
    estimatedTokens: 1, timeoutMs: 35_000, provider: provider(binding.participantId, binding.actorId) }))
  const openApplication = () => new WorldApplication({
    worldPath: resolve(directory, 'world.sqlite'), sessionPath: resolve(directory, 'session.sqlite'),
    memoryPath: resolve(directory, 'memory.sqlite'), contextPath: resolve(directory, 'context.sqlite'),
    modelBudgetTokens: 64, leaseTtlMs: 180_000,
    participants: () => participants, reactionParticipants: () => participants,
  })
  const request = (index: number) => ({ text: inputs[index]!, idempotencyKey: `flash:turn:${index + 1}`,
    principalId: RAINY_ROAD_IDS.principal, correlationId: `flash:turn:${index + 1}` })
  const app = openApplication()
  let finalHead: Awaited<ReturnType<WorldApplication['head']>>
  let completedTurns = 0
  try {
    app.activate(compiled)
    for (let index = 0; index < inputs.length; index++) {
      if (stopped || Date.now() >= deadline) break
      const before = await app.head(address)
      const root = await app.submitText(address, request(index))
      const reaction = stopped ? null : await app.processReactionCycles(address)
      const transcript = (await app.eventHistory(address))
        .filter(event => event.seq > before.headSeq && event.eventType === 'character.speak')
        .map(event => ({ seq: event.seq, ...(event.data as WorldJsonObject) }))
      const turn = { turn: index + 1, input: inputs[index], root, reaction,
        head: await app.head(address), cycles: await app.listReactionCycles(address), transcript, callCount, stopped }
      save(`turn-${index + 1}.json`, turn)
      console.log(JSON.stringify(turn))
      completedTurns++
    }
    finalHead = await app.head(address)
    save('summary.json', { model: 'deepseek-v4-flash', promptVariant, completedTurns, callCount, stopped, finalHead, calls,
      caveat: 'Experimental wire adapter; production profile still scripted; no Reflection; raw evidence stays local.' })
  } finally { await app.close() }
  if (stopped || completedTurns !== inputs.length) throw new Error('experiment incomplete')
  const restarted = openApplication()
  try {
    const countBefore = callCount
    for (let index = 0; index < inputs.length; index++) await restarted.submitText(address, request(index))
    assert.deepEqual(await restarted.head(address), finalHead)
    assert.equal(callCount, countBefore)
    save('restart-replay.json', { status: 'passed', replayedInputs: inputs.length, newProviderCalls: callCount - countBefore, head: finalHead })
    console.log(JSON.stringify({ restartReplay: 'passed', newProviderCalls: 0, directory }))
  } finally { await restarted.close() }
}

try { await main() } catch { console.error('Flash playthrough stopped; inspect local evidence. Credentials/vendor errors suppressed.'); process.exitCode = 1 }
