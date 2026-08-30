import { mkdtempSync, rmSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openContextDatabase } from '@harness-world/agents'
import { brandId, compareWorldText, worldAddressKey, type WorldAddress } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'

const HISTORY_ROWS = 10_000
const MAX_EVENT_WINDOW = 128
const MAX_ACTIVE_JOB_CANDIDATES = 256
const MAX_REACTION_CALLS = 8
const MAX_QUERY_MS = 2_000
const directories: string[] = []

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'hcw-p8-performance-'))
  directories.push(value)
  return value
}

function address(): WorldAddress {
  return {
    tenantId: brandId('tenant:p8-performance', 'TenantId'),
    worldId: brandId('world:p8-performance', 'WorldId'),
    branchId: brandId('branch:main', 'BranchId'),
  }
}

function planDetails(db: DatabaseSync, sql: string, ...parameters: SQLInputValue[]): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<{ detail: string }>)
    .map(row => row.detail)
}

function expectIndexed(details: readonly string[]): void {
  expect(details.some(detail => detail.includes('SEARCH'))).toBe(true)
  expect(details.every(detail => !detail.startsWith('SCAN '))).toBe(true)
}

afterEach(() => {
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('Phase 8.3 fixed-data performance gates', () => {
  it('reads only the latest Observation window from a 10,000 Event history', () => {
    const path = join(directory(), 'world.sqlite')
    const target = address()
    const key = worldAddressKey(target)
    const setup = new WorldStore(path)
    setup.createBranch(target)
    setup.close()
    const seed = new DatabaseSync(path)
    seed.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE')
    seed.prepare(`
      INSERT INTO round_commits(
        transaction_id, address_key, request_hash, round_id, base_head_seq, base_tick,
        head_seq, tick, bundle_hash, authority_hash
      ) VALUES ('transaction:p8-performance', ?, 'sha256:request', 'round:p8-performance', 0, 0, ?, 1,
        'sha256:bundle', NULL)
    `).run(key, HISTORY_ROWS)
    const insert = seed.prepare(`
      INSERT INTO events(
        address_key, seq, tick, event_type, event_version, data_json, previous_hash,
        event_hash, transaction_id, event_ordinal
      ) VALUES (?, ?, 1, ?, 1, ?, ?, ?, 'transaction:p8-performance', ?)
    `)
    for (let seq = 1; seq <= HISTORY_ROWS; seq += 1) {
      insert.run(
        key, seq, seq % 2 === 0 ? 'observation.upsert' : 'fixture.event',
        JSON.stringify({ id: `event:${seq}`, value: seq }),
        seq === 1 ? 'genesis' : `sha256:event:${seq - 1}`,
        `sha256:event:${seq}`, seq - 1,
      )
    }
    seed.prepare('UPDATE heads SET head_seq = ?, tick = 1, event_hash = ? WHERE address_key = ?')
      .run(HISTORY_ROWS, `sha256:event:${HISTORY_ROWS}`, key)
    seed.exec('COMMIT')
    const eventSql = `
      SELECT seq FROM events
      WHERE address_key = ? AND seq > ? AND seq <= ? AND event_type IN (?) ORDER BY seq
    `
    expectIndexed(planDetails(
      seed, eventSql, key, HISTORY_ROWS - MAX_EVENT_WINDOW, HISTORY_ROWS, 'observation.upsert',
    ))
    seed.close()

    const store = new WorldStore(path)
    const startedAt = performance.now()
    const events = store.readEventsRange(
      target, HISTORY_ROWS - MAX_EVENT_WINDOW, HISTORY_ROWS, ['observation.upsert'],
    )
    const elapsedMs = performance.now() - startedAt
    store.close()
    expect(events).toHaveLength(MAX_EVENT_WINDOW / 2)
    expect(events[0]!.seq).toBe(HISTORY_ROWS - MAX_EVENT_WINDOW + 2)
    expect(elapsedMs).toBeLessThan(MAX_QUERY_MS)
  })

  it('locates one Checkpoint by prefix index without scanning 10,000 rows', () => {
    const path = join(directory(), 'context.sqlite')
    const db = openContextDatabase(path)
    db.exec('BEGIN IMMEDIATE')
    const insert = db.prepare(`
      INSERT INTO continuity_checkpoints(
        checkpoint_id, namespace_key, as_of_seq, checkpoint_json, checkpoint_hash
      ) VALUES (?, 'namespace:p8-performance', ?, '{}', 'sha256:checkpoint')
    `)
    for (let seq = 1; seq <= HISTORY_ROWS; seq += 1) insert.run(`checkpoint:${seq}`, seq)
    db.exec('COMMIT')
    const sql = `
      SELECT checkpoint_id FROM continuity_checkpoints
      WHERE namespace_key = ? AND as_of_seq <= ? ORDER BY as_of_seq DESC LIMIT 1
    `
    expectIndexed(planDetails(db, sql, 'namespace:p8-performance', HISTORY_ROWS))
    const startedAt = performance.now()
    const latest = db.prepare(sql).get('namespace:p8-performance', HISTORY_ROWS)
    const elapsedMs = performance.now() - startedAt
    db.close()
    expect(latest).toEqual({ checkpoint_id: `checkpoint:${HISTORY_ROWS}` })
    expect(elapsedMs).toBeLessThan(MAX_QUERY_MS)
  })

  it('selects a bounded active Job set before UTF-16 budget ordering and call truncation', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE reaction_job_candidates(
        address_key TEXT NOT NULL,
        wave INTEGER NOT NULL,
        character_id TEXT NOT NULL,
        stimulus_hash TEXT NOT NULL,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY(address_key, job_id)
      ) STRICT;
      CREATE INDEX reaction_job_candidates_active
        ON reaction_job_candidates(address_key, status, wave, character_id, stimulus_hash, job_id);
      BEGIN IMMEDIATE;
    `)
    const insert = db.prepare(`
      INSERT INTO reaction_job_candidates(address_key, wave, character_id, stimulus_hash, job_id, status)
      VALUES ('world:p8-performance', 1, ?, ?, ?, ?)
    `)
    for (let index = 0; index < HISTORY_ROWS; index += 1) {
      const active = index >= HISTORY_ROWS - MAX_ACTIVE_JOB_CANDIDATES
      insert.run(
        `character:${String(index).padStart(5, '0')}`,
        `sha256:${String(HISTORY_ROWS - index).padStart(64, '0')}`,
        `job:${String(index).padStart(5, '0')}`,
        active ? 'pending' : 'settled',
      )
    }
    db.exec('COMMIT')
    const sql = `
      SELECT character_id, stimulus_hash, job_id FROM reaction_job_candidates
      WHERE address_key = ? AND status = 'pending' AND wave = ?
    `
    expectIndexed(planDetails(db, sql, 'world:p8-performance', 1))
    const startedAt = performance.now()
    const candidates = db.prepare(sql).all('world:p8-performance', 1) as Array<{
      character_id: string
      stimulus_hash: string
      job_id: string
    }>
    const selected = candidates.sort((left, right) => compareWorldText(left.character_id, right.character_id)
      || compareWorldText(left.stimulus_hash, right.stimulus_hash)
      || compareWorldText(left.job_id, right.job_id)).slice(0, MAX_REACTION_CALLS)
    const elapsedMs = performance.now() - startedAt
    db.close()
    expect(candidates).toHaveLength(MAX_ACTIVE_JOB_CANDIDATES)
    expect(selected).toHaveLength(MAX_REACTION_CALLS)
    expect(selected[0]!.job_id).toBe(`job:${String(HISTORY_ROWS - MAX_ACTIVE_JOB_CANDIDATES).padStart(5, '0')}`)
    expect(elapsedMs).toBeLessThan(MAX_QUERY_MS)
  })
})
