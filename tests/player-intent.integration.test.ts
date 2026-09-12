import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId, hashWorldJson, worldAddressKey, type WorldJsonValue } from '@harness-world/contracts'
import { LocalJsonRpcRouter } from '@harness-world/operations'
import { PlayerInputJobs, WorldLogicalTransferService, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { intentWorld, intentFixtureProfile, intentFixtureRequest, intentFixtureResponse } from './fixtures/player-intent-world.ts'

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
        const actions = [{ key: 'h', affordanceId: hold.affordanceId }, { key: 's', affordanceId: 'speak' }]
        if (speechFirst) actions.reverse()
        const spans = speechFirst ? [
          { actionKey: 's', startUtf16: 0, endUtf16: 2, text: '别走', kind: 'speech' },
          { actionKey: 'h', startUtf16: 3, endUtf16: 8, text: '我牵她的手', kind: 'action' },
        ] : [
          { actionKey: 'h', startUtf16: 0, endUtf16: 5, text: '我牵她的手', kind: 'action' },
          { actionKey: 's', startUtf16: 6, endUtf16: 8, text: '别走', kind: 'speech' },
        ]
        return { version: 'player-intent-candidate/v1', decision: 'act', reason: 'none', actions, sourceSpans: spans }
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
        if (mode === 'clarify') return { version: 'player-intent-candidate/v1', decision: 'clarification_required', reason: 'ambiguous', actions: [], sourceSpans: [] }
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
        dispatch: async () => { calls++; return { version: 'player-intent-candidate/v1', decision: 'act', reason: 'none',
          actions: [{ key: 'a', affordanceId: 'speak' }], sourceSpans: [{ actionKey: 'a', startUtf16: 0, endUtf16: 2, text: '你好', kind: 'speech' }] } } },
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
