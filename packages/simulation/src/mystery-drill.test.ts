import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('Mystery degradation drills', () => {
  it.each(Object.keys(expected) as MysteryDrillMode[])('%s commits, reports degradation, replays, and recovers', async mode => {
    const output = await runMysteryDrill({ mode, ...paths() }) as any
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
    }
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
