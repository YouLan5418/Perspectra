import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { PlayerInputJobs, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { brandId, hashWorldJson } from '@harness-world/contracts'
import { PlayerIntentCallStore } from '@harness-world/agents'
import { PlayerIntentWorker, type PlayerIntentWorkerOptions } from './player-intent-worker.ts'
import { preparePlayerIntent } from './player-intent-preparation.ts'
import { FrozenInteractionRulebook, createCoreRulebookRegistry, WorldBootstrap } from '@harness-world/kernel'
import { frozenIntentWorld } from '../../../tests/fixtures/player-intent-world.ts'
import { basicInteractionPackage } from '../../../tests/fixtures/frozen-interaction-world.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'intent-worker-'))
  const worldPath = join(root, 'world.sqlite')
  const contextPath = join(root, 'context.sqlite')
  const compiled = frozenIntentWorld()
  const address = compiled.manifest.address
  const world = new WorldStore(worldPath)
  new WorldBootstrap(world, true, new FrozenInteractionRulebook([basicInteractionPackage])).activate(compiled)
  world.close()
  const jobs = new PlayerInputJobs(worldPath)
  const leases = new WriterLeaseService(worldPath)
  const lease = leases.acquire(address, 'worker', 1000)
  const job = jobs.receive(address, 'p', 'input', { text: 'hi' }, 2)
  const options: PlayerIntentWorkerOptions = {
    worldPath, contextPath, address, renewLease: () => leases.renew(address, lease.ownerId, lease.fencingToken, 1000),
    prepare: () => ({ request: { text: 'hi' }, budgetAvailable: true,
      profile: { version: 'player-intent-profile/v1', providerId: 'fixture', modelId: 'fixture', timeoutMs: 100, maxOutputTokens: 1 },
      binding: { address, inputId: job.inputId, actorId: brandId('character:player', 'CharacterId'), sourceText: 'hi',
        affordances: [{ affordanceId: 'speak', actionType: 'speak', actionVersion: 1, parameters: {} }],
        interpretationProfile: 'fixture/v1', interpretationReceiptHash: hashWorldJson('fixture', {}) },
    }),
    dispatch: async () => ({ version: 'player-intent-candidate/v3', decision: 'act', reason: 'none',
      actions: [{ key: 'a', affordanceId: 'speak', quotes: ['hi'] }] }),
    enqueue: () => ({ roundId: 'r' }), complete: async () => ({ tick: 1 }),
  }
  return { root, jobs, job, lease, options, close() { jobs.close(); leases.close(); rmSync(root, { recursive: true, force: true }) } }
}

it.each(['prepared-missing', 'dispatch-missing', 'response-missing', 'prepared-ambiguous', 'response-invalid', 'response-validated'])(
  'recovers %s without redispatching an ambiguous call', async mode => {
    const s = fixture()
    const point = mode.startsWith('prepared') ? 'player-input.after-prepared' : 'player-input.after-response'
    try {
      await expect(new PlayerIntentWorker({ ...s.options, faultInjector: { hit(actual) {
        if (actual === point) throw new Error('cut')
      } } }).processNext()).rejects.toThrow('cut')
      let job = s.jobs.read(s.job.address, 'input')!
      const callId = (job.records.prepared as { modelCallId: string }).modelCallId
      const calls = new PlayerIntentCallStore(s.options.contextPath)
      if (mode.startsWith('response')) job = s.jobs.advance(job, s.lease, 'response_received', { responseHash: calls.read(callId)!.responseHash })
      if (mode === 'prepared-ambiguous') job = s.jobs.advance(job, s.lease, 'dispatch_started', { modelCallId: callId })
      if (mode === 'response-invalid') calls.finish(callId, 'response_received', 'invalid_response')
      if (mode === 'response-validated') calls.finish(callId, 'response_received', 'validated')
      calls.close()
      if (mode.endsWith('missing')) {
        const db = new DatabaseSync(s.options.contextPath)
        db.prepare('DELETE FROM provider_calls WHERE model_call_id = ?').run(callId)
        db.close()
      }
      let dispatches = 0
      const worker = new PlayerIntentWorker({ ...s.options, dispatch: async (...args) => { dispatches++; return s.options.dispatch(...args) } })
      const result = await worker.processNext()
      expect(result?.status).toBe(mode === 'prepared-missing' || mode === 'response-validated' ? 'completed'
        : mode === 'response-invalid' ? 'invalid_response' : 'timed_out_ambiguous')
      expect(dispatches).toBe(mode === 'prepared-missing' ? 1 : 0)
      expect(await worker.processNext()).toBeUndefined()
    } finally { s.close() }
  },
)

it('aborts on lease loss and leaves the durable dispatch ambiguous for recovery', async () => {
  const s = fixture()
  let renewals = 0
  let signal: AbortSignal | undefined
  try {
    const worker = new PlayerIntentWorker({ ...s.options,
      renewLease: () => {
        if (++renewals === 5) throw new Error('lease stolen')
        return { ...s.options.renewLease(), expiresAtMs: Date.now() + 30 }
      },
      dispatch: async (_request, _profile, observed) => { signal = observed; return new Promise(() => {}) },
    })
    await expect(worker.processNext()).rejects.toThrow('lease stolen')
    expect(signal?.aborted).toBe(true)
    expect(s.jobs.read(s.job.address, 'input')?.status).toBe('dispatch_started')
    expect((await new PlayerIntentWorker(s.options).processNext())?.status).toBe('timed_out_ambiguous')
  } finally { s.close() }
})

it.each(['request', 'response'])('rejects a self-consistent Context %s that differs from World evidence', async kind => {
  const s = fixture()
  try {
    await expect(new PlayerIntentWorker({ ...s.options, faultInjector: { hit(point) {
      if (point === 'player-input.after-response') throw new Error('cut')
    } } }).processNext()).rejects.toThrow('cut')
    const job = s.jobs.read(s.job.address, 'input')!
    const callId = (job.records.prepared as { modelCallId: string }).modelCallId
    const db = new DatabaseSync(s.options.contextPath)
    // The tampered row stays self-consistent under the tag in force, so the refusal that fires is the
    // World-evidence one rather than the store's own conflict check.
    if (kind === 'request') db.prepare('UPDATE provider_calls SET request_json = ?, provider_request_hash = ? WHERE model_call_id = ?')
      .run('{}', hashWorldJson('player-intent-request/v2', {}), callId)
    else s.jobs.advance(job, s.lease, 'response_received', { responseHash: 'sha256:different' })
    db.close()
    await expect(new PlayerIntentWorker(s.options).processNext()).rejects.toThrow('diverges from World authority')
  } finally { s.close() }
})

it('fails closed on lost PlayerBinding and tolerates an empty interaction affordance catalog', () => {
  const s = fixture()
  try {
    const world = frozenIntentWorld()
    const resolver = createCoreRulebookRegistry().resolve(world.manifest.rulebook.rulebookId, world.manifest.rulebook.version, 'test', world.manifest.address)
    expect(() => preparePlayerIntent(s.job, world.manifest, [], resolver, undefined, 0, world.manifestHash, 0))
      .toThrow('lost its PlayerBinding')
    const prepared = s.options.prepare(s.job)
    if (!('profile' in prepared)) throw new Error('fixture requires profile')
    const result = preparePlayerIntent({ ...s.job, principalId: 'principal:player' }, world.manifest, [],
      { ...resolver, affordances: () => [{ actionType: 'interact', actionVersion: 1, parameters: {} }] } as typeof resolver,
      prepared.profile, 10, world.manifestHash, 0)
    expect('request' in result && result.binding.affordances).toEqual([])
  } finally { s.close() }
})

it('does not dispatch when the Context CAS has already been taken', async () => {
  const s = fixture()
  const original = PlayerIntentCallStore.prototype.start
  const spy = vi.spyOn(PlayerIntentCallStore.prototype, 'start').mockImplementation(function (this: PlayerIntentCallStore, id) {
    original.call(this, id)
    return false
  })
  try {
    expect((await new PlayerIntentWorker({ ...s.options, dispatch: async () => { throw new Error('must not dispatch') } }).processNext())?.status)
      .toBe('timed_out_ambiguous')
  } finally { spy.mockRestore(); s.close() }
})

it('records late responses only as audit without reviving the timed-out input', async () => {
  const s = fixture()
  let deliver!: () => void
  const delivered = new Promise<void>(resolve => { deliver = resolve })
  try {
    const result = await new PlayerIntentWorker({ ...s.options, dispatch: async (...args) => {
      await delivered
      return s.options.dispatch(...args)
    } }).processNext()
    expect(result?.status).toBe('timed_out_ambiguous')
    deliver()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(s.jobs.read(s.job.address, 'input')).toEqual(result)
    const db = new DatabaseSync(s.options.contextPath)
    expect(db.prepare('SELECT COUNT(*) AS count FROM player_intent_late_responses').get()).toEqual({ count: 1 })
    db.close()
  } finally { s.close() }
})
