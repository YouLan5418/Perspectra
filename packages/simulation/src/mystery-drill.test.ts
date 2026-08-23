import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  executeMysteryDrillCli,
  mysteryDrillBranchHealth,
  parseMysteryDrillParticipantTerminals,
  parseMysteryDrillRecoveryCharacters,
  requireSubmittedMysteryDrillTurn,
  runMysteryDrill,
  type MysteryDrillMode,
} from './mystery-drill.ts'

const directories: string[] = []

function paths() {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-mystery-drill-'))
  directories.push(directory)
  return { worldPath: join(directory, 'world.sqlite'), sessionPath: join(directory, 'session.sqlite') }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const expected = {
  'agent-failure': ['provider_failed', 'proposed'],
  'agent-timeout': ['provider_timeout', 'proposed'],
  'budget-exhausted': ['budget_exhausted', 'budget_exhausted'],
  'director-fallback': ['proposed', 'provider_failed'],
  'memory-catchup-failure': ['runtime_unavailable', 'proposed'],
  'session-dead-letter': ['proposed', 'proposed'],
} satisfies Record<MysteryDrillMode, readonly string[]>

const degradedStatus = {
  'agent-failure': 'provider_failed',
  'agent-timeout': 'provider_timeout',
  'budget-exhausted': 'budget_exhausted',
  'director-fallback': 'provider_failed',
  'memory-catchup-failure': 'runtime_unavailable',
} as const

const degradedReason = {
  'agent-failure': 'provider failed',
  'agent-timeout': 'provider timed out',
  'budget-exhausted': 'model budget was exhausted',
  'director-fallback': 'provider failed',
  'memory-catchup-failure': 'Cognitive Memory catch-up failed',
} as const

describe('Mystery degradation drills', () => {
  it.each(Object.keys(expected) as MysteryDrillMode[])('%s commits, reports degradation, replays, and recovers', async mode => {
    const storage = paths()
    const output = await runMysteryDrill({ mode, ...storage }) as any
    expect(output).toMatchObject({
      mode,
      initial: {
        playerResult: { status: 'accepted', tick: 1 },
        health: { status: 'degraded', readyForWrite: true, readyForAgentCalls: false },
        replayProviderCalls: { bob: 0, director: 0 },
      },
      recovery: {
        playerResult: { status: 'accepted', tick: 2 },
        providerCalls: { bob: 1, director: 1 },
        health: { status: 'healthy', readyForAgentCalls: true },
      },
    })
    expect(output.initial.participantTerminals.slice(1).map((value: any) => value.terminalStatus)).toEqual(expected[mode])
    expect(output.initial.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'round.committed',
        details: expect.objectContaining({ participantTerminals: expect.any(Array), authorityHash: expect.stringMatching(/^sha256:/) }),
      }),
    ]))
    expect(output.initial.deliveryError === null).toBe(mode !== 'session-dead-letter')
    if (mode === 'session-dead-letter') {
      expect(output.initial.audit).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: 'outbox.dead-lettered' }),
      ]))
      expect(output.initial.metrics).toMatchObject({ sessionDeliveryFailures: 1 })
    } else {
      expect(output.initial.metrics.participantTerminals[degradedStatus[mode]]).toBeGreaterThan(0)
      expect(output.initial.health.characterAvailability).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringContaining(degradedReason[mode]) }),
      ]))
    }
    const world = new DatabaseSync(storage.worldPath, { readOnly: true })
    const authorityRow = world.prepare(`SELECT authority_json FROM round_authority ORDER BY rowid LIMIT 1`).get() as {
      authority_json: string
    }
    const authority = JSON.parse(authorityRow.authority_json) as any
    const failedParticipants = new Map(
      authority.participants
        .filter((participant: any) => participant.role !== 'player' && participant.terminalStatus !== 'proposed')
        .map((participant: any) => [participant.participantId, participant.actorId]),
    )
    expect(authority.actions.filter((action: any) => failedParticipants.has(action.participantId))).toEqual([])
    const observations = world.prepare(`
      SELECT data_json FROM events WHERE tick = 1 AND event_type = 'observation.upsert'
    `).all().map((row: any) => JSON.parse(row.data_json))
    expect(observations.filter((data: any) => [...failedParticipants.values()].includes(data.value?.content?.actorId))).toEqual([])
    world.close()

    const memory = new DatabaseSync(`${storage.worldPath}.memory.sqlite`, { readOnly: true })
    const unverified = memory.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_sources s
      LEFT JOIN memory_source_mappings m
        ON m.namespace_key = s.namespace_key AND m.source_kind = s.source_kind AND m.source_id = s.source_id
      WHERE m.source_id IS NULL OR m.source_seq != s.source_seq OR m.source_hash != s.source_hash
    `).get() as { count: number }
    const memoryText = memory.prepare(`SELECT text_value FROM memory_entries`).all()
    expect(unverified.count).toBe(0)
    expect(JSON.stringify(memoryText)).not.toMatch(/provider failed|provider timed out|budget was exhausted|catch-up failure/u)
    memory.close()
    expect(JSON.stringify(output)).not.toContain('is_culprit')
    expect(JSON.stringify(output)).not.toContain('memoryRecall')
  })

  it('exposes a fresh-path CLI with canonical player-safe output', async () => {
    await expect(executeMysteryDrillCli([])).rejects.toThrow('usage')
    await expect(runMysteryDrill({ mode: 'unknown' as MysteryDrillMode, ...paths() })).rejects.toThrow('unknown')
    const storage = paths()
    const text = await executeMysteryDrillCli(['agent-failure', storage.worldPath, storage.sessionPath])
    expect(JSON.parse(text)).toMatchObject({ mode: 'agent-failure', recovery: { health: { status: 'healthy' } } })
    expect(text).not.toContain('is_culprit')
    await expect(executeMysteryDrillCli(['agent-failure', storage.worldPath, storage.sessionPath])).rejects.toThrow('fresh')
  })

  it('fails closed on malformed drill evidence instead of publishing partial diagnostics', () => {
    expect(() => mysteryDrillBranchHealth(join(tmpdir(), 'missing-mystery-drill.sqlite'))).toThrow('no branch')
    expect(() => parseMysteryDrillParticipantTerminals(undefined)).toThrow('no participants')
    expect(() => parseMysteryDrillParticipantTerminals({ participants: [null] })).toThrow('Authority is malformed')
    expect(() => parseMysteryDrillParticipantTerminals({ participants: [{}] })).toThrow('terminal is malformed')
    expect(() => parseMysteryDrillRecoveryCharacters(undefined)).toThrow('availability is malformed')
    expect(() => parseMysteryDrillRecoveryCharacters([null])).toThrow('character availability is malformed')
    expect(() => parseMysteryDrillRecoveryCharacters([{}])).toThrow('character availability is malformed')
    expect(parseMysteryDrillRecoveryCharacters([
      { characterId: 'character:ready', state: 'ready' },
      { characterId: 'character:offline', state: 'offline' },
    ])).toEqual(['character:offline'])
    expect(() => requireSubmittedMysteryDrillTurn({
      status: 'clarification_required', reason: 'fixture', candidates: [],
    })).toThrow('required clarification')
  })
})
