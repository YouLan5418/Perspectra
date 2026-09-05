import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { Session } from 'node:inspector'
import { resolve, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { WorldApplication } from '@harness-world/application'
import { brandId } from '@harness-world/contracts'
import { WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { ADDRESS, v5Manifest, reactionBinding } from '../tests/reaction-fixture.ts'

// Diagnostic workload, not a release pass/fail threshold. No direct SQL seeding,
// fake hashes, real providers, or changes to production code.
const [outputArgument, countArgument = '10000'] = process.argv.slice(2)
const count = Number(countArgument)
if (!outputArgument || ![0, 10_000, 100_000].includes(count)) {
  throw new Error('usage: measure-reaction-history <new-directory> <0|10000|100000>')
}
const directory = resolve(outputArgument)
if (existsSync(directory)) throw new Error('output directory must not already exist')
mkdirSync(directory, { recursive: true })
const worldPath = join(directory, 'world.sqlite')
const compiled = v5Manifest()
const script = { calls: { value: 0 }, outputs: new Map() }
function application() {
  return new WorldApplication({ worldPath, sessionPath: join(directory, 'session.sqlite'),
    memoryPath: join(directory, 'memory.sqlite'), leaseTtlMs: 30_000, modelBudgetTokens: 64,
    participants: () => [], reactionParticipants: () => ['character:alice', 'character:bob'].map(id =>
      reactionBinding(brandId(id, 'CharacterId'), script)) })
}
const emit = (data: object) => process.stdout.write(`${JSON.stringify(data)}\n`)
const bootstrap = application()
try { bootstrap.activate(compiled) } finally { await bootstrap.close() }
const store = new WorldStore(worldPath)
const leases = new WriterLeaseService(worldPath)
const seedStarted = performance.now()
try {
  // Store-level speech history: intentionally excludes generated Observations
  // and Memory growth, so this isolates Event Log size rather than full chat.
  const event = { eventType: 'character.speak', eventVersion: 1,
    data: { characterId: 'character:player', text: 'A historical public utterance.' } }
  for (let offset = 0; offset < count; offset += 1_000) {
    const lease = leases.acquire(ADDRESS, 'benchmark-seed')
    const head = store.head(ADDRESS)
    await store.commitRound({ address: ADDRESS,
      transactionId: brandId(`transaction:history:${offset}`, 'TransactionId'),
      roundId: brandId(`round:history:${offset}`, 'InteractionRoundId'),
      expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1,
      events: Array.from({ length: Math.min(1_000, count - offset) }, () => event),
      outbox: [], writerFencingToken: lease.fencingToken, correlationId: 'history-benchmark',
    })
    leases.release(ADDRESS, 'benchmark-seed', lease.fencingToken)
    if ((offset + 1_000) % 10_000 === 0) emit({ stage: 'seed', events: offset + 1_000 })
  }
  const verificationStart = performance.now()
  const integrity = store.verifyBranchIntegrity(ADDRESS)
  emit({ stage: 'seed-complete', additionalEvents: count, seedAndVerifyMs: performance.now() - seedStarted,
    verificationMs: performance.now() - verificationStart, integrity })
} finally { leases.close(); store.close() }

// Inclusive readEvents timings can overlap during parent-chain recursion. They
// are diagnostics, not additive exclusive CPU attribution.
const originalRead = WorldStore.prototype.readEvents
const originalRange = WorldStore.prototype.readEventsRange
let readCalls = 0
let returnedRows = 0
let readMs = 0
let rangeCalls = 0
let rangeRows = 0
let rangeMs = 0
WorldStore.prototype.readEvents = function (...args) {
  const start = performance.now()
  try {
    const events = originalRead.apply(this, args)
    readCalls += 1
    returnedRows += events.length
    return events
  } finally { readMs += performance.now() - start }
}
WorldStore.prototype.readEventsRange = function (...args) {
  const start = performance.now()
  try {
    const events = originalRange.apply(this, args)
    rangeCalls += 1
    rangeRows += events.length
    return events
  } finally { rangeMs += performance.now() - start }
}
const app = application()
const input = { idempotencyKey: 'benchmark:root', principalId: 'principal:player',
  action: { actionType: 'speak', parameters: { text: 'Hello everyone' } }, correlationId: 'benchmark' }
async function measure<T>(stage: string, work: () => Promise<T>) {
  readCalls = 0; returnedRows = 0; readMs = 0; rangeCalls = 0; rangeRows = 0; rangeMs = 0
  const start = performance.now()
  const result = await work()
  emit({ stage, additionalEvents: count, elapsedMs: performance.now() - start,
    readEventsCalls: readCalls, readEventsReturnedRows: returnedRows, readEventsInclusiveMs: readMs,
    readRangeCalls: rangeCalls, readRangeReturnedRows: rangeRows, readRangeInclusiveMs: rangeMs,
    providerCalls: script.calls.value, rssBytes: process.memoryUsage().rss, result })
  return result
}
try {
  await measure('root-cold-mount', () => app.submit(ADDRESS, input))
  const profiler = process.env['P9_PROFILE_WAVE'] === '1' ? new Session() : undefined
  profiler?.connect()
  const post = (method: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    assert(profiler)
    profiler.post(method, (error, result) => error ? reject(error) : resolve((result ?? {}) as Record<string, unknown>))
  })
  if (profiler) { await post('Profiler.enable'); await post('Profiler.start') }
  const wave = await (async () => {
    try { return await measure('reaction-wave', () => app.processNextBranchWork(ADDRESS, 'benchmark:wave')) }
    finally {
      if (profiler) {
        try { writeFileSync(join(directory, 'wave.cpuprofile'), JSON.stringify((await post('Profiler.stop'))['profile'])) }
        finally { profiler.disconnect() }
      }
    }
  })()
  assert.equal(wave.status, 'reaction_wave')
  assert.equal(script.calls.value, 2)
  await measure('root-idempotent-replay', () => app.submit(ADDRESS, input))
  assert.equal(script.calls.value, 2)
} finally {
  await app.close()
  WorldStore.prototype.readEvents = originalRead
  WorldStore.prototype.readEventsRange = originalRange
}
const verification = new WorldStore(worldPath)
try { emit({ stage: 'final-integrity', integrity: verification.verifyBranchIntegrity(ADDRESS) }) }
finally { verification.close() }
