import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
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

it('submits all boundary phrases as intact speech without any intent call or controlled player change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'player-commands-'))
  const world = frozenIntentWorld('responsive/v2')
  const path = join(root, 'world.sqlite')
  const inputs = ['我拿起日记。', '我拿起日记看看。', '我拿起日记，准备带走。', '我把日记放下。',
    '我把日记暂时放桌上。', '我不保管了，把日记留在这里。', '陆舟，你把日记放桌上吧。',
    '程雨，你替我保管一下。', '你们谁把怀表拿过来看看？', '我让陆舟把日记交给程雨。', '我走进后室。']
  let calls = 0
  const app = new WorldApplication({ worldPath: path, sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 0,
    reactionParticipants: () => ['character:npc', 'character:bob'].map(actorId => ({
      participantId: `agent:${actorId}`, role: 'agent' as const, actorId: brandId(actorId, 'CharacterId'),
      allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
      provider: { propose: async () => ({ schemaVersion: 7 as const, decision: 'abstain' as const, actions: [] }) },
    })),
    playerIntent: { profile: intentFixtureProfile, dispatch: async () => { calls++; throw new Error('must not interpret') } },
  })
  try {
    app.activate(world)
    for (const [i, text] of inputs.entries()) {
      const request = { text, principalId: 'principal:player', idempotencyKey: `plain:${i}`, correlationId: `plain:${i}` }
      const result = await app.submitText(world.manifest.address, request)
      expect(result).toMatchObject({ status: 'submitted', action: { actionType: 'speak', parameters: { text } } })
      expect(await app.submitText(world.manifest.address, request)).toEqual(result)
    }
    expect(calls).toBe(0)
  } finally { await app.close() }
  const store = new WorldStore(path)
  try {
    const events = store.readEvents(world.manifest.address)
    expect(events.filter(e => e.eventType === 'entity.transferred' || e.eventType === 'character.moved')).toHaveLength(0)
    expect(events.filter(e => e.eventType === 'character.speak').map(e => (e.data as WorldJsonObject).text)).toEqual(inputs)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

it('executes exact custody commands, rejects unavailable targets, and keeps narration free of state effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'player-custody-commands-'))
  const world = frozenIntentWorld()
  const path = join(root, 'world.sqlite')
  const app = new WorldApplication({ worldPath: path, sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'), externalCharacterActivations: true })
  let serial = 0
  const submit = (text: string) => app.submitText(world.manifest.address, { text, principalId: 'principal:player',
    idempotencyKey: `command:${serial}`, correlationId: `command:${serial++}` })
  try {
    app.activate(world)
    expect(await submit('/take entity:other')).toMatchObject({ status: 'submitted', action: { actionType: 'interact' } })
    expect(await submit('/narrate 我把杯子暂放桌上。')).toMatchObject({ status: 'submitted',
      action: { actionType: 'speak', parameters: { text: '', narration: '我把杯子暂放桌上。' } } })
    expect(await submit('/give entity:other character:npc')).toMatchObject({ status: 'submitted', action: { actionType: 'interact' } })
    expect(await submit('/drop entity:other')).toMatchObject({ status: 'clarification_required' })
    expect(await submit('/take entity:missing')).toMatchObject({ status: 'clarification_required' })
    expect(await submit('/give entity:cup')).toMatchObject({ status: 'clarification_required' })
    expect(await submit('/take entity:cup')).toMatchObject({ status: 'submitted', action: { actionType: 'interact' } })
    expect(await submit('/drop entity:cup')).toMatchObject({ status: 'submitted', action: { actionType: 'interact' } })
  } finally { await app.close() }
  const store = new WorldStore(path)
  try {
    const events = store.readEvents(world.manifest.address)
    expect(events.filter(e => e.eventType === 'entity.transferred').map(e => e.data)).toMatchObject([
      { entityId: 'entity:other', toHolderId: 'character:player' },
      { entityId: 'entity:other', toHolderId: 'character:npc' },
      { entityId: 'entity:cup', toHolderId: 'character:player' },
      { entityId: 'entity:cup', toHolderId: null },
    ])
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
