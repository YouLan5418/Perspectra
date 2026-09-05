import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type ReactionParticipantBinding,
  type RoundParticipant,
  WorldApplication,
} from '@harness-world/application'
import {
  brandId,
  hashWorldJson,
  type CharacterId,
  type ProposalContext,
  type ReactionProposalContext,
  type SubmitActionsV2,
  type WorldJsonObject,
} from '@harness-world/contracts'
import type { CompiledWorldManifestV5, CompiledWorldSpec } from '@harness-world/kernel'
import {
  RAINY_ROAD_IDS,
  adaptRainyRoadPack,
  compileRainyRoadPack,
} from '@harness-world/simulation'
import { byteHash, renderExperiment, speechProposal, speechSchema, type PromptMode } from './compact-context.ts'

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434'
const DEFAULT_MODEL = 'qwen3.5:4b'
const DEFAULT_INPUT = 'Bob，你迟到了。Alice，你怎么看？'

interface ExactRequestContext {
  readonly exactProviderRequest: {
    readonly messages: readonly { readonly role: 'system' | 'developer' | 'user'; readonly content: string }[]
  }
}

interface OllamaChatResponse {
  readonly message: { readonly content: string }
  readonly prompt_eval_count?: number
  readonly eval_count?: number
  readonly total_duration?: number
}

interface CallEvidence {
  readonly promptMode: PromptMode
  readonly sourceMessagesHash: string
  readonly inputBytes: number
  readonly participantId: string
  readonly phase: 'root' | 'reaction'
  readonly wave: number | null
  readonly durationMs: number
  readonly promptTokens: number | null
  readonly outputTokens: number | null
  readonly decision: string
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function localEndpoint(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    || url.username !== '' || url.password !== '') {
    throw new TypeError('Ollama experiment accepts only an unauthenticated local HTTP endpoint')
  }
  return url
}

function exactRequest(context: ProposalContext | ReactionProposalContext): ExactRequestContext['exactProviderRequest'] {
  const candidate = context as unknown as Partial<ExactRequestContext>
  if (candidate.exactProviderRequest === undefined || !Array.isArray(candidate.exactProviderRequest.messages)) {
    throw new TypeError('Ollama experiment requires the final Phase 8 exactProviderRequest')
  }
  return candidate.exactProviderRequest
}

class ExperimentalOllamaProvider {
  readonly evidence: CallEvidence[] = []

  constructor(
    readonly participantId: string,
    readonly actorId: CharacterId,
    private readonly endpoint: URL,
    private readonly model: string,
    private readonly promptMode: PromptMode,
    private readonly evidenceDirectory: string,
  ) {}

  async propose(context: ProposalContext | ReactionProposalContext): Promise<SubmitActionsV2> {
    const request = exactRequest(context)
    const reaction = 'origin' in context && context.origin.kind === 'reaction' ? context.origin : undefined
    const actionId = `action:ollama:${this.actorId}:${context.roundId}`
    const rendered = renderExperiment(request.messages, this.promptMode)
    const body = JSON.stringify({
      model: this.model, stream: false, think: false,
      messages: rendered.messages, format: speechSchema,
      options: { temperature: 0.3, seed: 42, num_predict: 256 }, keep_alive: '10m',
    })
    const evidenceId = byteHash(`${this.participantId}:${context.roundId}`).slice(7)
    // Manual experiment evidence only, outside the production receipt/hash contract.
    writeFileSync(resolve(this.evidenceDirectory, `${evidenceId}.request.json`), JSON.stringify({
      participantId: this.participantId, roundId: context.roundId,
      upstreamMessages: request.messages, ...rendered,
      wireBody: body, wireBodyHash: byteHash(body),
    }, null, 2), { flag: 'wx' })
    const startedAt = performance.now()
    const response = await fetch(new URL('/api/chat', this.endpoint), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`)
    const raw = record(await response.json(), 'Ollama response') as unknown as OllamaChatResponse
    const proposal = record(JSON.parse(raw.message.content) as unknown, 'Ollama structured output')
    writeFileSync(resolve(this.evidenceDirectory, `${evidenceId}.response.json`), JSON.stringify(raw, null, 2), { flag: 'wx' })
    this.evidence.push({
      promptMode: this.promptMode,
      sourceMessagesHash: rendered.sourceMessagesHash,
      inputBytes: Buffer.byteLength(body),
      participantId: this.participantId,
      phase: reaction === undefined ? 'root' : 'reaction',
      wave: reaction?.wave ?? null,
      durationMs: Math.round(performance.now() - startedAt),
      promptTokens: raw.prompt_eval_count ?? null,
      outputTokens: raw.eval_count ?? null,
      decision: typeof proposal.decision === 'string' ? proposal.decision : 'invalid',
    })
    return speechProposal(proposal, this.actorId, actionId)
  }
}

function responsive(compiled: CompiledWorldSpec): CompiledWorldSpec {
  const manifest: CompiledWorldManifestV5 = {
    ...compiled.manifest,
    schemaVersion: 5,
    reactionPolicy: {
      version: 'reaction-policy/v1',
      mode: 'responsive',
      profile: 'responsive/v1',
    },
  } as CompiledWorldManifestV5
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = compiled.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { ...(event.data as WorldJsonObject), manifestHash } }
    : event)
  return {
    manifest,
    manifestHash,
    genesisEvents,
    genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
  }
}

function roundBinding(
  participantId: string,
  actorId: CharacterId,
  priority: number,
  provider: ExperimentalOllamaProvider,
): RoundParticipant {
  return {
    participantId, role: 'agent', actorId, allowedActionTypes: ['speak'], priority,
    estimatedTokens: 1, timeoutMs: 120_000, provider,
  }
}

function reactionBinding(
  participantId: string,
  actorId: CharacterId,
  priority: number,
  provider: ExperimentalOllamaProvider,
): ReactionParticipantBinding {
  return {
    participantId, role: 'agent', actorId, allowedActionTypes: ['speak'], priority,
    estimatedTokens: 1, timeoutMs: 120_000, provider,
  }
}

function userInput(argv: readonly string[]): string {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  return args.join(' ').trim() || DEFAULT_INPUT
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

async function main(): Promise<void> {
  const endpoint = localEndpoint(process.env.HCW_OLLAMA_ENDPOINT ?? DEFAULT_ENDPOINT)
  const model = process.env.HCW_OLLAMA_MODEL?.trim() || DEFAULT_MODEL
  const input = userInput(process.argv.slice(2))
  const mode = process.env.HCW_OLLAMA_PROMPT ?? 'compact'
  if (mode !== 'full' && mode !== 'compact') throw new TypeError('HCW_OLLAMA_PROMPT must be full or compact')
  const dataDirectory = resolve('.tmp', `ollama-qwen35-4b-${timestamp()}`)
  mkdirSync(dataDirectory, { recursive: true })
  const evidenceDirectory = resolve(dataDirectory, 'requests')
  mkdirSync(evidenceDirectory)

  const address = {
    tenantId: brandId('tenant:ollama-experiment', 'TenantId'),
    worldId: brandId('world:rainy-road-ollama', 'WorldId'),
    branchId: brandId('branch:main', 'BranchId'),
  }
  const pack = await compileRainyRoadPack()
  const compiled = responsive(adaptRainyRoadPack(pack, address))
  const alice = new ExperimentalOllamaProvider('agent:alice', RAINY_ROAD_IDS.alice, endpoint, model, mode, evidenceDirectory)
  const bob = new ExperimentalOllamaProvider('agent:bob', RAINY_ROAD_IDS.bob, endpoint, model, mode, evidenceDirectory)
  const application = new WorldApplication({
    worldPath: resolve(dataDirectory, 'world.sqlite'),
    sessionPath: resolve(dataDirectory, 'session.sqlite'),
    memoryPath: resolve(dataDirectory, 'memory.sqlite'),
    contextPath: resolve(dataDirectory, 'context.sqlite'),
    modelBudgetTokens: 64,
    leaseTtlMs: 180_000,
    participants: () => [
      roundBinding('agent:alice', RAINY_ROAD_IDS.alice, 2, alice),
      roundBinding('agent:bob', RAINY_ROAD_IDS.bob, 1, bob),
    ],
    reactionParticipants: () => [
      reactionBinding('agent:alice', RAINY_ROAD_IDS.alice, 2, alice),
      reactionBinding('agent:bob', RAINY_ROAD_IDS.bob, 1, bob),
    ],
  })

  try {
    application.activate(compiled)
    const root = await application.submitText(address, {
      text: input,
      idempotencyKey: 'ollama:round:1',
      principalId: RAINY_ROAD_IDS.principal,
      correlationId: 'ollama:round:1',
    })
    const reaction = await application.processReactionCycles(address)
    const events = await application.eventHistory(address)
    const transcript = events
      .filter(event => event.eventType === 'character.speak')
      .map(event => {
        const data = event.data as WorldJsonObject
        return { seq: event.seq, characterId: data.characterId, text: data.text }
      })
    const cycles = await application.listReactionCycles(address)
    const head = await application.head(address)
    const result = {
      experiment: 'ollama-qwen35-4b/rainy-road/v2',
      promptMode: mode,
      model,
      endpoint: endpoint.origin,
      dataDirectory,
      input,
      root,
      reaction,
      cycles,
      head,
      transcript,
      providerCalls: [...alice.evidence, ...bob.evidence]
        .sort((left, right) => left.phase.localeCompare(right.phase)
          || (left.wave ?? 0) - (right.wave ?? 0)
          || left.participantId.localeCompare(right.participantId)),
      caveat: 'Experimental adapter: Ollama model/sampling/format are not yet represented by the durable Provider Model Profile.',
    }
    writeFileSync(resolve(dataDirectory, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' })
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await application.close()
  }
}

await main()
