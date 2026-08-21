import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  deterministicId,
  type AgentProvider,
} from '@harness-world/contracts'
import { ProjectionRebuilder, WorldStore } from '@harness-world/store-sqlite'
import { fixtureAddress } from '@harness-world/testkit'
import {
  NoopDirectorProvider,
  RuleDirectorProvider,
  ScriptedAgentProvider,
  ScriptedDirectorProvider,
  WorldSimulation,
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

function simulation(store: WorldStore, agents: readonly AgentProvider[] = [], directors = [new NoopDirectorProvider()]) {
  return new WorldSimulation({
    store,
    address: fixtureAddress(),
    playerCharacterId: brandId('character:player', 'CharacterId'),
    playerSessionId: brandId('session:player', 'SessionId'),
    agents,
    directors,
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
    const first = await simulation(store, [agent], [new NoopDirectorProvider(), director]).submitPlayerMessage({
      idempotencyKey: 'message-1',
      text: '原样保留',
    })
    expect(first.actions.map(value => value.actionType)).toEqual(['character.speak', 'character.wave', 'character.observe'])
    expect(store.readEvents(address)[0]?.data).toMatchObject({ parameters: { text: '原样保留' } })
    const firstHash = first.commit.bundleHash
    store.close()

    const restarted = new WorldStore(path)
    const replay = await simulation(restarted, [agent], [new NoopDirectorProvider(), director]).submitPlayerMessage({
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
    const result = await simulation(store, [], [scripted]).submitPlayerMessage({ idempotencyKey: 'scripted', text: 'hello' })
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
    await expect(simulation(store, [tooMany]).submitPlayerMessage({ idempotencyKey: 'many', text: 'hello' })).rejects.toThrow('more than two')

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
    await expect(simulation(store, [repeated]).submitPlayerMessage({ idempotencyKey: 'repeat', text: 'hello' })).rejects.toThrow('repeated')

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
    await expect(simulation(store, [unbounded]).submitPlayerMessage({ idempotencyKey: 'unbounded', text: 'hello' }))
      .rejects.toThrow('two-action limit')

    const duplicateA = new ScriptedAgentProvider('same-participant', () => [])
    const duplicateB = new ScriptedAgentProvider('same-participant', () => [])
    await expect(simulation(store, [duplicateA, duplicateB]).submitPlayerMessage({ idempotencyKey: 'duplicate', text: 'hello' }))
      .rejects.toThrow('duplicate participant')
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
