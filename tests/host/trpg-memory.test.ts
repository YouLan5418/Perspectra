import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { brandId, type WorldJsonObject } from '@perspectra/sdk/contracts'
import { AuthorizedSourceStore } from '@perspectra/core/memory'
import { CharacterViewBuilder, WorldStore } from '@perspectra/core/store'
import { openRpgWorld } from '../support/rpg-fixture.ts'

// What characters remember of a TRPG game. Long-term memory distills each character's authorized sources
// (AuthorizedSourceStore, read by official-memory-core); short-term context reads the same observations. Both are
// checked here, like the hosted guessing game: the game's lines arrive marked with the activity they belong to.

const FIXTURE = resolve('tests/fixtures/trpg-pack')
const PLAYER = 'character:player',
  ARU = 'character:aru',
  CHENG = 'character:cheng',
  MEI = 'character:mei'
type Json = Record<string, any>

const roots: string[] = []
const worlds: Awaited<ReturnType<typeof openRpgWorld>>[] = []
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

/** Aru hosts the authored scenario for the player and Cheng; Mei stays in the room but does not play. */
async function playedGame() {
  const root = mkdtempSync(join(tmpdir(), 'trpg-memory-'))
  roots.push(root)
  const pack = join(root, 'pack'),
    data = join(root, 'data')
  cpSync(FIXTURE, pack, { recursive: true })
  mkdirSync(data)
  const plans: Record<string, ((activity: Json) => unknown)[]> = {}
  const world = await openRpgWorld(pack, data, {
    decide: input => {
      const context = input.context as Json
      const me = context.character.characterId as string
      const next = plans[me]?.[0]
      if (input.continuation || !next || !context.activity) return { decision: 'abstain' }
      plans[me]!.shift()
      return next(context.activity)
    },
  })
  worlds.push(world)
  const host = (...moves: [string, Json][]) => {
    plans[ARU] = moves.map(([operation, args]) => activity => ({
      decision: 'perform',
      actionType: 'interact',
      parameters: {
        targetRef: { kind: 'character', id: ARU },
        bindingId: activity.id,
        definitionRef: { id: 'activity:' + operation, version: 1 },
        arguments: { activityId: activity.id, revision: activity.revision, ...args },
      },
    }))
  }
  const state = () =>
    (world.events().findLast(e => e.eventType === 'activity.updated')?.data as Json).state as {
      id: string
      revision: number
      game: Json
    }
  const act = (operation: string, parameters: Json = {}) =>
    world.runtime.activityAction({
      activityKey: 'trpg',
      activityId: operation === 'start' ? null : state().id,
      revision: operation === 'start' ? 0 : state().revision,
      operation,
      parameters,
      requestId: randomUUID(),
    })

  await act('start', { npcIds: [ARU, CHENG] })
  host(['respond', { accept: true }])
  await act('setup', { hostId: ARU, scenario: 'rainy-manor' })
  host(
    ['check', { targetId: PLAYER, skill: 'agility', difficulty: 12, hidden: false }],
    ['announce', { text: '门锁卡住了，撬棍发出一声刺耳的响动。' }],
  )
  await act('propose', { text: '我想撬开书房的门。' })
  const id = state().id
  const [roll] = state().game.private[ARU].rolls as Json[]
  expect(roll).toBeDefined()
  await act('end', { ending: '天亮了，你们离开了古宅。' })
  expect(state().game.phase).toBe('ended')

  const read = <T>(use: (store: WorldStore) => T) => {
    const store = new WorldStore(join(data, 'world.sqlite'))
    try {
      return use(store)
    } finally {
      store.close()
    }
  }
  /** The observation contents this character holds now. */
  const observed = (characterId: string) =>
    read(store =>
      new CharacterViewBuilder(store)
        .rebuildAt(
          world.runtime.address,
          brandId(characterId, 'CharacterId'),
          store.head(world.runtime.address).headSeq,
        )
        .observations.map(o => ((o.value as WorldJsonObject).content ?? {}) as Json),
    )
  /** The texts long-term memory distills for this character, brought up to the head the way a turn does. */
  const remembered = (characterId: string) =>
    read(store => {
      const memory = new AuthorizedSourceStore(join(data, 'memory.sqlite'), store)
      try {
        const head = store.head(world.runtime.address).headSeq
        const character = brandId(characterId, 'CharacterId')
        memory.catchUp(world.runtime.address, character, head)
        return memory.sources(world.runtime.address, character, head).map(s => s.text)
      } finally {
        memory.close()
      }
    })
  const line = `玩家的敏捷检定：${roll!.dice[0]}+0=${roll!.total}，难度12，${roll!.total >= 12 ? '成功' : '失败'}`
  return { id, line, observed, remembered }
}

it('after the game, participants remember the outcome as part of the TRPG activity and only the roller and host remember the total', async () => {
  const f = await playedGame()
  /** Canonical JSON sorts keys, so the activity's id follows its other fields. */
  const ofGame = new RegExp(`"resultMetadata":\\{"activity":\\{[^}]*"id":"${f.id}"`, 'u')
  for (const id of [PLAYER, ARU, CHENG]) {
    // The announced outcome, the opening and the end are each remembered as lines of this activity.
    for (const text of ['跑团《雨夜古宅》开始', '门锁卡住了，撬棍发出一声刺耳的响动。', '天亮了，你们离开了古宅。']) {
      const memories = f.remembered(id).filter(m => m.includes(text))
      expect(memories.length, `${id} remembers ${text}`).toBeGreaterThan(0)
      for (const memory of memories) expect(memory).toMatch(ofGame)
    }
    const outcome = f.observed(id).find(o => o.resultDescription === '门锁卡住了，撬棍发出一声刺耳的响动。')!
    expect(outcome.resultMetadata).toMatchObject({ activity: { id: f.id, active: true } })
    const ending = f.observed(id).find(o => String(o.resultDescription ?? '').includes('天亮了'))!
    expect(ending.resultMetadata).toMatchObject({ activity: { id: f.id, active: false, lifecycle: 'ended' } })
  }
  // The total: the roller and the host, as a line of the same game.
  for (const id of [PLAYER, ARU]) {
    const memories = f.remembered(id).filter(m => m.includes(f.line))
    expect(memories).toHaveLength(1)
    expect(memories[0]).toMatch(ofGame)
    const note = f.observed(id).find(o => o.resultDescription === f.line)!
    expect(note.resultMetadata).toMatchObject({ activity: { id: f.id } })
  }
  expect(f.remembered(CHENG).join('\n')).not.toContain('敏捷检定：')
  expect(f.remembered(CHENG).join('\n')).toContain('玩家进行了一次敏捷检定。')
  expect(JSON.stringify(f.observed(CHENG))).not.toContain('敏捷检定：')
})

it('a character who did not take part has no observation of the game', async () => {
  const f = await playedGame()
  const seen = JSON.stringify(f.observed(MEI)),
    memories = f.remembered(MEI).join('\n')
  for (const text of [f.id, '古宅', '撬棍', '敏捷检定', '天亮了', '跑团']) {
    expect(seen).not.toContain(text)
    expect(memories).not.toContain(text)
  }
})
