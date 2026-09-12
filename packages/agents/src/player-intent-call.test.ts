import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { fixtureAddress } from '@harness-world/testkit'
import { PlayerIntentCallStore } from './player-intent-call.ts'

it('persists one dispatch and exact response without masquerading as a Round participant', () => {
  const root = mkdtempSync(join(tmpdir(), 'intent-call-'))
  const path = join(root, 'context.sqlite')
  const calls = new PlayerIntentCallStore(path)
  try {
    expect(calls.read('absent')).toBeUndefined()
    const prepared = calls.prepare(fixtureAddress(), 'input:1', { text: 'original' })
    expect(calls.prepare(fixtureAddress(), 'input:1', { text: 'original' })).toEqual(prepared)
    expect(() => calls.prepare(fixtureAddress(), 'input:1', { text: 'other' })).toThrow('conflict')
    expect(calls.start(prepared.modelCallId)).toBe(true)
    expect(calls.start(prepared.modelCallId)).toBe(false)
    expect(calls.respond(prepared.modelCallId, { answer: 'hold' })).toBe(true)
    expect(calls.respond(prepared.modelCallId, { answer: 'hold' })).toBe(true)
    expect(() => calls.respond(prepared.modelCallId, { answer: 'other' })).toThrow('conflict')
    calls.finish(prepared.modelCallId, 'response_received', 'validated')
    calls.finish(prepared.modelCallId, 'response_received', 'validated')
    expect(calls.respond(prepared.modelCallId, { answer: 'hold' })).toBe(true)
    const reopened = new PlayerIntentCallStore(path)
    expect(reopened.read(prepared.modelCallId)).toEqual(calls.read(prepared.modelCallId))
    reopened.close()
    const raw = new DatabaseSync(path)
    expect(raw.prepare('SELECT purpose,work_id,round_id,participant_id,receipt_id FROM provider_calls').get()).toEqual({
      purpose: 'player_intent', work_id: 'input:1', round_id: null, participant_id: null, receipt_id: null,
    })
    raw.close()
  } finally { calls.close(); rmSync(root, { recursive: true, force: true }) }
})

it('makes ambiguous dispatch terminal, records only late response hashes and rejects invalid transitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'intent-call-terminal-'))
  const path = join(root, 'context.sqlite')
  const calls = new PlayerIntentCallStore(path)
  try {
    const call = calls.prepare(fixtureAddress(), 'i', {})
    calls.start(call.modelCallId)
    calls.finish(call.modelCallId, 'dispatch_started', 'timed_out_ambiguous')
    expect(calls.respond(call.modelCallId, { late: 'do not adopt' })).toBe(false)
    expect(calls.start(call.modelCallId)).toBe(false)
    expect(calls.read(call.modelCallId)?.response).toBeNull()
    expect(() => calls.respond('missing', {})).toThrow('missing')
    expect(() => calls.finish('missing', 'dispatch_started', 'timed_out_ambiguous')).toThrow('conflict')
    expect(() => calls.finish(call.modelCallId, 'validated', 'validated')).toThrow('invalid')
    expect(() => calls.finish(call.modelCallId, 'prepared', 'validated')).toThrow('invalid')
    const cancelled = calls.prepare(fixtureAddress(), 'before', {})
    calls.finish(cancelled.modelCallId, 'prepared', 'failed_before_dispatch')
    const raw = new DatabaseSync(path)
    expect(raw.prepare('SELECT COUNT(*) AS n FROM player_intent_late_responses').get()).toEqual({ n: 1 })
    raw.prepare('UPDATE provider_calls SET request_json = ? WHERE model_call_id = ?').run('{"changed":true}', call.modelCallId)
    expect(() => calls.read(call.modelCallId)).toThrow('conflict')
    raw.prepare('UPDATE provider_calls SET request_json = ?,response_json = ?,response_hash = ? WHERE model_call_id = ?').run('{}', '{}', 'bad', call.modelCallId)
    expect(() => calls.read(call.modelCallId)).toThrow('conflict')
    raw.close()
  } finally { calls.close(); rmSync(root, { recursive: true, force: true }) }
})
