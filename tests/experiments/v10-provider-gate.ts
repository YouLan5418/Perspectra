import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorldApplication } from '@harness-world/application'
import { brandId, interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { WorldStore } from '@harness-world/store-sqlite'
import { adaptCompiledWorldPack, compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'

/**
 * Paid/manual experiment, and deliberately not part of the automatic suite: one real model driving a
 * frozen v10 world through the protocol production offers it.
 *
 * It sends the Host's own `exactProviderRequest` - the assembled messages and the v7 tool schema - to
 * the endpoint, so what the model sees is what a world would show it, and it returns the tool payload
 * unchanged so the world's own validator and resolution judge it. The point is not a score; it is
 * evidence that a real model, given the frozen vocabulary and each definition's accepted cues, can act
 * through `interact@2` and have its expression recorded as a fact.
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

interface ExactRequest {
  readonly messages: readonly { readonly role: string; readonly content: string }[]
  readonly tools: WorldJsonObject
}
interface ToolCallResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: string | null
    readonly tool_calls?: readonly { readonly function?: { readonly name?: string; readonly arguments?: string } }[] }
  readonly finish_reason?: string }[]
  readonly usage?: WorldJsonObject
  readonly error?: WorldJsonObject
}

/** What the model saw, and what it answered, for the record. Every attempt counts, answered or not. */
const evidence: WorldJsonObject[] = []
let attempts = 0

/**
 * The wire schema a real endpoint needs. The Host's `tools` payload is a description of the contract -
 * `type: object` plus the group's policy - not a JSON Schema a model can bind to, so an adapter has to
 * render one. It is derived from what the context itself offers: the options the character may address,
 * and per definition the cues that definition accepts, which is the same list the world judges a step
 * against. Nothing here is invented by the adapter; it spells the world's own answer out.
 */
function frozenWireSchema(tools: WorldJsonObject, messages: readonly { readonly role: string; readonly content: string }[]) {
  interface Offered { readonly actionType: string; readonly interactions?: readonly WorldJsonObject[]
    readonly performances?: readonly WorldJsonObject[] }
  const offered: Offered[] = []
  for (const message of messages) {
    try {
      const segment = JSON.parse(message.content) as { readonly segmentKind?: string
        readonly content?: readonly Offered[] }
      if (segment.segmentKind === 'affordances' && Array.isArray(segment.content)) offered.push(...segment.content)
    } catch { /* a message that is not a JSON segment is prose, and prose is not an offer */ }
  }
  const interact = offered.find(entry => entry.actionType === 'interact')
  // The union, because one schema covers every option a step might address: the per-definition answer sits
  // beside each option in the context, and the world refuses a step outside the definition it addressed.
  const cues = [...new Set((interact?.performances ?? []).flatMap(entry =>
    (entry.accepted as readonly { readonly cue: string }[]).map(accepted => accepted.cue)))].sort()
  const actorId = (tools as { readonly actorId?: string }).actorId
  const actor = actorId === undefined ? {} : { const: actorId }
  const identity = { actionId: { type: 'string', minLength: 1 }, actorId: { type: 'string', ...actor } }
  const speak = { type: 'object', additionalProperties: false,
    required: ['actionId', 'actorId', 'actionType', 'actionVersion', 'parameters'],
    properties: { ...identity, actionType: { type: 'string', const: 'speak' }, actionVersion: { type: 'integer', const: 1 },
      parameters: { type: 'object', additionalProperties: false, required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: 500 } } } } }
  const option = (choice: WorldJsonObject) => ({
    type: 'object', additionalProperties: false,
    required: ['targetRef', 'bindingId', 'definitionRef', 'arguments'],
    properties: {
      targetRef: { type: 'object', additionalProperties: false, required: ['kind', 'id'],
        properties: { kind: { type: 'string', const: (choice.targetRef as WorldJsonObject).kind },
          id: { type: 'string', const: (choice.targetRef as WorldJsonObject).id } } },
      bindingId: { type: 'string', const: choice.bindingId },
      definitionRef: { type: 'object', additionalProperties: false, required: ['id', 'version'],
        properties: { id: { type: 'string', const: (choice.definitionRef as WorldJsonObject).id },
          version: { type: 'integer', const: (choice.definitionRef as WorldJsonObject).version } } },
      arguments: { type: 'object', additionalProperties: false,
        ...(Object.keys(choice.arguments as WorldJsonObject).length === 0 ? {} : {
          required: Object.keys(choice.arguments as WorldJsonObject),
          properties: Object.fromEntries(Object.entries(choice.arguments as WorldJsonObject)
            .map(([key, value]) => [key, { type: typeof value, const: value }])) }) },
    },
  })
  const steps = (interact?.interactions ?? []).map(option)
  const interactStep = { type: 'object', additionalProperties: false,
    required: ['actionId', 'actorId', 'actionType', 'actionVersion', 'parameters'],
    properties: { ...identity, actionType: { type: 'string', const: 'interact' }, actionVersion: { type: 'integer', const: 2 },
      parameters: steps.length === 1 ? steps[0] : { oneOf: steps },
      ...(cues.length === 0 ? {} : { manifestation: { type: 'object', additionalProperties: false,
        required: ['independent', 'onSuccess'],
        properties: { independent: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', enum: cues } },
          onSuccess: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', enum: cues } } } } }) } }
  const variants = interact === undefined ? [speak] : [speak, interactStep]
  return { type: 'object', additionalProperties: false, required: ['schemaVersion', 'decision', 'actions'],
    properties: { schemaVersion: { type: 'integer', const: 7 }, decision: { type: 'string', enum: ['act', 'abstain'] },
      actions: { type: 'array', maxItems: 2, items: { oneOf: variants } } } }
}

async function ask(context: unknown): Promise<import('@harness-world/contracts').SubmitActionsV7> {
  const exact = (context as { exactProviderRequest: ExactRequest }).exactProviderRequest
  // The Host's assembled context uses a `developer` segment for the character-controller contract. The
  // endpoint knows system/user/assistant/tool only, so a real adapter has to map it - and that mapping is
  // the adapter's business, not the world's: nothing about what the model is told changes.
  const messages = exact.messages.map(message => message.role === 'developer'
    ? { ...message, role: 'system' } : message)
  const schema = frozenWireSchema(exact.tools, messages)
  const body = JSON.stringify({ model, messages, stream: false, thinking: { type: 'disabled' },
    temperature: 0.3, max_tokens: 2048,
    tools: [{ type: 'function', function: { name: 'submit_actions',
      description: 'Submit exactly the actions this character takes, in the shape this schema states.',
      parameters: schema } }],
    tool_choice: { type: 'function', function: { name: 'submit_actions' } } })
  const ordinal = attempts + 1
  attempts += 1
  writeFileSync(resolve(dataDirectory, `${String(ordinal).padStart(3, '0')}.request.json`),
    JSON.stringify({ model, exactTools: exact.tools, wireSchema: schema, messages }, null, 2), { flag: 'wx' })
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body, signal: AbortSignal.timeout(60_000) })
  const parsed = await response.json() as ToolCallResponse
  writeFileSync(resolve(dataDirectory, `${String(ordinal).padStart(3, '0')}.response.json`),
    JSON.stringify(parsed, null, 2), { flag: 'wx' })
  if (!response.ok) {
    evidence.push({ ordinal, status: `HTTP ${response.status}`, error: parsed.error ?? null })
    throw new Error(`DeepSeek returned HTTP ${response.status}: ${JSON.stringify(parsed.error)}`)
  }
  const message = parsed.choices?.[0]?.message
  const raw = message?.tool_calls?.[0]?.function?.arguments ?? message?.content ?? ''
  evidence.push({ ordinal, status: 'ok', finishReason: parsed.choices?.[0]?.finish_reason ?? null,
    usage: parsed.usage ?? null, answer: raw })
  return JSON.parse(raw) as import('@harness-world/contracts').SubmitActionsV7
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
  protocol: 'submit_actions/v7 over Manifest v10',
  calls: evidence.length,
  answers: evidence.map(entry => entry.finishReason),
  // The claim this gate exists to make: a real model addressed a frozen definition at its exact version,
  // the world accepted it, and a step it stated was recorded as a fact everyone could observe.
  acceptedFrozenSteps: accepted.length,
  expressions,
  handsOver: handsOver.map(event => (event.data as { readonly toHolderId: string }).toHolderId),
  relationEndings: heldHands,
}
writeFileSync(resolve(dataDirectory, 'outcome.json'), JSON.stringify(outcome, null, 2))
console.log(JSON.stringify({ dataDirectory, ...outcome }, null, 2))
