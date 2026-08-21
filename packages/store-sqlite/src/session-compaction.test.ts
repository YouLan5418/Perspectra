import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, hashWorldJson } from '@harness-world/contracts'
import { SessionCompactor } from './session-compaction.ts'
import { SessionDeliveryAdapter, SESSION_SCHEMA_VERSION } from './session-delivery.ts'
import { readPragmaInteger } from './sqlite.ts'

const directories: string[] = []

function database(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-session-compaction-'))
  directories.push(directory)
  return join(directory, 'session.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('SessionCompactor', () => {
  it('summarizes exact delivery ranges without deleting original Session events', async () => {
    const path = database()
    const sessionId = brandId('session:compact', 'SessionId')
    const adapter = new SessionDeliveryAdapter(path)
    for (const [index, payload] of [
      { observationId: 'observation:1', worldSeq: 10, content: 'first' },
      { observationId: 'observation:2', worldSeq: 12, content: 'second' },
      'primitive-tail',
    ].entries()) {
      await adapter.appendIfAbsent({
        sessionId,
        sessionDeliverySeq: index + 1,
        deliveryId: brandId(`delivery:compact:${index + 1}`, 'DeliveryId'),
        payloadHash: hashWorldJson('session-compact-payload', payload),
        observationEvent: payload,
        correlationId: 'compact-fixture',
      })
    }
    const compactor = new SessionCompactor(path)
    const summary = compactor.compact(sessionId, 1, 2)
    expect(summary).toMatchObject({
      summaryVersion: 1,
      sourceDeliveryRange: { from: 1, to: 2 },
      observationIds: ['observation:1', 'observation:2'],
      minWorldSeq: 10,
      maxWorldSeq: 12,
    })
    expect(compactor.compact(sessionId, 1, 2)).toEqual(summary)
    const tail = compactor.compact(sessionId, 3, 3)
    expect(tail).toMatchObject({ observationIds: [], minWorldSeq: null, maxWorldSeq: null })
    expect(compactor.readSummaries(sessionId)).toEqual([summary, tail])
    expect(adapter.readEvent(sessionId, 1)?.payload).toMatchObject({ observationId: 'observation:1' })
    expect(adapter.readEvent(sessionId, 3)?.payload).toBe('primitive-tail')
    expect(() => compactor.compact(sessionId, 0, 1)).toThrow(RangeError)
    expect(() => compactor.compact(sessionId, 2, 1)).toThrow(RangeError)
    expect(() => compactor.compact(sessionId, 1, 4)).toThrow('not contiguous')
    compactor.close()
    adapter.close()

    const raw = new DatabaseSync(path)
    expect(readPragmaInteger(raw, 'user_version')).toBe(SESSION_SCHEMA_VERSION)
    raw.close()
  })

  it('fails closed when a summary range is already bound to divergent bytes', async () => {
    const path = database()
    const sessionId = brandId('session:corrupt-summary', 'SessionId')
    const adapter = new SessionDeliveryAdapter(path)
    const payload = { observationId: 'observation:corrupt', worldSeq: 1 }
    await adapter.appendIfAbsent({
      sessionId,
      sessionDeliverySeq: 1,
      deliveryId: brandId('delivery:corrupt-summary', 'DeliveryId'),
      payloadHash: hashWorldJson('session-compact-payload', payload),
      observationEvent: payload,
      correlationId: 'corrupt-summary',
    })
    adapter.close()
    const first = new SessionCompactor(path)
    first.compact(sessionId, 1, 1)
    first.close()
    const raw = new DatabaseSync(path)
    raw.prepare(`UPDATE session_summaries SET content_hash = 'sha256:corrupt'`).run()
    raw.close()
    const corrupted = new SessionCompactor(path)
    expect(() => corrupted.compact(sessionId, 1, 1)).toThrow('different content')
    corrupted.close()
  })
})
