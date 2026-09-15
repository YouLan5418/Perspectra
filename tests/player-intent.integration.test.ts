import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId, hashWorldJson, worldAddressKey, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { LocalJsonRpcRouter } from '@harness-world/operations'
import { PlayerInputJobs, WorldLogicalTransferService, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { frozenIntentWorld, intentWorld, intentFixtureProfile, intentFixtureRequest, intentFixtureResponse } from './fixtures/player-intent-world.ts'

it.each([false, true])('durably interprets a full player group before NPC reaction, speech first=%s', speechFirst => {
  return runGroup(speechFirst)
})

async function runGroup(speechFirst: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'player-intent-'))
  const world = intentWorld()
  const path = join(root, 'world.sqlite')
  const source = speechFirst ? '别走，我牵她的手，她没有挣脱' : '我牵她的手，别走，她没有挣脱'
  let calls = 0
  let npcCalled = false
  const app = new WorldApplication({ worldPath: path, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    playerIntent: { profile: { version: 'player-intent-profile/v1', providerId: 'fixture', modelId: 'intent/v1', maxOutputTokens: 10, timeoutMs: 1000 },
      dispatch: async (raw: WorldJsonValue) => {
        calls++
        const request = (raw as any).body
        const hold = request.affordances.find((a: any) => a.actionType === 'interact')
        expect(request.sourceText).toBe(source)
        // The words each action is named by, in the order the player said them: the Host finds them in
        // the source, so the interpreter never states an offset.
        const holdQuote = { key: 'h', affordanceId: hold.affordanceId, quotes: ['我牵她的手'] }
        const sayQuote = { key: 's', affordanceId: 'speak', quotes: ['别走'] }
        const actions = speechFirst ? [sayQuote, holdQuote] : [holdQuote, sayQuote]
        return { version: 'player-intent-candidate/v3', decision: 'act', reason: 'none', actions }
      } },
    participants: () => [{ participantId: 'agent:npc', role: 'agent', actorId: brandId('character:npc', 'CharacterId'), allowedActionTypes: ['speak', 'interact'],
      priority: 1, estimatedTokens: 1, timeoutMs: 1000, provider: { propose: async context => {
        npcCalled = true
        const rendered = JSON.stringify((context as any).exactProviderRequest)
        expect(rendered).toContain('provisional-reaction-group/v1')
        expect(rendered).toContain('core:release-hand')
        expect(rendered).toContain('别走')
        expect(rendered).not.toContain('她没有挣脱')
        const relationId = rendered.match(/relation:[a-z0-9]+/)![0]
        return { schemaVersion: 5, decision: 'act', actions: [{ actionId: 'action:release', actorId: 'character:npc', actionVersion: 1,
          actionType: 'interact', parameters: { targetId: relationId, interactionId: 'core:release-hand', arguments: {} } }] }
      } } }],
  })
  try {
    app.activate(world)
    const request = { text: source, principalId: 'principal:player', idempotencyKey: 'intent', correlationId: 'test:intent' }
    const result = await app.submitText(world.manifest.address, request)
    expect(result.status).toBe('submitted')
    expect(await app.submitText(world.manifest.address, request)).toEqual(result)
    expect(calls).toBe(1)
    expect(npcCalled).toBe(true)
    const store = new WorldStore(path)
    const events = store.readEvents(world.manifest.address)
    store.close()
    expect(events.filter(e => e.eventType === 'character.relation-started')).toHaveLength(1)
    expect(events.filter(e => e.eventType === 'character.relation-ended')).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('她没有挣脱')
    const jobs = new PlayerInputJobs(path)
    expect(jobs.read(world.manifest.address, 'intent')?.status).toBe('completed')
    jobs.close()
    const authorityPath = join(root, `intent-${speechFirst ? 'speech-first' : 'hold-first'}.dshworld`)
    const importedPath = join(root, `intent-${speechFirst ? 'speech-first' : 'hold-first'}.sqlite`)
    const transfer = new WorldLogicalTransferService(path)
    transfer.exportAuthority(authorityPath, 'intent:completed-export')
    transfer.importAuthority(authorityPath, importedPath, 'intent:completed-import')
    const importedJobs = new PlayerInputJobs(importedPath)
    expect(importedJobs.read(world.manifest.address, 'intent')?.records.completed).toEqual(result.status === 'submitted' ? result.result : undefined)
    importedJobs.close()
    if (speechFirst) {
      const forged = JSON.parse(readFileSync(authorityPath, 'utf8')) as any
      const row = forged.data.tables.player_input_jobs[0]
      const changed = JSON.parse(row.job_json)
      changed.records.completed = { ...changed.records.completed, tick: changed.records.completed.tick + 1 }
      row.job_json = JSON.stringify(changed)
      row.state_hash = hashWorldJson('player-input-state/v1', changed)
      forged.bundleHash = hashWorldJson('logical-authority-export', forged.data)
      const forgedPath = join(root, 'intent-completed-forged.dshworld')
      writeFileSync(forgedPath, JSON.stringify(forged))
      expect(() => transfer.importAuthority(forgedPath, join(root, 'intent-completed-forged.sqlite'), 'intent:completed-forged'))
        .toThrow('divergent completed Player Input result')
    }
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
}

it.each(['missing', 'budget', 'invalid', 'clarify', 'timeout', 'throw'] as const)('persists %s and allows a queued explicit fallback without another interpretation', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'player-intent-failure-'))
  const world = intentWorld()
  let calls = 0
  const app = new WorldApplication({ worldPath: join(root, 'world.sqlite'), sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'),
    modelBudgetTokens: mode === 'budget' ? 0 : 20,
    ...(mode === 'missing' ? {} : { playerIntent: {
      profile: { version: 'player-intent-profile/v1' as const, providerId: 'fixture', modelId: 'intent/v1', maxOutputTokens: 10, timeoutMs: 20 },
      dispatch: async () => { calls++
        if (mode === 'timeout') return new Promise<WorldJsonValue>(() => {})
        if (mode === 'throw') throw new Error('provider failure')
        if (mode === 'clarify') return { version: 'player-intent-candidate/v3', decision: 'clarification_required', reason: 'ambiguous', actions: [] }
        return { unknown: true }
      },
    } }),
  })
  try {
    app.activate(world)
    const first = { text: '我牵她的手', principalId: 'principal:player', idempotencyKey: 'first', correlationId: 'failure' }
    const pending = app.submitText(world.manifest.address, first)
    const explicit = app.submitText(world.manifest.address, { ...first, idempotencyKey: 'explicit', text: '/move location:next' })
    expect((await pending).status).toBe('clarification_required')
    expect((await explicit).status).toBe('submitted')
    expect(await app.submitText(world.manifest.address, first)).toEqual(await pending)
    expect(calls).toBe(mode === 'missing' || mode === 'budget' ? 0 : 1)
    await expect(app.submitText(world.manifest.address, { ...first, text: 'different' })).rejects.toThrow('different content')
    await expect(app.submitText(world.manifest.address, { ...first, principalId: 'intruder' })).rejects.toThrow('PlayerBinding')
    expect((await app.submitText(world.manifest.address, { ...first, idempotencyKey: 'unknown-command', text: '/unknown' })).status).toBe('clarification_required')
    const direct = await app.submit(world.manifest.address, { idempotencyKey: 'direct', principalId: 'principal:player', correlationId: 'direct', action: { actionType: 'speak', parameters: { text: 'explicit speech' } } })
    expect(direct.tick).toBe(2)
    const store = new WorldStore(join(root, 'world.sqlite'))
    expect(JSON.stringify(store.readEvents(world.manifest.address))).not.toContain('我牵她的手')
    store.close()
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})

it.each(['player-input.after-received', 'player-input.after-call-prepared', 'player-input.after-prepared',
  'player-input.after-dispatch', 'player-input.after-response', 'player-input.after-validated', 'player-input.after-round-enqueue', 'player-input.after-world-commit'] as const)(
  'recovers the exact durable interpretation at %s', async point => {
    const root = mkdtempSync(join(tmpdir(), 'intent-restart-'))
    const world = intentWorld()
    let calls = 0
    const options = { worldPath: join(root, 'world.sqlite'), sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
      playerIntent: { profile: { version: 'player-intent-profile/v1' as const, providerId: 'fixture', modelId: 'intent/v1', maxOutputTokens: 10, timeoutMs: 1000 },
        dispatch: async () => { calls++; return { version: 'player-intent-candidate/v3', decision: 'act', reason: 'none',
          actions: [{ key: 'a', affordanceId: 'speak', quotes: ['你好'] }] } } },
    }
    const request = { text: '你好', principalId: 'principal:player', idempotencyKey: 'restart', correlationId: 'restart' }
    const interrupted = new WorldApplication({ ...options, faultInjector: { hit(actual) { if (actual === point) throw new Error('cut') } } })
    interrupted.activate(world)
    await expect(interrupted.submitText(world.manifest.address, request)).rejects.toThrow('cut')
    await interrupted.close()
    const recovered = new WorldApplication(options)
    try {
      const result = await recovered.submitText(world.manifest.address, request)
      expect(result.status).toBe(point === 'player-input.after-dispatch' ? 'clarification_required' : 'submitted')
      expect(await recovered.submitText(world.manifest.address, request)).toEqual(result)
      expect(calls).toBe(point === 'player-input.after-dispatch' ? 0 : 1)
    } finally { await recovered.close(); rmSync(root, { recursive: true, force: true }) }
  },
)

it('discovers and completes an accepted player input after restart without a client retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intent-background-restart-'))
  const world = intentWorld()
  const options = { worldPath: join(root, 'world.sqlite'), sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    playerIntent: { profile: intentFixtureProfile, dispatch: async () => intentFixtureResponse },
  }
  const creator = new WorldApplication(options)
  creator.activate(world)
  await creator.close()
  const jobs = new PlayerInputJobs(options.worldPath)
  try {
    const accepted = jobs.receive(world.manifest.address, 'principal:player', 'background', { text: '你好' }, 2)
    expect(accepted.status).toBe('received')
    expect(jobs.unfinishedAddresses()).toEqual([world.manifest.address])
  } finally { jobs.close() }

  let calls = 0
  const recovered = new WorldApplication({ ...options, playerIntent: { ...options.playerIntent,
    dispatch: async () => { calls++; return intentFixtureResponse },
  } })
  recovered.activate(world)
  const router = new LocalJsonRpcRouter(options.worldPath, recovered)
  let routerOpen = true
  try {
    let committed!: () => void
    const completion = new Promise<void>(resolve => { committed = resolve })
    router.subscribeNotifications(notification => { if (notification.method === 'round.committed') committed() })
    expect(router.recoverAcceptedRounds('intent:background-recovery')).toBe(1)
    await Promise.race([completion, new Promise((_, reject) => setTimeout(() => reject(new Error('background recovery timed out')), 2000))])
    await router.close()
    routerOpen = false
    const probe = new PlayerInputJobs(options.worldPath)
    try {
      expect(probe.read(world.manifest.address, 'background')?.status).toBe('completed')
      expect(probe.unfinishedAddresses()).toEqual([])
      probe.receive(world.manifest.address, 'principal:player', 'background-counted', { text: '你好' }, 2)
    } finally { probe.close() }
    expect(await recovered.processAcceptedRounds(world.manifest.address, 'intent:background-counted')).toBe(1)
    expect(calls).toBe(2)
  } finally {
    if (routerOpen) await router.close()
    await recovered.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['Head', 'Manifest'] as const)('quarantines a self-consistent player-input record whose accepted %s was forged', async kind => {
  const root = mkdtempSync(join(tmpdir(), 'intent-accepted-head-'))
  const world = intentWorld()
  const worldPath = join(root, 'world.sqlite')
  const sessionPath = join(root, 'session.sqlite')
  const memoryPath = join(root, 'memory.sqlite')
  const creator = new WorldApplication({ worldPath, sessionPath, memoryPath })
  creator.activate(world)
  await creator.close()
  const jobs = new PlayerInputJobs(worldPath)
  const accepted = jobs.receive(world.manifest.address, 'principal:player', 'forged', { text: '你好' }, 2)
  jobs.close()
  const forged = kind === 'Head'
    ? { ...accepted, acceptedHeadHash: hashWorldJson('forged-player-input-head', {}) }
    : { ...accepted, acceptedManifestHash: hashWorldJson('forged-player-input-manifest', {}) }
  const raw = new DatabaseSync(worldPath)
  raw.prepare('UPDATE player_input_jobs SET job_json = ?, state_hash = ? WHERE address_key = ? AND input_seq = ?')
    .run(JSON.stringify(forged), hashWorldJson('player-input-state/v1', forged), worldAddressKey(world.manifest.address), accepted.inputSeq)
  raw.close()

  const recovered = new WorldApplication({ worldPath, sessionPath, memoryPath, modelBudgetTokens: 20,
    playerIntent: { profile: intentFixtureProfile, dispatch: async () => intentFixtureResponse },
  })
  recovered.activate(world)
  try {
    await expect(recovered.processNextBranchWork(world.manifest.address, 'intent:forged-head'))
      .rejects.toThrow(`accepted ${kind}`)
    expect(recovered.quarantineExplain(world.manifest.address)).toMatchObject({ runtimePhase: 'quarantined' })
  } finally { await recovered.close(); rmSync(root, { recursive: true, force: true }) }
})

it('returns a terminal non-Round scheduling quantum when background interpretation needs clarification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intent-background-clarification-'))
  const world = intentWorld()
  const worldPath = join(root, 'world.sqlite')
  const sessionPath = join(root, 'session.sqlite')
  const memoryPath = join(root, 'memory.sqlite')
  const creator = new WorldApplication({ worldPath, sessionPath, memoryPath })
  creator.activate(world)
  await creator.close()
  const jobs = new PlayerInputJobs(worldPath)
  jobs.receive(world.manifest.address, 'principal:player', 'background-clarification', { text: '你好' }, 2)
  jobs.close()
  const recovered = new WorldApplication({ worldPath, sessionPath, memoryPath })
  try {
    await expect(recovered.processNextBranchWork(world.manifest.address, 'intent:background-clarification')).resolves.toMatchObject({
      status: 'player_input', inputStatus: 'clarification_required', round: null,
    })
  } finally { await recovered.close(); rmSync(root, { recursive: true, force: true }) }
})

it.each([
  { version: 'invalid' }, { providerId: '' }, { modelId: '' },
  { timeoutMs: 1.5 }, { timeoutMs: 0 }, { timeoutMs: 60_001 },
  { maxOutputTokens: 1.5 }, { maxOutputTokens: 0 },
])('terminates an invalid interpretation profile without blocking explicit input: %j', async override => {
  const root = mkdtempSync(join(tmpdir(), 'intent-profile-'))
  const world = intentWorld()
  const app = new WorldApplication({ worldPath: join(root, 'world.sqlite'), sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    playerIntent: { profile: { ...intentFixtureProfile, ...override } as typeof intentFixtureProfile,
      dispatch: async () => { throw new Error('invalid profile must never dispatch') } },
  })
  try {
    app.activate(world)
    expect(await app.submitText(world.manifest.address, intentFixtureRequest)).toEqual({
      status: 'clarification_required', reason: 'invalid_player_intent_profile', candidates: [],
    })
    expect((await app.submitText(world.manifest.address, {
      ...intentFixtureRequest, idempotencyKey: 'fallback', text: '/move location:next',
    })).status).toBe('submitted')
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})

it('renews the writer lease throughout a slow interpretation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intent-heartbeat-'))
  const world = intentWorld()
  const app = new WorldApplication({ worldPath: join(root, 'world.sqlite'), sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20, leaseTtlMs: 300,
    playerIntent: { profile: { ...intentFixtureProfile, timeoutMs: 2000 }, dispatch: async () => {
      await new Promise(resolve => setTimeout(resolve, 700))
      return intentFixtureResponse
    } },
  })
  try {
    app.activate(world)
    expect((await app.submitText(world.manifest.address, intentFixtureRequest)).status).toBe('submitted')
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})

it('handles unknown worlds, absent context plugins and a durable explicit-input clarification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intent-edges-'))
  const base = intentWorld()
  const manifest = { ...base.manifest, plugins: base.manifest.plugins.filter(plugin => plugin.pluginId !== 'builtin:agent-context') }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { manifestHash, genesisPlanHash: manifest.genesisPlanHash } } : event)
  const world = { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
  const worldPath = join(root, 'world.sqlite')
  const app = new WorldApplication({ worldPath, sessionPath: join(root, 'session.sqlite'),
    playerIntent: { profile: intentFixtureProfile, dispatch: async () => intentFixtureResponse } })
  try {
    await expect(app.submitText(world.manifest.address, intentFixtureRequest)).rejects.toThrow()
    app.activate(world)
    expect((await app.submitText(world.manifest.address, intentFixtureRequest)).status).toBe('clarification_required')
    await expect(app.submitText(world.manifest.address, { ...intentFixtureRequest, text: null as never })).rejects.toThrow()
  } finally { await app.close() }
  const jobs = new PlayerInputJobs(worldPath)
  const leases = new WriterLeaseService(worldPath)
  const action = { actionType: 'speak', parameters: { text: 'explicit' } }
  try {
    const lease = leases.acquire(manifest.address, 'fixture')
    const job = jobs.receive(manifest.address, 'principal:player', 'cancelled-explicit', { text: JSON.stringify(action), action }, 2)
    jobs.claim(manifest.address, lease)
    jobs.advance(job, lease, 'clarification_required', { reason: 'operator clarification' })
    leases.release(manifest.address, lease.ownerId, lease.fencingToken)
  } finally { jobs.close(); leases.close() }
  const replay = new WorldApplication({ worldPath, sessionPath: join(root, 'session.sqlite') })
  try {
    await expect(replay.submit(manifest.address, { idempotencyKey: 'cancelled-explicit', principalId: 'principal:player', correlationId: 'test', action }))
      .rejects.toThrow('operator clarification')
  } finally { await replay.close(); rmSync(root, { recursive: true, force: true }) }
})

it('resumes a failed in-process FIFO predecessor before its queued fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intent-tail-'))
  const world = intentWorld()
  let cut = true
  const app = new WorldApplication({ worldPath: join(root, 'world.sqlite'), sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    playerIntent: { profile: intentFixtureProfile, dispatch: async () => intentFixtureResponse },
    faultInjector: { hit(point) { if (cut && point === 'player-input.after-prepared') { cut = false; throw new Error('interrupted') } } },
  })
  try {
    app.activate(world)
    const first = app.submitText(world.manifest.address, intentFixtureRequest)
    const rejected = expect(first).rejects.toThrow('interrupted')
    const second = app.submitText(world.manifest.address, { ...intentFixtureRequest, idempotencyKey: 'next', text: '/move location:next' })
    await rejected
    expect((await second).status).toBe('submitted')
    expect((await app.submitText(world.manifest.address, intentFixtureRequest)).status).toBe('submitted')
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})

it('takes the writer lease back when the page was idle past its deadline', async () => {
  // The rhythm of a real playtest: a person reads for a while, comes back, and types. The writer lease
  // lapses in between, and a renewal only works on a live lease - so the Host ensures its own before it
  // processes the input, rather than failing the player's turn with WRITER_LEASE_LOST.
  const root = mkdtempSync(join(tmpdir(), 'player-intent-idle-'))
  const world = frozenIntentWorld()
  const path = join(root, 'world.sqlite')
  const app = new WorldApplication({ worldPath: path, sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20, leaseTtlMs: 1_000,
    playerIntent: { profile: intentFixtureProfile, dispatch: async () => intentFixtureResponse } })
  const request = (key: string) => ({ text: '你好', principalId: 'principal:player',
    idempotencyKey: key, correlationId: key })
  try {
    app.activate(world)
    expect((await app.submitText(world.manifest.address, request('idle-first'))).status).toBe('submitted')
    await new Promise(done => setTimeout(done, 1_200))
    // The lease has lapsed by now: the next input is still the player's, and it still lands.
    expect((await app.submitText(world.manifest.address, request('idle-after'))).status).toBe('submitted')
  } finally { await app.close() }
  rmSync(root, { recursive: true, force: true })
})

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

it('lets the player say how they do it, out of what that definition accepts', async () => {
  // The interpreted path carries a step now: the interpreter is offered what each choice's definition
  // accepts, the player's words become one of those cues, and the definition that locked the policy
  // adjudicates it - the same path a model's step takes. The paired run states nothing, so the only
  // difference between the two worlds is what the player said.
  const run = async (step: WorldJsonObject | undefined) => {
    const root = mkdtempSync(join(tmpdir(), 'player-intent-step-'))
    const world = frozenIntentWorld('responsive/v2')
    const path = join(root, 'world.sqlite')
    let protocol = ''
    let offered: readonly { readonly affordanceId: string; readonly actionType: string
      readonly parameters: WorldJsonObject; readonly performances?: readonly string[] }[] = []
    const source = '我把杯子递给他'
    const app = new WorldApplication({ worldPath: path, sessionPath: join(root, 'session.sqlite'),
      memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
      reactionParticipants: () => ['character:npc', 'character:bob'].map(actorId => ({
        participantId: `agent:${actorId}`, role: 'agent' as const, actorId: brandId(actorId, 'CharacterId'),
        allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
        provider: { propose: async () => ({ schemaVersion: 7 as const, decision: 'abstain' as const, actions: [] }) },
      })),
      playerIntent: { profile: intentFixtureProfile, dispatch: async (raw: WorldJsonValue) => {
        const body = (raw as { body: { version: string
          affordances: readonly { readonly affordanceId: string; readonly actionType: string
            readonly parameters: WorldJsonObject; readonly performances?: readonly string[] }[] } }).body
        protocol = body.version
        offered = body.affordances
        const give = body.affordances.find(entry => entry.parameters.bindingId === 'binding:entity:cup:base:give')!
        return { version: 'player-intent-candidate/v3', decision: 'act', reason: 'none',
          actions: [{ key: 'g', affordanceId: give.affordanceId, quotes: [source],
            ...(step === undefined ? {} : { performance: step }) }] }
      } },
    })
    try {
      app.activate(world)
      // The cup has to be in the player's hands for the hand-over to be the player's to make.
      await app.submit(world.manifest.address, { idempotencyKey: 'take', principalId: 'principal:player',
        correlationId: 'intent-step:take', action: { actionType: 'interact', parameters: {
          targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
          definitionRef: { id: 'base:take', version: 1 }, arguments: {} } as never } })
      const result = await app.submitText(world.manifest.address, { text: source, principalId: 'principal:player',
        idempotencyKey: 'give', correlationId: 'intent-step:give' })
      expect(result.status).toBe('submitted')
    } finally { await app.close() }
    const store = new WorldStore(path)
    try {
      const events = store.readEvents(world.manifest.address)
      // A take moves the cup too, so the hand-over is the last of the two rounds, not the first.
      const transferred = events.filter(event => event.eventType === 'entity.transferred').at(-1)!
      const give = events.find(event => event.eventType === 'action.resolved'
        && event.transactionId === transferred.transactionId)!
      return { protocol, offered, events,
        authority: store.readRoundAuthority(world.manifest.address, give.transactionId)!.authority }
    } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
  }
  const described = (events: readonly { readonly eventType: string; readonly data: unknown }[]) =>
    events.filter(event => event.eventType === 'character.manifested')
      .map(event => (event.data as { readonly cues: readonly { readonly description: string }[] }).cues
        .map(cue => cue.description))
  const expressed = await run({ independent: ['frown'], onSuccess: ['smile'] })
  // What the interpreter was told: the protocol that carries a step, and per choice exactly what that
  // choice accepts. A definition that accepts nothing is offered without a list rather than with an empty
  // one, so a caller that sees no list knows not to state anything.
  expect(expressed.protocol).toBe('player-intent-request/v2')
  const give = expressed.offered.find(entry => entry.parameters.bindingId === 'binding:entity:cup:base:give')!
  // The other cup is on the floor, so its take is still offered - and take accepts nothing, which is
  // offered as no list at all rather than as an empty one.
  const take = expressed.offered.find(entry => entry.parameters.bindingId === 'binding:entity:other:base:take')!
  expect(give.performances).toContain('frown')
  expect(take.performances).toBeUndefined()
  // The player's words became the world's own fact: an accepted step, recorded with the hand-over.
  expect(described(expressed.events)).toEqual([['微微皱眉', '微微一笑']])
  const resolution = (expressed.authority.resolutions as readonly Record<string, unknown>[])
    .find(entry => entry.manifestation !== undefined)!
  expect(resolution.manifestation).toMatchObject({ status: 'accepted' })
  expect(resolution.candidateHashAfter).not.toBe(resolution.candidateHashBefore)
  // Everyone who could see the hand-over was told how it was done, not just that it happened.
  const observed = expressed.events.filter(event => event.eventType === 'observation.upsert')
    .map(event => (event.data as { readonly value: { readonly observerId: string; readonly content: WorldJsonObject } }).value)
    .filter(value => value.content.manifestation !== undefined)
  expect(observed.map(value => value.observerId).sort())
    .toEqual(['character:bob', 'character:npc', 'character:player'])
  // And saying nothing is still a way to do it: the paired world records the same hand-over, as the same
  // effect, with no step - which is what keeps a step an expression rather than a mechanic.
  const plain = await run(undefined)
  expect(described(plain.events)).toEqual([])
  const handOver = (events: readonly { readonly eventType: string; readonly data: unknown }[]) =>
    events.filter(event => event.eventType === 'entity.transferred').at(-1)!.data
  expect(handOver(plain.events)).toEqual(handOver(expressed.events))
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
