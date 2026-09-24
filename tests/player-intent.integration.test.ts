import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { frozenIntentWorld, intentFixtureProfile, intentFixtureResponse } from './fixtures/player-intent-world.ts'
it('takes an explicit command on a v10 world at the frozen version', async () => {
  // The explicit-command path states the action in the player's own text, so the version is not in the
  // text at all: the Host reads it from the affordance the command exercises. A v10 world's affordance is
  // `interact@2`, so the command has to become that - and the world has to accept it.
  const root = mkdtempSync(join(tmpdir(), 'player-intent-explicit-'))
  const world = frozenIntentWorld('responsive/v2')
  const path = join(root, 'world.sqlite')
  const command = `/act interact ${JSON.stringify({ targetRef: { kind: 'entity', id: 'entity:cup' },
    bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take', version: 1 }, arguments: {} })}`
  let interpreted = 0
  const app = new WorldApplication({ worldPath: path, sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    reactionParticipants: () => ['character:npc', 'character:bob'].map(actorId => ({
      participantId: `agent:${actorId}`, role: 'agent' as const, actorId: brandId(actorId, 'CharacterId'),
      allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
      provider: { propose: async () => ({ schemaVersion: 7 as const, decision: 'abstain' as const, actions: [] }) },
    })),
    playerIntent: { profile: intentFixtureProfile, dispatch: async () => {
      interpreted++
      return intentFixtureResponse
    } },
  })
  try {
    app.activate(world)
    const result = await app.submitText(world.manifest.address,
      { text: command, principalId: 'principal:player', idempotencyKey: 'explicit-frozen', correlationId: 'explicit-frozen' })
    expect(result.status).toBe('submitted')
    // An explicit command is not an interpretation: the provider is never asked.
    expect(interpreted).toBe(0)
    // The same command states how it is done, because the step is the frozen request's own optional key -
    // which is what makes the documented `/act` form and the model's step the same contract.
    const stepped = await app.submitText(world.manifest.address, { text: `/act interact ${JSON.stringify({
      targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:give',
      definitionRef: { id: 'base:give', version: 1 }, arguments: { recipientId: 'character:npc' },
      performance: { independent: ['frown'], onSuccess: ['smile'] } })}`,
      principalId: 'principal:player', idempotencyKey: 'explicit-frozen-step', correlationId: 'explicit-frozen-step' })
    expect(stepped.status).toBe('submitted')
  } finally { await app.close() }
  const store = new WorldStore(path)
  try {
    const events = store.readEvents(world.manifest.address)
    const resolved = events.find(event => event.eventType === 'action.resolved')!
    expect(resolved.data).toMatchObject({ actionType: 'interact', accepted: true, sourceRole: 'player' })
    expect(store.readRoundAuthority(world.manifest.address, resolved.transactionId)!.authority.schemaVersion).toBe(6)
    expect(events.filter(event => event.eventType === 'character.manifested')
      .map(event => (event.data as { readonly cues: readonly { readonly description: string }[] }).cues
        .map(cue => cue.description))).toEqual([['微微皱眉', '微微一笑']])
  } finally { store.close() }
  rmSync(root, { recursive: true, force: true })
})

it('interprets free text into a frozen interaction, with Authority 6 and one commit', async () => {
  // The whole interpreted path on a v10 world: the provider is offered the world's own options at the
  // version the world adjudicates them, its choice becomes an interact@2 request, and the world resolves
  // it through the frozen definition rather than a catalog entry.
  const root = mkdtempSync(join(tmpdir(), 'player-intent-frozen-'))
  const world = frozenIntentWorld('responsive/v2')
  const path = join(root, 'world.sqlite')
  const request = { text: '拿起杯子', principalId: 'principal:player', idempotencyKey: 'intent:frozen', correlationId: 'intent:frozen' }
  let calls = 0
  let shown = ''
  const app = new WorldApplication({ worldPath: path, sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    // The world is responsive, so every active non-manual character needs a binding. Both abstain: this
    // case is about the interpreted input reaching the frozen world, not about what answers it.
    reactionParticipants: () => ['character:npc', 'character:bob'].map(actorId => ({
      participantId: `agent:${actorId}`, role: 'agent' as const, actorId: brandId(actorId, 'CharacterId'),
      allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
      provider: { propose: async () => ({ schemaVersion: 7 as const, decision: 'abstain' as const, actions: [] }) },
    })),
    playerIntent: { profile: intentFixtureProfile, dispatch: async (raw: WorldJsonValue) => {
      calls++
      const offered = (raw as { body: { affordances: readonly {
        affordanceId: string; actionType: string; parameters: WorldJsonObject }[] } }).body.affordances
      shown = JSON.stringify(offered)
      // The world offers several interactions here, so the choice names the one it means rather than
      // taking the first: a refused take and an accepted hand-hold are both on the list.
      const take = offered.find(entry => entry.parameters.bindingId === 'binding:entity:cup:base:take')!
      return { version: 'player-intent-candidate/v3', decision: 'act', reason: 'none',
        actions: [{ key: 't', affordanceId: take.affordanceId, quotes: ['拿起杯子'] }] }
    } },
  })
  try {
    app.activate(world)
    const result = await app.submitText(world.manifest.address, request)
    expect(result.status).toBe('submitted')
    // What the model could pick: the frozen request shape, at the frozen version.
    expect(shown).toContain('binding:entity:cup:base:take')
    expect(shown).toContain('"actionVersion":2')
    expect(shown).toContain('"definitionRef"')
    // The world's own view decides what is attemptable, and this adapter forwards it: the cup is on the
    // floor, so putting it down was never offered and picking it up was.
    expect(shown).toContain('binding:entity:cup:base:take')
    expect(shown).not.toContain('binding:entity:cup:base:drop')
    // The same input twice is one commit, and does not ask the provider again.
    expect(await app.submitText(world.manifest.address, request)).toEqual(result)
    expect(calls).toBe(1)
  } finally { await app.close() }
  const store = new WorldStore(path)
  try {
    const events = store.readEvents(world.manifest.address)
    expect(events.filter(event => event.eventType === 'entity.transferred')).toHaveLength(1)
    const resolved = events.find(event => event.eventType === 'action.resolved')!
    expect(resolved.data).toMatchObject({ actionType: 'interact', accepted: true, sourceRole: 'player' })
    const authority = store.readRoundAuthority(world.manifest.address, resolved.transactionId)!.authority
    expect(authority.schemaVersion).toBe(6)
    expect((authority.resolutions as readonly Record<string, unknown>[])
      .some(entry => entry.interaction !== undefined)).toBe(true)
  } finally { store.close() }
  rmSync(root, { recursive: true, force: true })
})

it('asks the player again instead of dropping a cue that definition does not accept', async () => {
  // The interpreter is told what each choice accepts, so a cue outside the list is a caller that ignored
  // what it was shown. Dropping it would do something the player did not say, and failing the action would
  // refuse an interaction that is otherwise afforded - so the player is asked again, and nothing is spent.
  const root = mkdtempSync(join(tmpdir(), 'player-intent-refused-'))
  const world = frozenIntentWorld()
  const path = join(root, 'world.sqlite')
  const app = new WorldApplication({ worldPath: path, sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    playerIntent: { profile: intentFixtureProfile, dispatch: async (raw: WorldJsonValue) => {
      const offered = (raw as { body: { affordances: readonly { readonly affordanceId: string
        readonly parameters: WorldJsonObject }[] } }).body.affordances
      // The cup on the floor: taking it is afforded, but its definition accepts no expression at all.
      const take = offered.find(entry => entry.parameters.bindingId === 'binding:entity:other:base:take')!
      expect(take).not.toHaveProperty('performances')
      return { version: 'player-intent-candidate/v3', decision: 'act', reason: 'none',
        actions: [{ key: 't', affordanceId: take.affordanceId, performance: { independent: ['frown'], onSuccess: [] },
          quotes: ['拿起杯子'] }] }
    } },
  })
  let result
  try {
    app.activate(world)
    result = await app.submitText(world.manifest.address, { text: '拿起杯子', principalId: 'principal:player',
      idempotencyKey: 'refused-step', correlationId: 'refused-step' })
  } finally { await app.close() }
  expect(result).toMatchObject({ status: 'clarification_required', reason: 'not_afforded' })
  const store = new WorldStore(path)
  try {
    // The refusal is the Host's, before any Round: the world records nothing about it.
    expect(store.readEvents(world.manifest.address).some(event => event.eventType === 'action.resolved')).toBe(false)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
