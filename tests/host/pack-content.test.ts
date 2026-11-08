import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContentGenerator } from '@harness-world/plugin-sdk'
import { assembleRoleplay } from '../../desktop/official-bundle.ts'
import { copyRpgFixture, openRpgWorld } from '../support/rpg-fixture.ts'

// A content generator that is not the RPG: cards.json becomes one activity and one status module. It is registered
// through the composition like any other generator, so the host serves it with no code of its own.

type Json = Record<string, any>
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const addAsset = (pack: string, path: string, contents: string) => {
  mkdirSync(join(pack, path, '..'), { recursive: true })
  writeFileSync(join(pack, path), contents)
  const source = readJson(join(pack, 'worldpack.source.json'))
  source.assetFiles.push(path)
  writeJson(join(pack, 'worldpack.source.json'), source)
}
/** The fixture without its rpg.json, so only the cards generator has anything to read. */
const withoutRpg = (pack: string) => {
  const source = readJson(join(pack, 'worldpack.source.json'))
  source.assetFiles = source.assetFiles.filter((path: string) => path !== 'rpg.json')
  writeJson(join(pack, 'worldpack.source.json'), source)
  rmSync(join(pack, 'rpg.json'))
}

const cards = (extra = ''): ContentGenerator => ({
  id: 'test-cards',
  version: '1',
  configFile: 'cards.json',
  generate(raw, pack) {
    const deck = (raw as { deck?: unknown }).deck
    if (typeof deck !== 'number') throw new TypeError('deck：需要是数字')
    const activity = `globalThis.activityScript = {
  definition: { title: ${JSON.stringify(`牌桌（${deck} 张）`)}, npcIds: [], operations: [
    { id: 'quit', label: '离开牌桌', requiresTurn: false, schema: { type: 'object', additionalProperties: false, properties: {} } },
  ] },
  initialize({ playerId }) { return { active: true, phase: 'playing', turn: playerId, round: 1, public: {}, private: { [playerId]: {} }, internal: {} } },
  policy() { return { speech: 'free', speechChoices: [], narration: false, move: false, interactions: [], operations: ['quit'] } },
  resolve(state) { const game = JSON.parse(JSON.stringify(state.game)); game.active = false; game.turn = null; return { game, description: '离开了牌桌。', audience: 'participants' } },
  schedule() { return { kind: 'wait' } },
  onOutcome() { return { kind: 'wait' } },
};${extra}
`
    const module = `globalThis.packPlugin = {
  definition: { statuses: [{ key: 'cards-deck', label: '牌堆', type: 'number', owner: 'public', alwaysKnown: true }], actions: [] },
  initialize(ids) { return { public: { 'cards-deck': ${deck} }, characters: Object.fromEntries(ids.map(id => [id, {}])) } },
  policy() { return { operations: [] } },
  resolve() { return { rejectReason: '没有这个操作。' } },
}
`
    return {
      activities: [{ key: 'cards-table', source: activity }],
      statusModules: [
        {
          declaration: { id: 'cards', entry: 'plugins/cards.js', characters: [pack.playerId!], capabilities: [] },
          source: module,
        },
      ],
    }
  },
})
const withCards = (generator = cards()) => ({ composition: assembleRoleplay({ content: [generator] }) })

const roots: string[] = []
const copy = (edit?: (pack: string) => void) => {
  const copied = copyRpgFixture({
    edit: pack => {
      withoutRpg(pack)
      edit?.(pack)
    },
  })
  roots.push(copied.root)
  return copied
}
const withCardsJson = (pack: string) =>
  addAsset(pack, 'cards.json', JSON.stringify({ plugin: { id: 'test-cards', version: '1' }, deck: 52 }))
const worlds: Awaited<ReturnType<typeof openRpgWorld>>[] = []
const open = async (...args: Parameters<typeof openRpgWorld>) => {
  const world = await openRpgWorld(...args)
  worlds.push(world)
  return world
}
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

describe('a content generator registered through the composition', () => {
  it('turns a pack config file into an activity and a status module', async () => {
    const { pack, data } = copy(withCardsJson)
    const world = await open(pack, data, withCards())
    expect(world.runtime.activityDefinitions().map(d => d.activityKey)).toContain('cards-table')
    expect(world.runtime.statusDefinition().statuses.map(s => s.key)).toContain('cards-deck')
    expect(readJson(join(data, 'plugin-set.json')).generatedContent).toEqual({
      'test-cards': expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    })
  })

  it("a generated activity that clashes with the pack's own fails before the world opens", async () => {
    const { pack, data } = copy(pack => {
      withCardsJson(pack)
      addAsset(pack, 'scripts/activities/cards-table.js', '// mine\n')
    })
    await expect(open(pack, data, withCards())).rejects.toThrow(
      'test-cards 插件生成的活动 cards-table 与包内 scripts/activities/cards-table.js 重名',
    )
    expect(existsSync(join(data, 'world.sqlite'))).toBe(false)
  })

  it('a save refuses to open when what the generator makes has changed', async () => {
    const { pack, data } = copy(withCardsJson)
    const first = await open(pack, data, withCards())
    await first.close()
    worlds.splice(worlds.indexOf(first), 1)
    const saved = readJson(join(data, 'plugin-set.json')).generatedContent['test-cards'] as string
    await expect(open(pack, data, withCards(cards('\n// changed')))).rejects.toThrow(
      `test-cards 插件生成的规则与存档不一致（存档 ${saved}，当前 `,
    )
    // The same generator opens the save again.
    const again = await open(pack, data, withCards())
    expect(again.events().length).toBeGreaterThan(0)
  })

  it('a pack without the config file opens as it would without the generator', async () => {
    const plain = copy()
    const installed = await open(plain.pack, plain.data, withCards())
    const before = copy()
    const previous = await open(before.pack, before.data, { composition: assembleRoleplay({ content: [] }) })
    const shape = (events: ReturnType<typeof installed.events>) =>
      events.map(e => ({ seq: e.worldSeq, type: e.eventType, data: e.data }))
    expect(shape(installed.events())).toEqual(shape(previous.events()))
    expect(installed.runtime.activityDefinitions().map(d => d.activityKey)).not.toContain('cards-table')
    expect(readJson(join(plain.data, 'plugin-set.json'))).toEqual(readJson(join(before.data, 'plugin-set.json')))
  })
})
