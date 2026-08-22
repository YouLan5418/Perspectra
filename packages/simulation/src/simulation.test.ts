import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  deterministicId,
  type AgentProvider,
  type WorldEventDraft,
} from '@harness-world/contracts'
import { ProjectionRebuilder, WorldStore } from '@harness-world/store-sqlite'
import { fixtureAddress } from '@harness-world/testkit'
import {
  NoopDirectorProvider,
  RuleDirectorProvider,
  ScriptedAgentProvider,
  ScriptedDirectorProvider,
  WorldSimulation,
  type SimulationActionResolution,
  type SimulationParticipantBinding,
  type SimulationRulebook,
} from './index.ts'

const directories: string[] = []
function database(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-simulation-'))
  directories.push(directory)
  return join(directory, 'world.sqlite')
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

class FixtureRulebook implements SimulationRulebook {
  resolve(action: Parameters<SimulationRulebook['resolve']>[0]): SimulationActionResolution {
    const events: WorldEventDraft[] = action.actionType === 'character.observe'
      ? []
      : [{
          eventType: 'character.acted',
          eventVersion: 1,
          data: { actionId: action.actionId, actorId: action.actorId, actionType: action.actionType, parameters: action.parameters },
        }]
    return action.actionType === 'character.observe'
      ? { status: 'rejected', events, reason: 'fixture rule rejected observation' }
      : { status: 'accepted', events }
  }
}

function bind(
  provider: AgentProvider,
  actorId: string,
  allowedActionTypes: readonly string[],
  participantId?: string,
): SimulationParticipantBinding {
  return {
    participantId: participantId ?? ('participantId' in provider && typeof provider.participantId === 'string'
      ? provider.participantId
      : 'agent:anonymous'),
    actorId: brandId(actorId, 'CharacterId'),
    allowedActionTypes,
    provider,
  }
}

function simulation(
  store: WorldStore,
  agents: readonly SimulationParticipantBinding[] = [],
  directors: readonly SimulationParticipantBinding[] = [],
) {
  return new WorldSimulation({
    store,
    address: fixtureAddress(),
    playerCharacterId: brandId('character:player', 'CharacterId'),
    playerSessionId: brandId('session:player', 'SessionId'),
    agents,
    directors,
    rulebook: new FixtureRulebook(),
  })
}

describe('no-model simulation', () => {
  it('runs player-first Scripted/Rule/Noop providers and restarts deterministically', async () => {
    const path = database()
    const address = fixtureAddress()
    const store = new WorldStore(path)
    store.createBranch(address)
    const agent = new ScriptedAgentProvider('agent:npc', () => [{
      actorId: brandId('character:npc', 'CharacterId'),
      actionType: 'character.wave',
      actionVersion: 1,
      parameters: {},
    }])
    const director = new RuleDirectorProvider('director:rule', () => [{
      actorId: brandId('character:guard', 'CharacterId'),
      actionType: 'character.observe',
      actionVersion: 1,
      parameters: {},
    }])
    const first = await simulation(store, [bind(agent, 'character:npc', ['character.wave'])], [
      bind(new NoopDirectorProvider(), 'character:noop', []),
      bind(director, 'character:guard', ['character.observe']),
    ]).submitPlayerMessage({
      idempotencyKey: 'message-1',
      text: '原样保留',
    })
    expect(first.actions.map(value => value.actionType)).toEqual(['character.speak', 'character.wave', 'character.observe'])
    expect(store.readEvents(address).filter(value => value.eventType === 'action.resolved').map(value => value.data)).toMatchObject([
      { accepted: true },
      { accepted: true },
      { accepted: false, reason: 'fixture rule rejected observation' },
    ])
    expect(store.readEvents(address)[0]?.data).toMatchObject({ parameters: { text: '原样保留' } })
    const firstHash = first.commit.bundleHash
    store.close()

    const restarted = new WorldStore(path)
    const replay = await simulation(restarted, [bind(agent, 'character:npc', ['character.wave'])], [
      bind(new NoopDirectorProvider(), 'character:noop', []),
      bind(director, 'character:guard', ['character.observe']),
    ]).submitPlayerMessage({
      idempotencyKey: 'message-1',
      text: '原样保留',
    })
    expect(replay.commit).toMatchObject({ status: 'already_committed', bundleHash: firstHash })
    const view = new ProjectionRebuilder(restarted).rebuildAt(address, restarted.head(address).headSeq)
    expect(view.observations).toHaveLength(3)
    restarted.close()
  })

  it('supports a round-addressed Scripted Director', async () => {
    const store = new WorldStore(database())
    store.createBranch(fixtureAddress())
    const roundId = deterministicId('round', { address: fixtureAddress(), idempotencyKey: 'scripted' })
    const scripted = new ScriptedDirectorProvider('director:scripted', {
      [roundId]: [{
        actorId: brandId('character:scripted', 'CharacterId'),
        actionType: 'character.nod',
        actionVersion: 1,
        parameters: {},
      }],
    })
    const result = await simulation(store, [], [bind(scripted, 'character:scripted', ['character.nod'])])
      .submitPlayerMessage({ idempotencyKey: 'scripted', text: 'hello' })
    expect(result.actions).toHaveLength(2)
    expect((await scripted.propose({
      address: fixtureAddress(),
      roundId: brandId('round:missing', 'InteractionRoundId'),
      tick: 1,
      playerAction: result.actions[0]!,
      candidateHash: result.commit.bundleHash,
    })).actions).toEqual([])
    store.close()
  })

  it('rejects invalid input and provider proposals', async () => {
    const store = new WorldStore(database())
    store.createBranch(fixtureAddress())
    await expect(simulation(store).submitPlayerMessage({ idempotencyKey: '', text: 'hello' })).rejects.toThrow('idempotencyKey')
    await expect(simulation(store).submitPlayerMessage({ idempotencyKey: 'key', text: '' })).rejects.toThrow('message')

    const tooMany = new ScriptedAgentProvider('agent:many', () => [0, 1, 2].map(value => ({
      actorId: brandId(`character:${value}`, 'CharacterId'),
      actionType: 'test',
      actionVersion: 1,
      parameters: {},
    })))
    await expect(simulation(store, [bind(tooMany, 'character:many', ['test'])]).submitPlayerMessage({ idempotencyKey: 'many', text: 'hello' }))
      .rejects.toThrow('more than two')

    const repeated: AgentProvider = {
      async propose() {
        const action = {
          actionId: 'same',
          actorId: brandId('character:npc', 'CharacterId'),
          actionType: 'test',
          actionVersion: 1,
          parameters: {},
        }
        return { participantId: 'agent:repeat', actions: [action, action] }
      },
    }
    await expect(simulation(store, [bind(repeated, 'character:npc', ['test'], 'agent:repeat')]).submitPlayerMessage({ idempotencyKey: 'repeat', text: 'hello' }))
      .rejects.toThrow('unique')

    const unbounded: AgentProvider = {
      async propose() {
        return {
          participantId: 'agent:unbounded',
          actions: [0, 1, 2].map(value => ({
            actionId: `unique:${value}`,
            actorId: brandId(`character:unique:${value}`, 'CharacterId'),
            actionType: 'test',
            actionVersion: 1,
            parameters: {},
          })),
        }
      },
    }
    await expect(simulation(store, [bind(unbounded, 'character:unique:0', ['test'], 'agent:unbounded')]).submitPlayerMessage({ idempotencyKey: 'unbounded', text: 'hello' }))
      .rejects.toThrow('maxActions')

    const duplicateA = bind(new ScriptedAgentProvider('same-participant', () => []), 'character:a', [])
    const duplicateB = bind(new ScriptedAgentProvider('same-participant', () => []), 'character:b', [])
    expect(() => simulation(store, [duplicateA, duplicateB])).toThrow('must be unique')

    const forgedActor: AgentProvider = {
      async propose() {
        return {
          participantId: 'agent:forged',
          actions: [{
            actionId: 'action:forged',
            actorId: brandId('character:victim', 'CharacterId'),
            actionType: 'character.wave',
            actionVersion: 1,
            parameters: {},
          }],
        }
      },
    }
    await expect(simulation(store, [{
      participantId: 'agent:forged',
      actorId: brandId('character:authorized', 'CharacterId'),
      allowedActionTypes: ['character.wave'],
      provider: forgedActor,
    }]).submitPlayerMessage({ idempotencyKey: 'forged', text: 'hello' })).rejects.toThrow('actorId is not authorized')
    expect(store.readEvents(fixtureAddress())).toHaveLength(0)

    const safe = new ScriptedAgentProvider('agent:safe', () => [{
      actorId: brandId('character:safe', 'CharacterId'),
      actionType: 'character.wave',
      actionVersion: 1,
      parameters: {},
    }])
    const defaultRejected = await new WorldSimulation({
      store,
      address: fixtureAddress(),
      playerCharacterId: brandId('character:player', 'CharacterId'),
      playerSessionId: brandId('session:player', 'SessionId'),
      agents: [bind(safe, 'character:safe', ['character.wave'])],
    }).submitPlayerMessage({ idempotencyKey: 'default-reject', text: 'hello' })
    const providerResolution = store.readEvents(fixtureAddress())
      .find(value => value.eventType === 'action.resolved' && (value.data as { actionId?: string }).actionId === defaultRejected.actions[1]?.actionId)
    expect(providerResolution?.data).toMatchObject({ accepted: false, reason: 'no authoritative Simulation Rulebook is configured' })
    const noProviders = new WorldSimulation({
      store,
      address: fixtureAddress(),
      playerCharacterId: brandId('character:player', 'CharacterId'),
      playerSessionId: brandId('session:player', 'SessionId'),
    })
    await expect(noProviders.submitPlayerMessage({ idempotencyKey: 'no-providers', text: 'hello' })).resolves.toMatchObject({ proposals: [] })
    store.close()
  })
})
