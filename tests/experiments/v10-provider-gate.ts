import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorldApplication } from '@harness-world/application'
import { brandId, interactionPackageDescription, type SubmitActionsV7, type WorldJsonObject } from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { createChatProvider, type ChatCallObservation } from '@harness-world/provider-chat'
import { WorldStore } from '@harness-world/store-sqlite'
import { adaptCompiledWorldPack, compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'

/**
 * Paid/manual experiment, deliberately not part of the automatic suite: one real model driving a frozen
 * v10 world through the protocol production offers it, over the **production adapter** - the one the web
 * entry uses, not a copy kept in step by hand.
 *
 * It sends the Host's own `exactProviderRequest` - the assembled messages and the v7 tool description - to
 * the endpoint, so what the model sees is what a world would show it, and it returns the tool payload
 * unchanged so the world's own validator and resolution judge it. The point is not a score; it is evidence
 * that a real model, given the frozen vocabulary and each definition's accepted cues, can act through
 * `interact@2` and have its expression recorded as a fact.
 *
 * Usage: DEEPSEEK_API_KEY=... node --import tsx tests/experiments/v10-provider-gate.ts [--model <id>]
 */
const packDirectory = resolve('examples/world-packs/hand-in-hand')
const endpoint = new URL('https://api.deepseek.com/chat/completions')
const modelIndex = process.argv.indexOf('--model')
const model = modelIndex === -1 ? 'deepseek-flash' : (process.argv[modelIndex + 1] ?? 'deepseek-flash')
const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
if (apiKey === undefined || apiKey.length === 0) throw new TypeError('DeepSeek credential unavailable')
const dataDirectory = resolve('.tmp', `v10-provider-gate-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`)
mkdirSync(dataDirectory, { recursive: true })

const compiled = adaptCompiledWorldPack(
  await compileWorldPackSource(packDirectory, [interactionPackageDescription(createBasicInteractionPackage())]) as CompiledWorldPackV5,
  { address: { tenantId: brandId('tenant:v10-gate', 'TenantId'), worldId: brandId('world:v10-gate', 'WorldId'),
    branchId: brandId('branch:main', 'BranchId') },
  principalId: 'principal:player', sessionId: brandId('session:v10-gate', 'SessionId') })

/** What the model saw, and what it answered, for the record. Every attempt counts, answered or not. */
const calls: ChatCallObservation[] = []
let attempts = 0
const provider = createChatProvider({ endpoint, model, apiKey, style: 'tool', timeoutMs: 60_000,
  maxOutputTokens: 2_048, onCall: observation => calls.push(observation) })

/** Every answer is written beside the request that produced it, so a failure can be read afterwards. */
async function ask(context: unknown): Promise<SubmitActionsV7> {
  attempts += 1
  const ordinal = String(attempts).padStart(3, '0')
  writeFileSync(resolve(dataDirectory, `${ordinal}.exact-request.json`),
    JSON.stringify((context as { readonly exactProviderRequest?: unknown }).exactProviderRequest, null, 2), { flag: 'wx' })
  // The Host consumes a provider failure as an availability state, so the reason is printed here: without
  // it an operator sees "the character did nothing" and has nowhere to look.
  const answer = await provider.propose(context).catch((error: unknown) => {
    console.error(`attempt ${ordinal} failed:`, error instanceof Error ? error.message : error)
    throw error
  })
  writeFileSync(resolve(dataDirectory, `${ordinal}.answer.json`), JSON.stringify(answer, null, 2), { flag: 'wx' })
  return answer as SubmitActionsV7
}

const participant = {
  participantId: 'agent:companion', role: 'agent' as const, actorId: brandId('character:companion', 'CharacterId'),
  allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 60_000,
  provider: { propose: ask },
}
const quiet = (actorId: string) => ({ participantId: `agent:${actorId}`, role: 'agent' as const,
  actorId: brandId(actorId, 'CharacterId'), allowedActionTypes: ['speak', 'move', 'interact'],
  priority: 1, estimatedTokens: 1, timeoutMs: 1_000,
  provider: { propose: async () => ({ schemaVersion: 7 as const, decision: 'abstain' as const, actions: [] }) } })

const app = new WorldApplication({ worldPath: resolve(dataDirectory, 'world.sqlite'),
  sessionPath: resolve(dataDirectory, 'session.sqlite'), memoryPath: resolve(dataDirectory, 'memory.sqlite'),
  modelBudgetTokens: 64, leaseTtlMs: 180_000, participants: () => [participant],
  reactionParticipants: () => [quiet('character:companion'), quiet('character:friend')] })

const interact = (bindingId: string, targetRef: WorldJsonObject, definitionId: string, args: WorldJsonObject = {}) => ({
  actionType: 'interact', parameters: { targetRef, bindingId, definitionRef: { id: definitionId, version: 1 }, arguments: args },
})
try {
  app.activate(compiled)
  const submit = (key: string, action: { readonly actionType: string; readonly parameters: WorldJsonObject }) =>
    app.submit(compiled.manifest.address, { idempotencyKey: key, principalId: 'principal:player',
      correlationId: `v10-gate:${key}`, action })
  // The umbrella has to be the companion's to hand on, and the invitation is what the round reacts to.
  await submit('take', interact('binding:umbrella-take', { kind: 'entity', id: 'entity:shared-umbrella' }, 'base:take'))
  await submit('hand-over', interact('binding:umbrella-give', { kind: 'entity', id: 'entity:shared-umbrella' }, 'base:give',
    { recipientId: 'character:companion' }))
  await submit('invite', { actionType: 'speak', parameters: { text: '雨小了。你要是顺手，把伞递给那边等车的人吧——递的时候笑一下。' } })
  await submit('nudge', { actionType: 'speak', parameters: { text: '（看着他，等他递过去。）' } })
} finally { await app.close() }

const store = new WorldStore(resolve(dataDirectory, 'world.sqlite'))
const events = store.readEvents(compiled.manifest.address)
store.close()
const expressions = events.filter(event => event.eventType === 'character.manifested')
  .map(event => (event.data as { readonly cues: readonly { readonly description: string }[] }).cues.map(cue => cue.description))
const accepted = events.filter(event => event.eventType === 'action.resolved')
  .filter(event => (event.data as { readonly actionType?: string }).actionType === 'interact'
    && (event.data as { readonly accepted?: boolean }).accepted === true)
const handsOver = events.filter(event => event.eventType === 'entity.transferred'
  && typeof (event.data as { readonly toHolderId?: string }).toHolderId === 'string')
const heldHands = events.filter(event => event.eventType === 'character.relation-ended').length
const outcome = {
  protocol: 'submit_actions/v7 over Manifest v10, through @harness-world/provider-chat',
  calls: calls.length,
  failures: calls.filter(call => call.status === 'failed').length,
  durationsMs: calls.map(call => call.durationMs),
  // The claim this gate exists to make: a real model addressed a frozen definition at its exact version,
  // the world accepted it, and a step it stated was recorded as a fact everyone could observe.
  acceptedFrozenSteps: accepted.length,
  expressions,
  handsOver: handsOver.map(event => (event.data as { readonly toHolderId: string }).toHolderId),
  relationEndings: heldHands,
}
writeFileSync(resolve(dataDirectory, 'outcome.json'), JSON.stringify(outcome, null, 2))
console.log(JSON.stringify({ dataDirectory, ...outcome }, null, 2))
