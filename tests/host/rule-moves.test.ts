import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
import { currentLocation } from '@harness-world/kernel'
import type { RulesInstance, SeamProvider } from '@harness-world/plugin-sdk'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { afterEach, expect, it } from 'vitest'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { createChatServer, fakeModels } from '../support/fake-provider.ts'

// dynamic-scheduling: the player and friend start in the back room, companion and witness in the front room.
const PLAYER = 'character:player',
  FRIEND = 'character:friend',
  COMPANION = 'character:companion',
  WITNESS = 'character:witness'
const FRONT = 'location:front-room',
  BACK = 'location:back-room'
const act = (locationId: string) => `/act move {"locationId":"${locationId}"}`

const roots: string[] = [],
  servers: Server[] = [],
  runtimes: WorldHostRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A test-only follow rule: after `leader` moves to `target`, `follower` comes along if they were together. The
 * follower's move has the shape the base move rule emits, so only the host decides what it means. */
function follow(leader: string, follower: string, target: string): SeamProvider<RulesInstance> {
  const instance: RulesInstance = {
    resolve: (context, next) => {
      const result = next(context)
      const to = (context.action.parameters as { locationId?: string } | undefined)?.locationId
      const from = currentLocation(context.events, follower)
      if (
        result.status !== 'accepted' ||
        context.action.actionType !== 'move' ||
        context.characterId !== leader ||
        to !== target ||
        from !== currentLocation(context.events, leader)
      )
        return result
      return {
        ...result,
        events: [
          ...result.events,
          {
            eventType: 'character.moved',
            eventVersion: 1,
            data: { characterId: follower, fromLocationId: from ?? null, toLocationId: to },
          },
        ],
      }
    },
  }
  return { id: 'test-follow', version: '1.0.0', open: async () => instance }
}

/** A test-only rule that, once `actor` speaks, sends `mover` to `target` while the speaker stays where she is. */
function sendAway(actor: string, mover: string, target: string): SeamProvider<RulesInstance> {
  let sent = false
  const instance: RulesInstance = {
    resolve: (context, next) => {
      const result = next(context)
      if (
        sent ||
        result.status !== 'accepted' ||
        context.action.actionType !== 'speak' ||
        context.characterId !== actor
      )
        return result
      sent = true
      const from = currentLocation(context.events, mover)
      return {
        ...result,
        events: [
          ...result.events,
          {
            eventType: 'character.moved',
            eventVersion: 1,
            data: { characterId: mover, fromLocationId: from ?? null, toLocationId: target },
          },
        ],
      }
    },
  }
  return { id: 'test-send-away', version: '1.0.0', open: async () => instance }
}

/** Each character answers from `answers` once, then abstains. */
async function start(rules: SeamProvider<RulesInstance>, answers: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'perspectra-rule-moves-'))
  roots.push(root)
  const used = new Set<string>()
  const server = createChatServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += String(chunk)
    })
    request.on('end', () => {
      const last = String(JSON.parse(body).messages.at(-1).content)
      const id = last.startsWith('{')
        ? String(((JSON.parse(last).context as WorldJsonObject).character as WorldJsonObject).characterId)
        : ''
      const answer = answers[id] !== undefined && !used.has(id) ? answers[id] : { decision: 'abstain' }
      if (answers[id] !== undefined) used.add(id)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }))
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const runtime = await WorldHostRuntime.create({
    dataDirectory: root,
    packPath: resolve('examples/world-packs/dynamic-scheduling'),
    models: fakeModels('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions'),
    timeoutMs: 5000,
    serialScheduling: true,
    plugins: { rules: [rules] },
  })
  runtimes.push(runtime)
  const read = <T>(work: (store: WorldStore) => T): T => {
    const store = new WorldStore(join(root, 'world.sqlite'))
    try {
      return work(store)
    } finally {
      store.close()
    }
  }
  return { runtime, read }
}

type Movement = { characterId: string; fromLocationId?: string; toLocationId?: string }

/** What one character's view says about how `mover` moved, one entry per observed action. */
function seenMoves(store: WorldStore, address: WorldHostRuntime['address'], observer: string, mover: string) {
  return new CharacterViewBuilder(store)
    .rebuildAt(address, brandId(observer, 'CharacterId'), store.head(address).headSeq)
    .observations.map(entry => (entry.value as { content?: { movement?: Movement } }).content?.movement)
    .filter((movement): movement is Movement => movement?.characterId === mover)
}

function sceneChanges(store: WorldStore, address: WorldHostRuntime['address'], characterId: string) {
  return store
    .readEvents(address)
    .filter(
      event =>
        event.eventType.startsWith('scene.member_') && (event.data as WorldJsonObject).characterId === characterId,
    )
    .map(event => [event.eventType, (event.data as WorldJsonObject).sceneId])
}

it('gives a scene transition to every moved character, not only the actor', async () => {
  const { runtime, read } = await start(follow(PLAYER, COMPANION, BACK))
  await runtime.submit(act(FRONT))
  await runtime.submit(act(BACK))
  read(store => {
    expect(sceneChanges(store, runtime.address, PLAYER)).toEqual([
      ['scene.member_left', 'scene:back-room'],
      ['scene.member_joined', 'scene:front-room'],
      ['scene.member_left', 'scene:front-room'],
      ['scene.member_joined', 'scene:back-room'],
    ])
    expect(sceneChanges(store, runtime.address, COMPANION)).toEqual([
      ['scene.member_left', 'scene:front-room'],
      ['scene.member_joined', 'scene:back-room'],
    ])
    // The follower moves in the same commit as the leader.
    const moves = store.readEvents(runtime.address).filter(event => event.eventType === 'character.moved')
    expect(moves.at(-1)!.transactionId).toBe(moves.at(-2)!.transactionId)
  })
})

it('those left behind see each mover leave and those at the destination see her arrive', async () => {
  const { runtime, read } = await start(follow(PLAYER, COMPANION, BACK))
  await runtime.submit(act(FRONT))
  await runtime.submit(act(BACK))
  read(store => {
    const address = runtime.address
    // The witness stays in the front room: she sees both go, not where to.
    expect(seenMoves(store, address, WITNESS, COMPANION)).toEqual([{ characterId: COMPANION, fromLocationId: FRONT }])
    expect(seenMoves(store, address, WITNESS, PLAYER)).toContainEqual({ characterId: PLAYER, fromLocationId: FRONT })
    // The friend waits in the back room: she sees both come, not where from.
    expect(seenMoves(store, address, FRIEND, COMPANION)).toEqual([{ characterId: COMPANION, toLocationId: BACK }])
    expect(seenMoves(store, address, FRIEND, PLAYER)).toContainEqual({ characterId: PLAYER, toLocationId: BACK })
    // The one who came along knows her whole route.
    expect(seenMoves(store, address, COMPANION, COMPANION)).toEqual([
      { characterId: COMPANION, fromLocationId: FRONT, toLocationId: BACK },
    ])
  })
})

it('does the same when a character, not the player, leads', async () => {
  const { runtime, read } = await start(follow(COMPANION, WITNESS, BACK), {
    [COMPANION]: { decision: 'perform', actionType: 'move', parameters: { locationId: BACK } },
  })
  await runtime.submit(act(FRONT))
  read(store => {
    const address = runtime.address
    expect(sceneChanges(store, address, WITNESS)).toEqual([
      ['scene.member_left', 'scene:front-room'],
      ['scene.member_joined', 'scene:back-room'],
    ])
    expect(seenMoves(store, address, PLAYER, WITNESS)).toEqual([{ characterId: WITNESS, fromLocationId: FRONT }])
    expect(seenMoves(store, address, FRIEND, WITNESS)).toEqual([{ characterId: WITNESS, toLocationId: BACK }])
  })
})

it('tells an actor who stays only that the other left, and the far room nothing of her action', async () => {
  const { runtime, read } = await start(sendAway(PLAYER, FRIEND, FRONT))
  await runtime.submit('你好。')
  read(store => {
    const address = runtime.address
    expect(sceneChanges(store, address, FRIEND)).toEqual([
      ['scene.member_left', 'scene:back-room'],
      ['scene.member_joined', 'scene:front-room'],
    ])
    // The player stays in the back room: she sees the friend go, not where to.
    expect(seenMoves(store, address, PLAYER, FRIEND)).toEqual([{ characterId: FRIEND, fromLocationId: BACK }])
    for (const observer of [COMPANION, WITNESS]) {
      expect(seenMoves(store, address, observer, FRIEND)).toEqual([{ characterId: FRIEND, toLocationId: FRONT }])
      const contents = new CharacterViewBuilder(store)
        .rebuildAt(address, brandId(observer, 'CharacterId'), store.head(address).headSeq)
        .observations.map(entry => (entry.value as { content?: WorldJsonObject }).content)
      // What reaches the front room is the friend's arrival alone, not the player's words or who made her come.
      expect(contents.filter(content => content?.actorId === PLAYER)).toEqual([])
      expect(contents.filter(content => content?.actorId === FRIEND)).toEqual([
        {
          actorId: FRIEND,
          actionType: 'moved',
          status: 'accepted',
          movement: { characterId: FRIEND, toLocationId: FRONT },
        },
      ])
    }
  })
})
