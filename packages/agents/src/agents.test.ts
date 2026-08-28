import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  hashWorldJson,
  type AgentProvider,
  type CharacterView,
  type ProposalContext,
  type WorldAddress,
} from '@harness-world/contracts'
import { ContextAssembler } from './context.ts'
import { DirectorScheduler } from './director.ts'
import {
  DisabledHarnessBridge,
  HarnessAgentProvider,
  ModelBudgetLedger,
  SafeAgentRunner,
  type HarnessAgentPort,
  type ModelProfile,
} from './model.ts'
import { ModelReplayStore } from './replay.ts'
import { SubmitActionsValidator, type SubmitActionsAuthorization } from './submit-actions.ts'

const directories: string[] = []

function database(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-agents-'))
  directories.push(directory)
  return join(directory, 'replay.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function address(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:agent', 'TenantId'),
    worldId: brandId('world:agent', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

const characterId = brandId('character:agent', 'CharacterId')
const roundId = brandId('round:agent', 'InteractionRoundId')

function characterView(): CharacterView {
  const base = {
    address: address(),
    characterId,
    asOfWorldSeq: 1,
    lifecycleState: 'active' as const,
    locationId: 'location:room',
    scenes: [],
    observations: [],
    selfObservations: [],
    claims: [],
    goals: [],
    visibility: [],
  }
  return { ...base, bundleHash: hashWorldJson('world-character-view', base) }
}

function proposalContext(): ProposalContext {
  return {
    address: address(),
    roundId,
    tick: 1,
    playerAction: { actionId: 'action:player', actorId: characterId, actionType: 'speak', actionVersion: 1, parameters: { text: 'hi' } },
    candidateHash: hashWorldJson('candidate', 1),
  }
}

const profile: ModelProfile = {
  profileId: 'profile:test', version: 1, privacyClass: 'local', maxInputTokens: 100, maxOutputTokens: 20,
}

const authorization: SubmitActionsAuthorization = {
  participantId: 'participant:agent',
  actorId: characterId,
  allowedActionTypes: ['move', 'speak'],
  maxActions: 2,
  correlationId: 'submit-actions-test',
}

function validPayload() {
  return {
    schemaVersion: 1,
    participantId: 'participant:agent',
    actions: [{ actionId: 'action:1', actorId: characterId, actionType: 'move', actionVersion: 1, parameters: { locationId: 'location:next' } }],
  }
}

describe('ContextAssembler', () => {
  it('builds a stable least-privilege context and rejects scope drift', () => {
    const assembler = new ContextAssembler()
    const input = {
      address: address(), roundId, participantId: 'participant:agent', characterView: characterView(),
      playerAction: proposalContext().playerAction,
      capability: { actorId: characterId, allowedActionTypes: ['speak', 'move'] },
    }
    const assembled = assembler.assemble(input)
    expect(assembled.capability.allowedActionTypes).toEqual(['move', 'speak'])
    expect(assembler.assemble(input).contextHash).toBe(assembled.contextHash)
    expect(() => assembler.assemble({ ...input, address: address('other') })).toThrow('address')
    expect(() => assembler.assemble({ ...input, capability: { ...input.capability, actorId: 'character:other' } })).toThrow('character')
    expect(() => assembler.assemble({ ...input, participantId: ' padded ' })).toThrow('participantId')
    expect(() => assembler.assemble({ ...input, capability: { ...input.capability, allowedActionTypes: [] } })).toThrow('non-empty')
    expect(() => assembler.assemble({ ...input, capability: { ...input.capability, allowedActionTypes: ['move', 'move'] } })).toThrow('unique')
  })
})

describe('SubmitActionsValidator', () => {
  it('accepts one authorized tool result and rejects every untrusted boundary', () => {
    const validator = new SubmitActionsValidator()
    expect(validator.validate(validPayload(), authorization)).toMatchObject({ participantId: 'participant:agent', actions: [{ actionId: 'action:1' }] })
    const invalid: Array<{ payload: unknown; auth?: SubmitActionsAuthorization }> = [
      { payload: null },
      { payload: { ...validPayload(), extra: true } },
      { payload: { ...validPayload(), schemaVersion: 2 } },
      { payload: { ...validPayload(), participantId: 'other' } },
      { payload: { ...validPayload(), actions: {} } },
      { payload: validPayload(), auth: { ...authorization, maxActions: -1 } },
      { payload: validPayload(), auth: { ...authorization, maxActions: 1.5 } },
      { payload: { ...validPayload(), actions: [...validPayload().actions, ...validPayload().actions, ...validPayload().actions] } },
      { payload: { ...validPayload(), actions: [null] } },
      { payload: { ...validPayload(), actions: [{ ...validPayload().actions[0], extra: true }] } },
      { payload: { ...validPayload(), actions: [{ ...validPayload().actions[0], actionId: '' }] } },
      { payload: { ...validPayload(), actions: [{ ...validPayload().actions[0], actorId: 'character:other' }] } },
      { payload: { ...validPayload(), actions: [{ ...validPayload().actions[0], actionType: 'delete-world' }] } },
      { payload: { ...validPayload(), actions: [{ ...validPayload().actions[0], actionVersion: 2 }] } },
      { payload: { ...validPayload(), actions: [{ ...validPayload().actions[0], parameters: undefined }] } },
      { payload: { ...validPayload(), actions: [validPayload().actions[0], { ...validPayload().actions[0] }] } },
    ]
    for (const value of invalid) {
      expect(() => validator.validate(value.payload, value.auth ?? authorization)).toThrowError(expect.objectContaining({
        envelope: expect.objectContaining({ errorCode: 'MODEL_SCHEMA_INVALID' }),
      }))
    }
    const hostile = new Proxy({}, { ownKeys() { throw 'non-error failure' } })
    expect(() => validator.validate(hostile, authorization)).toThrow('unknown submit_actions')
  })
})

describe('Harness port, budget, and failure containment', () => {
  it('keeps the Harness bridge disabled by default and validates injected port output', async () => {
    await expect(new DisabledHarnessBridge().submitActions({ profile, context: proposalContext() }))
      .rejects.toMatchObject({ envelope: { errorCode: 'MODEL_PROVIDER_FAILED' } })
    const port: HarnessAgentPort = { submitActions: async () => validPayload() }
    const provider = new HarnessAgentProvider(port, profile, new SubmitActionsValidator(), authorization)
    await expect(provider.propose(proposalContext())).resolves.toMatchObject({ actions: [{ actionType: 'move' }] })
  })

  it('reserves stably, settles actual use, and rejects reservation corruption', () => {
    expect(() => new ModelBudgetLedger(-1)).toThrow(RangeError)
    expect(() => new ModelBudgetLedger(1.5)).toThrow(RangeError)
    const ledger = new ModelBudgetLedger(10)
    expect(() => ledger.reserve('', 1)).toThrow(TypeError)
    expect(() => ledger.reserve('call:bad', 0)).toThrow(RangeError)
    const first = ledger.reserve('call:1', 6)!
    expect(ledger.reserve('call:1', 6)).toEqual(first)
    expect(() => ledger.reserve('call:1', 5)).toThrow('another budget')
    expect(ledger.reserve('call:2', 5)).toBeUndefined()
    expect(ledger.remainingTokens).toBe(4)
    expect(() => ledger.settle('missing', 1)).toThrow('unknown')
    expect(() => ledger.settle('call:1', 7)).toThrow(RangeError)
    expect(() => ledger.settle('call:1', -1)).toThrow(RangeError)
    ledger.settle('call:1', 4)
    expect(ledger.remainingTokens).toBe(6)
  })

  it('returns empty proposals for budget exhaustion, provider errors, invalid deadlines, and timeout', async () => {
    const context = proposalContext()
    const success: AgentProvider = { propose: async () => ({ participantId: 'participant:agent', actions: [] }) }
    const failure: AgentProvider = { propose: async () => { throw new Error('provider failed') } }
    const never: AgentProvider = { propose: async () => new Promise(() => undefined) }
    const budget = new ModelBudgetLedger(10)
    const runner = new SafeAgentRunner(budget)
    await expect(runner.propose('call:success', 2, 100, 'participant:agent', success, context))
      .resolves.toMatchObject({ status: 'proposed' })
    await expect(runner.invoke('call:raw', 2, 100, success, context))
      .resolves.toEqual({ status: 'proposed', output: { participantId: 'participant:agent', actions: [] } })
    let dispatched = false
    await expect(runner.invoke('call:hook', 2, 100, success, context, () => { dispatched = true }))
      .resolves.toMatchObject({ status: 'proposed' })
    expect(dispatched).toBe(true)
    await expect(runner.propose('call:failure', 2, 100, 'participant:agent', failure, context))
      .resolves.toEqual({ status: 'fallback', proposal: { participantId: 'participant:agent', actions: [] }, failure: 'provider_failed' })
    await expect(runner.propose('call:deadline', 2, 0, 'participant:agent', success, context))
      .resolves.toMatchObject({ status: 'fallback', failure: 'provider_failed' })
    await expect(runner.propose('call:timeout', 2, 5, 'participant:agent', never, context))
      .resolves.toMatchObject({ status: 'fallback', failure: 'provider_timeout' })
    const exhausted = new SafeAgentRunner(new ModelBudgetLedger(0))
    await expect(exhausted.propose('call:budget', 1, 100, 'participant:agent', success, context))
      .resolves.toMatchObject({ status: 'fallback', failure: 'budget_exhausted' })
    await expect(exhausted.invoke('call:raw-budget', 1, 100, success, context))
      .resolves.toEqual({ status: 'fallback', failure: 'budget_exhausted' })
  })
})

describe('DirectorScheduler and ModelReplayStore', () => {
  it('selects authorized Directors deterministically', () => {
    const scheduler = new DirectorScheduler()
    const candidates = [
      { participantId: 'director:b', priority: 2, enabled: true, authorizedActionTypes: ['speak'] },
      { participantId: 'director:a', priority: 2, enabled: true, authorizedActionTypes: ['move'] },
      { participantId: 'director:disabled', priority: 9, enabled: false, authorizedActionTypes: ['move'] },
      { participantId: 'director:empty', priority: 9, enabled: true, authorizedActionTypes: [] },
    ]
    expect(scheduler.schedule(candidates, 1).map(value => value.participantId)).toEqual(['director:a'])
    expect(scheduler.schedule(candidates, 0)).toEqual([])
    expect(() => scheduler.schedule(candidates, -1)).toThrow(RangeError)
    expect(() => scheduler.schedule([candidates[0]!, candidates[0]!], 1)).toThrow('unique')
  })

  it('records and replays exact model calls without invoking a provider', () => {
    const store = new ModelReplayStore(database())
    const request = { contextHash: 'context:1' }
    const response = validPayload()
    expect(store.replay('call:missing', request)).toBeUndefined()
    expect(store.record('call:1', request, response)).toBe('recorded')
    expect(store.record('call:1', request, response)).toBe('already_recorded')
    expect(store.replay('call:1', request)).toEqual(response)
    expect(() => store.record('call:1', request, { changed: true })).toThrow('different request or response')
    expect(() => store.replay('call:1', { contextHash: 'context:2' })).toThrow('different request or response')
    store.close()
  })
})
