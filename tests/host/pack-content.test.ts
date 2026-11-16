import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActivityHooks, ContentGenerator, StatusModuleHooks } from '@perspectra/sdk'
import { assembleRoleplay } from '../../apps/host/src/official-bundle.ts'
import { copyRpgFixture, openRpgWorld } from '../support/rpg-fixture.ts'

// 非 RPG 的玩法内容插件示例：读取 cards.json 注册原生状态模块与原生活动，并按持久数据兼容声明校验存档。

type Json = Record<string, any>
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const addAsset = (pack: string, path: string, contents: string) => {
  mkdirSync(join(pack, path, '..'), { recursive: true })
  writeFileSync(join(pack, path), contents)
  const source = readJson(join(pack, 'worldpack.source.json'))
  source.assetFiles.push(path)
  if (path === 'cards.json') source.plugins['test-cards'] = {}
  if (path.startsWith('scripts/')) source.plugins['pack-scripts'] = {}
  writeJson(join(pack, 'worldpack.source.json'), source)
}
const withoutRpg = (pack: string) => {
  const source = readJson(join(pack, 'worldpack.source.json'))
  source.assetFiles = source.assetFiles.filter((path: string) => path !== 'rpg.json')
  delete source.plugins['official-rpg']
  writeJson(join(pack, 'worldpack.source.json'), source)
  rmSync(join(pack, 'rpg.json'))
}

interface CardsOptions {
  readonly dataVersion?: number
  readonly supportedDataVersions?: readonly number[]
  readonly quitText?: string
  readonly phases?: readonly string[]
  readonly statusType?: 'number' | 'string'
}

const cards = (options: CardsOptions = {}): ContentGenerator => ({
  id: 'test-cards',
  version: '1',
  configFile: 'cards.json',
  dataVersion: options.dataVersion ?? 1,
  ...(options.supportedDataVersions ? { supportedDataVersions: options.supportedDataVersions } : {}),
  ...(options.quitText ? { identity: { quitText: options.quitText } } : {}),
  generate(raw, pack) {
    const deck = (raw as { deck?: unknown }).deck
    if (typeof deck !== 'number') throw new TypeError('deck：需要是数字')
    const activity: ActivityHooks = {
      definition: {
        title: `牌桌（${deck} 张）`,
        npcIds: [],
        operations: [
          {
            id: 'quit',
            label: '离开牌桌',
            requiresTurn: false,
            schema: { type: 'object', additionalProperties: false, properties: {} },
          },
        ],
      },
      phases: options.phases ?? ['playing', 'ended'],
      initialize({ playerId }) {
        const pId = String(playerId)
        return {
          active: true,
          phase: 'playing',
          turn: pId,
          round: 1,
          public: {},
          private: { [pId]: {} },
          internal: {},
        }
      },
      policy() {
        return {
          speech: 'free',
          speechChoices: [],
          narration: false,
          move: false,
          interactions: [],
          operations: ['quit'],
        }
      },
      resolve(state) {
        const game = structuredClone(state.game) as Record<string, unknown>
        game.active = false
        game.phase = 'ended'
        game.turn = null
        return { game: game as never, description: options.quitText ?? '离开了牌桌。', audience: 'participants' }
      },
      schedule() {
        return { kind: 'wait' }
      },
      onOutcome() {
        return { kind: 'wait' }
      },
    }
    const statusType = options.statusType ?? 'number'
    const module: StatusModuleHooks = {
      definition: {
        statuses: [{ key: 'cards-deck', label: '牌堆', type: statusType, owner: 'public', alwaysKnown: true }],
        actions: [],
      },
      initialize(ids) {
        return {
          public: { 'cards-deck': statusType === 'number' ? deck : String(deck) },
          characters: Object.fromEntries(ids.map(id => [id, {}])),
        }
      },
      policy() {
        return { operations: [] }
      },
      resolve() {
        return { rejectReason: '没有这个操作。' }
      },
    }
    return {
      activities: [{ key: 'cards-table', activity }],
      statusModules: [
        {
          declaration: { id: 'cards', characters: [pack.playerId!], capabilities: [] },
          module,
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
  it('turns a pack config file into a native activity and status module with persistent compatibility metadata', async () => {
    const { pack, data } = copy(withCardsJson)
    const world = await open(pack, data, withCards())
    expect(world.runtime.activityDefinitions().map(d => d.activityKey)).toContain('cards-table')
    expect(world.runtime.statusDefinition().statuses.map(s => s.key)).toContain('cards-deck')
    expect(readJson(join(data, 'plugin-set.json')).gameplayData).toEqual({
      'test-cards': {
        pluginVersion: '1',
        dataVersion: 1,
        statuses: [{ key: 'cards-deck', type: 'number', owner: 'public' }],
        activities: [{ key: 'cards-table', phases: ['playing', 'ended'] }],
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
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

  it('opens an existing save after a compatible copy/logic fix, and diagnoses incompatible data semantics clearly', async () => {
    const { pack, data } = copy(withCardsJson)
    const first = await open(pack, data, withCards())
    await first.close()
    worlds.splice(worlds.indexOf(first), 1)
    const savedDigest = readJson(join(data, 'plugin-set.json')).gameplayData['test-cards'].digest as string

    // 文案与逻辑修复保持同一 dataVersion、状态含义与活动阶段，已有存档可正常打开并更新摘要。
    const compatible = await open(pack, data, withCards(cards({ quitText: '收起纸牌离开了牌桌。' })))
    const state = await compatible.runtime.state()
    expect(state.notice).toContain('test-cards 已按兼容声明载入更新')
    await compatible.close()
    worlds.splice(worlds.indexOf(compatible), 1)
    expect(readJson(join(data, 'plugin-set.json')).gameplayData['test-cards'].digest).not.toBe(savedDigest)

    // 向后兼容声明了旧版本的插件升级（dataVersion 2，但 supportedDataVersions 仍包含 1）同样允许读档。
    const backwardCompatible = await open(
      pack,
      data,
      withCards(cards({ dataVersion: 2, supportedDataVersions: [1, 2] })),
    )
    await backwardCompatible.close()
    worlds.splice(worlds.indexOf(backwardCompatible), 1)

    // 破坏性 dataVersion、状态类型变更或移除已声明活动阶段时，读档返回点名诊断。
    await expect(open(pack, data, withCards(cards({ dataVersion: 3, supportedDataVersions: [3] })))).rejects.toThrow(
      'test-cards 插件的数据版本与存档不兼容（存档 dataVersion 2，当前支持 3）',
    )
    await expect(
      open(pack, data, withCards(cards({ dataVersion: 2, supportedDataVersions: [1, 2], statusType: 'string' }))),
    ).rejects.toThrow('test-cards 插件的状态 cards-deck 含义与存档不兼容（存档 public/number，当前 public/string）')
    await expect(
      open(pack, data, withCards(cards({ dataVersion: 2, supportedDataVersions: [1, 2], phases: ['playing'] }))),
    ).rejects.toThrow('test-cards 插件的活动 cards-table 缺少存档所需的阶段标识 ended')
  })

  it('reports an explicit version boundary when encountering a legacy generatedContent record', async () => {
    const { pack, data } = copy(withCardsJson)
    const first = await open(pack, data, withCards())
    await first.close()
    worlds.splice(worlds.indexOf(first), 1)
    const record = readJson(join(data, 'plugin-set.json'))
    delete record.gameplayData
    record.generatedContent = { 'test-cards': 'sha256:' + '0'.repeat(64) }
    writeJson(join(data, 'plugin-set.json'), record)
    await expect(open(pack, data, withCards())).rejects.toThrow('存档记录使用旧版生成脚本摘要（generatedContent）')
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
