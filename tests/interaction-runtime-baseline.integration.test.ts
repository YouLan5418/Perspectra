import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { SubmitActionsValidator } from '@harness-world/agents'
import { brandId, type WorldJsonValue } from '@harness-world/contracts'
import { currentCharacterRelations, currentEntityState, resolveManifestation } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { actionGroupWorld, groupOutput } from './fixtures/action-group-world.ts'
import { interactionWorld, interactionOutput } from './fixtures/interaction-world.ts'
import { characterInteractionWorld } from './fixtures/character-interaction-world.ts'

// I0-B captures the unmodified 6d79ed3 runtime. Only entropy inputs are fixed;
// no Event, Resolution, Authority or model-tool field is removed from the output.
vi.mock('node:crypto', async importOriginal => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  randomUUID: () => '00000000-0000-4000-8000-000000000093',
}))

function providerTools(context: unknown): WorldJsonValue {
  const request = (context as { exactProviderRequest: { tools: WorldJsonValue } }).exactProviderRequest
  expect(request).toBeDefined()
  expect(request.tools).toBeDefined()
  return request.tools
}

it.each([7, 8, 9] as const)('freezes v%s runtime events, authority, Root/Reaction tools and ownership', async version => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  const root = mkdtempSync(join(tmpdir(), 'interaction-runtime-baseline-'))
  const worldPath = join(root, 'world.sqlite')
  const compiled = version === 7 ? actionGroupWorld(true) : version === 8 ? interactionWorld(true) : characterInteractionWorld('responsive/v1')
  const calls: { lane: string; actorId: string; tools: WorldJsonValue }[] = []
  let rootCalls = 0
  const protocol = version === 7 ? 4 : 5
  const binding = (actor: string) => ({ participantId: `agent:${actor}`, role: 'agent' as const,
    actorId: brandId(`character:${actor}`, 'CharacterId'), allowedActionTypes: version === 7 ? ['speak', 'move', 'take'] : ['speak', 'move', 'interact'],
    priority: 1, estimatedTokens: 1, timeoutMs: 1000 })
  const app = new WorldApplication({ worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    participants: () => [{ ...binding('npc'), provider: { propose: async context => {
      calls.push({ lane: 'root', actorId: 'character:npc', tools: providerTools(context) })
      rootCalls++
      if (version === 7 && rootCalls === 1) return groupOutput
      if (version === 8 && rootCalls <= 2) return rootCalls === 1 ? interactionOutput() : interactionOutput('give', 'character:npc', 'entity:cup', { recipientId: 'character:player' })
      return { schemaVersion: protocol, decision: 'abstain', actions: [] }
    } } }],
    reactionParticipants: () => ['bob', 'npc'].map(actor => ({ ...binding(actor), provider: { propose: async context => {
      calls.push({ lane: 'reaction', actorId: `character:${actor}`, tools: providerTools(context) })
      return { schemaVersion: protocol, decision: 'abstain', actions: [] }
    } } })),
  })
  try {
    app.activate(compiled)
    const request = { idempotencyKey: 'first', principalId: 'principal:player', correlationId: 'golden:runtime',
      action: version === 9
        ? { actionType: 'interact', parameters: { targetId: 'character:npc', interactionId: 'core:hold-hand', arguments: {} } }
        : { actionType: 'speak', parameters: { text: 'go' } } }
    await app.submit(compiled.manifest.address, request)
    await app.submit(compiled.manifest.address, request)
    await app.processReactionCycles(compiled.manifest.address)
    if (version === 8) {
      await app.submit(compiled.manifest.address, { ...request, idempotencyKey: 'give' })
      await app.processReactionCycles(compiled.manifest.address)
      await app.submit(compiled.manifest.address, { ...request, idempotencyKey: 'drop', action: { actionType: 'interact', parameters: { targetId: 'entity:cup', interactionId: 'core:drop', arguments: {} } } })
      await app.processReactionCycles(compiled.manifest.address)
      await app.submit(compiled.manifest.address, { ...request, idempotencyKey: 'take-again', action: { actionType: 'interact', parameters: { targetId: 'entity:cup', interactionId: 'core:take', arguments: {} } } })
    }
    if (version === 9) {
      const reader = new WorldStore(worldPath)
      let relationId: string
      try { relationId = currentCharacterRelations(reader.readEvents(compiled.manifest.address))[0]!.relationId } finally { reader.close() }
      await app.submit(compiled.manifest.address, { ...request, idempotencyKey: 'release', action: { actionType: 'interact', parameters: { targetId: relationId, interactionId: 'core:release-hand', arguments: {} } } })
      await app.processReactionCycles(compiled.manifest.address)
    }
    const reader = new WorldStore(worldPath)
    try {
      const events = reader.readEvents(compiled.manifest.address)
      const transactions = [...new Set(events.filter(event => event.eventType === 'action.resolved').map(event => event.transactionId))]
      const authorities = transactions.map(transaction => reader.readRoundAuthority(compiled.manifest.address, transaction))
      expect(authorities.every(value => value !== undefined)).toBe(true)
      expect(calls.some(value => value.lane === 'root')).toBe(true)
      expect(calls.some(value => value.lane === 'reaction')).toBe(true)
      if (version === 8) expect(currentEntityState(events, 'entity:cup')?.holderId).toBe('character:player')
      if (version === 9) expect(currentCharacterRelations(events)[0]?.active).toBe(false)
      const cycles = reader.listReactionCycles(compiled.manifest.address).map(cycle => reader.readReactionCycle(compiled.manifest.address, cycle.cycleId))
      expect(cycles.length).toBeGreaterThan(0)
      expect({ events, authorities, calls, cycles }).toMatchSnapshot()
    } finally { reader.close() }
  } finally { await app.close(); clock.mockRestore(); rmSync(root, { recursive: true, force: true }) }
})

it('freezes legacy manifestation occurrence and persistent visible-state set/clear', () => {
  const base = { actorId: brandId('character:npc', 'CharacterId'), roundId: brandId('round:manifestation-golden', 'InteractionRoundId'), actionId: 'action:appearance' }
  const set = resolveManifestation({ ...base, events: [], manifestation: { cues: [{ cueId: 'wet', channel: 'appearance', description: '袖口湿了', persistence: 'until_changed', stateKey: 'appearance:sleeve', operation: 'set' }] } })
  const clearInput = { cues: [{ cueId: 'dry', channel: 'appearance' as const, description: '袖口恢复干燥', persistence: 'until_changed' as const, stateKey: 'appearance:sleeve', operation: 'clear' as const }] }
  const clear = resolveManifestation({ ...base, events: set.events, manifestation: clearInput })
  const absent = resolveManifestation({ ...base, events: [], manifestation: clearInput })
  expect(set.status).toBe('accepted')
  expect(clear.status).toBe('accepted')
  expect(absent.status).toBe('rejected')
  expect({ set, clear, absent }).toMatchSnapshot()
})

it.each([4, 5] as const)('freezes v%s normalization without changing action or cue order', version => {
  const validator = new SubmitActionsValidator()
  const authorization = { participantId: 'agent:npc', actorId: brandId('character:npc', 'CharacterId'),
    allowedActionTypes: ['speak', 'move', 'interact'], maxActions: 2, maxReflectionOperations: 0, correlationId: 'golden:normalization' }
  const payload = { schemaVersion: version, decision: 'act', actions: [{ actionId: 'z:speak', actorId: 'character:npc', actionType: 'speak', actionVersion: 1,
    parameters: { text: 'hello' }, manifestation: { independent: ['frown'], onSuccess: ['frown', 'quiet_voice'] } },
  { actionId: 'a:move', actorId: 'character:npc', actionType: 'move', actionVersion: 1, parameters: { locationId: 'location:next' }, manifestation: { independent: [], onSuccess: [] } }] }
  const validate = (value: unknown) => version === 4 ? validator.validateV4(value, authorization) : validator.validateV5(value, authorization)
  expect(validate(payload)).toMatchSnapshot()
  expect(() => validate({ ...payload, actions: [{ ...payload.actions[0], manifestation: { independent: ['frown', 'frown'], onSuccess: [] } }] })).toThrow()
})
