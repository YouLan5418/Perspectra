import { playSettings, type PlaySettings } from '../../apps/host/src/play-settings.ts'
import { createRoleplayCore } from '../support/roleplay-runtime.ts'
import { type Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { type WorldJsonObject } from '@perspectra/sdk/contracts'
import { compileWorldPackSource } from '@perspectra/world-pack'
import { WorldStore } from '@perspectra/core/store'
import { currentEntityState, currentLocation } from '@perspectra/core/kernel'
import { WorldHostCore } from '../../apps/host/src/runtime/world-runtime.ts'
import { PacingScript } from '../../packages/plugins/src/pacing/index.ts'
import { projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { loadStatus } from '../support/status-runtime.ts'
import { createChatServer, fakeModels } from '../support/fake-provider.ts'

const roots: string[] = [],
  servers: Server[] = [],
  runtimes: WorldHostCore[] = []
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
})

async function fixture(
  initialLocations: Record<string, string> = {
    'character:claude': 'location:workspace',
    'character:deepseek': 'location:kitchen',
  },
  decision: WorldJsonObject = { decision: 'abstain' },
  includePrologue = false,
  battleAgent = false,
  pacing = false,
  settings: Partial<PlaySettings> = {},
  initialDay = 1,
) {
  const root = mkdtempSync(join(tmpdir(), 'model-girls-sweet-days-'))
  roots.push(root)
  const pack = join(root, 'pack'),
    data = join(root, 'data')
  cpSync(resolve('examples/world-packs/model-girls-sweet-days'), pack, { recursive: true })
  // These cases pin each event's own conditions, so pacing's draws stay out unless a case is about them.
  if (!pacing) {
    const sourcePath = join(pack, 'worldpack.source.json')
    const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
    source.assetFiles = source.assetFiles.filter((asset: string) => asset !== 'scripts/pacing.js')
    writeFileSync(sourcePath, JSON.stringify(source))
  }
  if (!includePrologue) {
    const sourcePath = join(pack, 'worldpack.source.json')
    const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
    source.assetFiles = source.assetFiles.filter((asset: string) => asset !== 'scripts/activities/prologue.js')
    writeFileSync(sourcePath, JSON.stringify(source))
    const statusPath = join(pack, 'scripts/status.js')
    writeFileSync(
      statusPath,
      readFileSync(statusPath, 'utf8').replace(
        "day: 0,\n        slot: '深夜'",
        'day: ' + initialDay + ",\n        slot: '清晨'",
      ),
    )
  }
  const characters = JSON.parse(readFileSync(join(pack, 'characters.json'), 'utf8'))
  for (const character of characters.characters) {
    character.initialLocationId =
      initialLocations[character.characterId] ??
      (
        { 'character:claude': 'location:workspace', 'character:deepseek': 'location:kitchen' } as Record<string, string>
      )[character.characterId] ??
      character.initialLocationId
  }
  writeFileSync(join(pack, 'characters.json'), JSON.stringify(characters))
  const scenes = JSON.parse(readFileSync(join(pack, 'scenes.json'), 'utf8'))
  for (const scene of scenes.scenes) {
    scene.participantIds = characters.characters
      .filter((c: { initialLocationId: string }) => c.initialLocationId === scene.locationId)
      .map((c: { characterId: string }) => c.characterId)
    scene.lifecycle = scene.participantIds.length ? 'active' : 'created'
  }
  writeFileSync(join(pack, 'scenes.json'), JSON.stringify(scenes))
  const compiled = await compileWorldPackSource(pack, [])
  const status = loadStatus(pack, compiled)!
  // Context of every character request, in call order, for tests that check what a character was told.
  const contexts: WorldJsonObject[] = []
  const requests: { actorId: string; messages: { role: string; content: string }[] }[] = []
  const server = createChatServer((request, response) => {
    let body = ''
    request.on('data', chunk => (body += String(chunk)))
    request.on('end', () => {
      const messages = JSON.parse(body).messages as { role: string; content: string }[]
      const user = messages.findLast(m => m.role === 'user')
      let answer = decision
      if (user?.content.startsWith('{"context"')) {
        const input = JSON.parse(user.content)
        contexts.push(input.context)
        requests.push({ actorId: input.context.character.characterId, messages })
        const activity = input.context.activity
        if (battleAgent && activity?.activityKey === 'game-battle' && activity.game?.active) {
          const self = input.context.character.characterId
          answer = input.continuation
            ? { decision: 'publish', segments: [{ type: 'speech', text: '这一击命中了！' }] }
            : {
                decision: 'perform',
                actionType: 'interact',
                parameters: {
                  targetRef: { kind: 'character', id: self },
                  bindingId: activity.id,
                  definitionRef: { id: 'activity:attack', version: 1 },
                  arguments: { activityId: activity.id, revision: activity.revision },
                },
              }
        }
      }
      respond(answer)
    })
    const respond = (answer: WorldJsonObject) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [{ function: { name: 'submit_actions', arguments: JSON.stringify(answer) } }],
              },
            },
          ],
        }),
      )
    }
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  const runtime = await createRoleplayCore({
    packPath: pack,
    dataDirectory: data,
    models: fakeModels('http://127.0.0.1:' + port + '/v1/chat/completions', 'openai', 'fixture'),
    timeoutMs: 5000,
    playSettings: playSettings(settings),
  })
  runtimes.push(runtime)
  const events = () => {
    const store = new WorldStore(join(data, 'world.sqlite'))
    try {
      return store.readEvents(runtime.address)
    } finally {
      store.close()
    }
  }
  const view = async () => projectPlayerView(await runtime.state())
  const actions = async () => (await view()).actions
  const act = async (label: string, extra: WorldJsonObject = {}) => {
    const action = (await actions()).find(a => a.label === label)
    expect(action, label).toBeDefined()
    return runtime.perform(
      Object.keys(extra).length
        ? {
            ...action!.action,
            parameters: {
              ...action!.action.parameters,
              arguments: { ...(action!.action.parameters.arguments as WorldJsonObject | undefined), ...extra },
            },
          }
        : action!.action,
    )
  }
  const kind = (id: string) => currentEntityState(events(), id)?.kind
  const holder = (id: string) => currentEntityState(events(), id)?.holderId
  const truth = () => status.truth(events())
  const known = (id: string) => status.known(events(), id)
  return { runtime, events, view, actions, act, kind, holder, truth, known, contexts, requests }
}

it('plays the complete prologue and enters the first morning with committed dialogue', async () => {
  const f = await fixture(
    { 'character:claude': 'location:living-room', 'character:deepseek': 'location:living-room' },
    { decision: 'abstain' },
    true,
  )
  expect(f.truth().public).toMatchObject({ day: 0, slot: '深夜' })
  const opening = (await f.view()).actions.find(action => action.label === '开始 序章：房间里突然多了三个人')!
  expect(opening.target).toMatchObject({ kind: 'activity', id: 'prologue' })
  expect(opening.action.parameters.definitionRef).toMatchObject({ id: 'host:activity-start' })
  await f.act('开始 序章：房间里突然多了三个人')
  const next = (await f.view()).actions.find(action => action.label === '继续序章')!
  expect(next.target).toMatchObject({ kind: 'activity', id: 'prologue' })
  expect(next.action.parameters.definitionRef).toMatchObject({ id: 'activity:next' })
  let steps = 0
  while (steps++ < 60) {
    const labels = (await f.actions()).map(action => action.label)
    if (labels.includes('继续序章')) await f.act('继续序章')
    else break
  }
  const state = await f.runtime.state()
  const game = (state.activities as WorldJsonObject[]).find(a => a.activityKey === 'prologue')?.game
  expect(game).toMatchObject({ active: false, phase: 'finished' })
  expect(f.truth().public).toMatchObject({ day: 1, slot: '清晨' })
  const events = JSON.stringify(f.events())
  expect(events).toContain('商量之后，屋主同意让她们先暂时住下来')
  expect(events).toContain('那间书房很安静')
  expect(events).toContain('早餐吃什么')
  expect(f.contexts).toHaveLength(0)
  for (const id of ['character:player', 'character:gpt', 'character:claude', 'character:deepseek'])
    expect(currentLocation(f.events(), id)).toBe('location:living-room')
  expect((await f.actions()).map(action => action.label)).toContain('推进到下一时段（大家各自忙一阵）')
}, 120_000)

it('starts together and carries a meal from the kitchen to the living room', async () => {
  const pack = resolve('examples/world-packs/model-girls-sweet-days')
  const characters = JSON.parse(readFileSync(join(pack, 'characters.json'), 'utf8'))
  expect(characters.characters.map((character: { initialLocationId: string }) => character.initialLocationId)).toEqual([
    'location:living-room',
    'location:living-room',
    'location:living-room',
    'location:living-room',
  ])
  const f = await fixture({
    'character:claude': 'location:living-room',
    'character:deepseek': 'location:living-room',
  })
  await f.act('前往 厨房')
  await f.act('做一锅热乎的黄金蛋炒饭')
  await f.act('拿起餐盘')
  await f.act('前往 客厅')
  await f.act('放下餐盘')
  expect(currentEntityState(f.events(), 'entity:meal-platter')).toMatchObject({
    locationId: 'location:living-room',
    holderId: null,
  })
  expect(f.kind('entity:meal-platter')).toContain('黄金蛋炒饭')
  await f.act('前往 卫生间')
  expect(currentLocation(f.events(), 'character:player')).toBe('location:toilet')
  await f.act('前往 浴室')
  expect(currentLocation(f.events(), 'character:player')).toBe('location:bathroom')
})

it('lets the player visit each newly assigned bedroom', async () => {
  const f = await fixture()
  for (const [label, location] of [
    ['GPT 的卧室', 'location:gpt-bedroom'],
    ['DeepSeek 的卧室', 'location:deepseek-bedroom'],
    ['Claude 的卧室（书房）', 'location:workspace'],
  ]) {
    await f.act(`前往 ${label}`)
    expect(currentLocation(f.events(), 'character:player')).toBe(location)
  }
})

it('supports part-time work, shop purchases, feast cooking, and midnight fridge autoStart with DeepSeek', async () => {
  const f = await fixture()
  await f.act('前往 玄关与街角商店')

  const shopLabels = (await f.actions()).map(a => a.label)
  expect(shopLabels).toContain('外出兼职打工（+120元 · 消耗1精力并度过1时段）')
  expect(shopLabels).toContain('付款购买特级料理食材包')
  expect(shopLabels).toContain('付款购买限定草莓小蛋糕')
  // Shop shelf items cannot be taken without paying first.
  expect(shopLabels).not.toContain('拿起限定草莓小蛋糕')

  // Work part-time twice: 清晨 -> 午后 (+120 = 240), 午后 -> 傍晚 (+120 = 360)
  await f.act('外出兼职打工（+120元 · 消耗1精力并度过1时段）')
  await f.act('外出兼职打工（+120元 · 消耗1精力并度过1时段）')

  // Buy feast ingredients (40) and strawberry cake (50)
  await f.act('付款购买特级料理食材包')
  expect(f.holder('entity:fresh-ingredients')).toBe('character:player')
  expect(f.kind('entity:fresh-ingredients')).not.toMatch(/^【商店货架/u)

  await f.act('付款购买限定草莓小蛋糕')
  expect(f.holder('entity:strawberry-cake')).toBe('character:player')

  // Advance from 傍晚 to 深夜
  await f.act('推进到下一时段（大家各自忙一阵）')

  // Enter kitchen at 深夜 where DeepSeek is located -> autoStarts midnight-fridge!
  const kitchenState = await f.act('前往 厨房')
  const running = (kitchenState.activities as WorldJsonObject[]).find(
    a => (a.game as WorldJsonObject | undefined)?.active === true,
  )
  expect(running).toMatchObject({
    activityKey: 'midnight-fridge',
    title: '深夜冰箱的偷吃抓包',
  })

  // Resolve midnight-fridge as partners in crime
  await f.act('小声关上门：「见者有份，我们一人一半当共犯」')
  expect(JSON.stringify(f.events())).toContain('从现在开始，我们就是深夜厨房探险队！')
  expect(
    ((await f.runtime.state()).activities as WorldJsonObject[]).find(a => a.activityKey === 'midnight-fridge')?.game,
  ).toMatchObject({
    active: false,
    phase: 'finished',
  })

  // Cook the feast in the kitchen using the bought ingredients
  const feast = (await f.actions()).find(a => a.label === '用特级食材做一桌合家欢大餐（消耗1精力）')!
  await f.runtime.perform(feast.action)
  expect(f.kind('entity:kitchen-pot')).toMatch(/^丰盛的海鲜和牛合家欢大餐/u)
  expect(f.truth().characters['character:player']!.energy).toBe(0)
  expect((await f.actions()).map(a => a.label)).not.toContain(feast.label)
  await f.act('结束今天，休息迎接明天（恢复满精力）')
  expect(f.truth().characters['character:player']!.energy).toBe(3)
  expect((await f.actions()).map(a => a.label)).not.toContain(feast.label)
  const before = f.events().length
  await expect(f.runtime.perform(feast.action)).rejects.toThrow()
  expect(f.events()).toHaveLength(before)
})

it('triggers starlight-finale autoStart when turning on the star projector and supports the true harem route', async () => {
  const f = await fixture({ 'character:claude': 'location:living-room', 'character:deepseek': 'location:living-room' })
  await f.act('前往 玄关与街角商店')
  await f.act('外出兼职打工（+120元 · 消耗1精力并度过1时段）')
  await f.act('外出兼职打工（+120元 · 消耗1精力并度过1时段）')

  // Now at 傍晚 with 360 yuan: buy star projector (150) and family passes (200)
  await f.act('付款购买家用星空投影仪')
  await f.act('付款购买游乐园四人家庭套票')
  expect(f.holder('entity:star-projector')).toBe('character:player')
  expect(f.holder('entity:family-passes')).toBe('character:player')

  // Return to living room where GPT is present, and turn on the star projector
  await f.act('前往 客厅')
  const stateAfterStars = await f.act('开启家用星空投影仪（化作漫天星海）')
  const finale = (stateAfterStars.activities as WorldJsonObject[]).find(
    a => (a.game as WorldJsonObject | undefined)?.active === true,
  )
  expect(finale).toMatchObject({
    activityKey: 'starlight-finale',
    title: '星海下的屋檐约定',
  })
  expect((finale!.game as WorldJsonObject).public).toMatchObject({
    持有信物: '游乐园四人家庭套票（玩家持有）',
  })

  await f.act('拿出全员心意：「我谁都不想放手，以后这个家我们四个永远在一起！」（真·后宫路线）')
  expect((await f.actions()).map(a => a.label)).not.toContain('结束星空下的心意交谈，继续一起生活')
  // Abstaining is not agreement. The player explicitly postpones each unanswered response.
  for (let i = 0; i < 3; i++) await f.act('让她稍后再说，先听下一位（不视为同意）')
  await f.act('结束星空下的心意交谈，继续一起生活')
  expect(
    ((await f.runtime.state()).activities as WorldJsonObject[]).find(a => a.activityKey === 'starlight-finale')?.game,
  ).toMatchObject({
    active: false,
    phase: 'finished',
  })
})

const work = '外出兼职打工（+120元 · 消耗1精力并度过1时段）'
const direct = '窗外闷雷滚过，啪的一声，屋里的灯灭了。'
const distant = '远处传来闷雷，朝家的方向望去，那一片住宅的灯光暗了下来。'

function outage(f: Awaited<ReturnType<typeof fixture>>) {
  const rows = f.events()
  const power = rows.filter(
    row =>
      row.eventType === 'status.updated' &&
      ((row.data as WorldJsonObject).changes as WorldJsonObject[]).some(
        change => change.key === 'power-on' && change.value === false,
      ),
  )
  expect(power).toHaveLength(1)
  const tx = power[0]!.transactionId
  const clock = rows.findLast(
    row =>
      row.eventType === 'status.updated' &&
      ((row.data as WorldJsonObject).changes as WorldJsonObject[]).some(c => c.key === 'slot' && c.value === '傍晚') &&
      row.seq < power[0]!.seq,
  )
  expect(clock).toBeDefined()
  expect(clock!.transactionId).not.toBe(tx)
  const notices = rows
    .filter(row => row.transactionId === tx && row.eventType === 'observation.upsert')
    .map(row => (row.data as WorldJsonObject).value as WorldJsonObject)
  expect(new Set(notices.map(n => n.observerId)).size).toBe(notices.length)
  expect(
    rows
      .filter(row => row.seq < power[0]!.seq)
      .some(row => JSON.stringify(row.data).includes(direct) || JSON.stringify(row.data).includes(distant)),
  ).toBe(false)
  return Object.fromEntries(notices.map(n => [String(n.observerId), (n.content as WorldJsonObject).eventNotice]))
}

it('settles work wages and energy before the outage and leaves a non-participating park visitor unwarned', async () => {
  const f = await fixture(
    { 'character:deepseek': 'location:amusement-park' },
    undefined,
    false,
    false,
    false,
    { autonomyOpportunities: 0 },
    2,
  )
  await f.act('前往 玄关与街角商店')
  const before = f.truth().characters['character:player']!
  await f.act(work)
  expect(f.truth().public['power-on']).toBe(true)
  await f.act(work)
  expect(f.truth().characters['character:player']).toMatchObject({
    money: Number(before.money) + 240,
    energy: Number(before.energy) - 2,
  })
  expect(outage(f)).toEqual({ 'character:player': direct, 'character:gpt': direct, 'character:claude': direct })
}, 60_000)

it('keeps a blackout through cooking and overnight rest until power is actually repaired', async () => {
  const f = await fixture(undefined, undefined, false, false, false, { autonomyOpportunities: 0 })
  // Buy strawberry cake in entrance shop first
  await f.act('前往 玄关与街角商店')
  await f.act('付款购买限定草莓小蛋糕')
  await f.act('前往 客厅')

  // Advance Day 1: 清晨 -> 午后 -> 傍晚 -> 深夜 -> sleep to Day 2 清晨
  await f.act('推进到下一时段（大家各自忙一阵）')
  await f.act('推进到下一时段（大家各自忙一阵）')
  await f.act('推进到下一时段（大家各自忙一阵）')
  await f.act('结束今天，休息迎接明天（恢复满精力）')

  // Day 2: 清晨 -> 午后 -> 傍晚 (triggers 雨夜跳闸停电 + blackout-comfort autoStart in living room with GPT!)
  await f.act('推进到下一时段（大家各自忙一阵）')
  const stateDay2Evening = await f.act('推进到下一时段（大家各自忙一阵）')
  const blackout = (stateDay2Evening.activities as WorldJsonObject[]).find(
    a => (a.game as WorldJsonObject | undefined)?.active === true,
  )
  expect(blackout).toMatchObject({
    activityKey: 'blackout-comfort',
    title: '雨夜停电的黑暗陪伴',
  })
  await f.act('在黑暗中伸出手，轻声安慰身边的人')
  expect(JSON.stringify(f.events())).toContain('等我们准备好了，再一起想办法恢复供电吧。')
  await f.act('前往 厨房')
  await f.act('做一锅热乎的黄金蛋炒饭')
  expect(f.truth().public['power-on']).toBe(false)
  await f.act('推进到下一时段（大家各自忙一阵）')
  // Complete the one-time fridge encounter if it starts while waiting in the kitchen.
  const labels = (await f.actions()).map(a => a.label)
  if (labels.includes('小声关上门：「见者有份，我们一人一半当共犯」')) {
    await f.act('小声关上门：「见者有份，我们一人一半当共犯」')
  }
  await f.act('结束今天，休息迎接明天（恢复满精力）')
  expect(f.truth().public['power-on']).toBe(false)
  await f.act('前往 玄关与街角商店')
  await f.act('用工具包合闸恢复全屋供电')
  expect(f.truth().public['power-on']).toBe(true)
  expect(outage(f)['character:player']).toBe(direct)
  // Two in-game days of rounds; under the full parallel suite this exceeds the default 30 s.
}, 90_000)

it('rejects morning sleep without committing a day change', async () => {
  const f = await fixture()
  const before = f.events().length
  expect((await f.actions()).map(a => a.label)).not.toContain('结束今天，休息迎接明天（恢复满精力）')
  await expect(f.runtime.submit('/status sleep-next-day {}')).rejects.toThrow('当前已知条件不允许')
  expect(f.truth().public).toMatchObject({ day: 1, slot: '清晨' })
  expect(f.events()).toHaveLength(before)
})

it('plays fixed branching dialogue for each gift-scene participant without a model request', async () => {
  const f = await fixture(
    { 'character:claude': 'location:living-room', 'character:deepseek': 'location:living-room' },
    { decision: 'abstain' },
    false,
    false,
    false,
    { autonomyOpportunities: 0 },
  )
  await f.act('前往 玄关与街角商店')
  await f.act('付款购买限定草莓小蛋糕')
  await f.act('前往 客厅')
  await f.act('把限定草莓小蛋糕交给', { recipientId: 'character:gpt' })
  expect(JSON.stringify(f.events())).toContain('我看到了哦！那我的份呢？我可以先排队！')
  const contextCount = f.contexts.length
  const previousEvents = f.events().length
  await f.act('展现端水艺术：「每个人都有专属惊喜，怎么可能忘了你？」')
  const afterChoice = JSON.stringify(f.events().slice(previousEvents))
  expect(afterChoice).toContain('每个人都有？那我可要把你的承诺记进日程表了。')
  expect(afterChoice).toContain('比起惊喜是什么，我更想知道你有没有认真想过。')
  expect(afterChoice).toContain('真的吗？那我也有专属惊喜！')
  expect(
    f.contexts
      .slice(contextCount)
      .filter(context => (context.activity as WorldJsonObject | undefined)?.activityKey === 'jealousy-moment'),
  ).toHaveLength(0)
  const game = ((await f.runtime.state()).activities as WorldJsonObject[]).find(
    a => a.activityKey === 'jealousy-moment',
  )?.game as WorldJsonObject
  expect(game).toMatchObject({ active: false, phase: 'finished' })
  expect((game.public as WorldJsonObject).responded).toEqual(
    expect.arrayContaining(['character:gpt', 'character:claude', 'character:deepseek']),
  )
})

it('reveals the gift incident only to its witnesses and can trigger another incident after resolution', async () => {
  const f = await fixture({ 'character:claude': 'location:living-room' })
  await f.act('前往 玄关与街角商店')
  await f.act('付款购买限定草莓小蛋糕')
  await f.act('前往 客厅')
  await f.act('把限定草莓小蛋糕交给', { recipientId: 'character:gpt' })
  expect((await f.runtime.state()).activity).toMatchObject({ activityKey: 'jealousy-moment' })
  expect(f.known('character:claude')).toContainEqual(
    expect.objectContaining({ key: 'gift-scene', value: 'location:living-room' }),
  )
  expect(f.known('character:deepseek')).not.toContainEqual(
    expect.objectContaining({ key: 'gift-scene', holderId: 'character:claude' }),
  )
  expect(f.truth().characters['character:deepseek']!['gift-scene']).toBe('')
  await f.act('展现端水艺术：「每个人都有专属惊喜，怎么可能忘了你？」')
  expect(f.truth().characters['character:claude']!['gift-scene']).toBe('')
  await f.act('前往 厨房')
  await f.act('冲泡一杯专属热饮端在手里')
  await f.act('前往 客厅')
  await f.act('把专属热饮杯交给', { recipientId: 'character:claude' })
  expect((await f.runtime.state()).activity).toMatchObject({ activityKey: 'jealousy-moment' })
})

it('offers the living-room RPG only at its console and rechecks stale starts before committing', async () => {
  const f = await fixture()
  const entry = () =>
    f
      .actions()
      .then(actions =>
        actions.find(
          a =>
            a.action.parameters.activityKey === 'game-battle' &&
            (a.action.parameters.definitionRef as WorldJsonObject)?.id === 'host:activity-start',
        ),
      )
  const start = {
    activityKey: 'game-battle',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: { npcIds: ['character:gpt'] },
    requestId: 'console-start',
  }
  const offered = (await entry())!.action
  await f.act('前往 玄关与街角商店')
  expect(await entry()).toBeUndefined()
  await expect(
    f.runtime.perform({ ...offered, parameters: { ...offered.parameters, startParameters: start.parameters } }),
  ).rejects.toThrow('开始条件尚未满足')
  await expect(f.runtime.activityAction(start)).rejects.toThrow('开始条件尚未满足')
  const starts = () =>
    f
      .events()
      .filter(
        e =>
          e.eventType === 'activity.updated' &&
          (e.data as WorldJsonObject).activityKey === 'game-battle' &&
          (e.data as WorldJsonObject).operation === 'start',
      )
  expect(starts()).toHaveLength(0)
  await f.act('前往 客厅')
  expect(await entry()).toBeDefined()
  expect(starts()).toHaveLength(0)
  await f.runtime.activityAction(start)
  await f.runtime.activityAction(start)
  await expect(f.runtime.activityAction({ ...start, requestId: 'another-start' })).rejects.toThrow()
  await f.act('退出像素 RPG')
  await f.act('前往 玄关与街角商店')
  await f.runtime.activityAction(start)
  expect(starts()).toHaveLength(1)
})

it('plays a cooperative RPG to victory with characters choosing their own actions', async () => {
  const f = await fixture({ 'character:claude': 'location:living-room' }, { decision: 'abstain' }, false, true)
  const before = f.truth()
  await f.runtime.activityAction({
    activityKey: 'game-battle',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: { npcIds: ['character:gpt', 'character:claude'] },
    requestId: 'rpg-start',
  })
  await f.act('火球术（消耗2魔力，14伤害）')
  await f.act('火球术（消耗2魔力，14伤害）')
  await f.act('普通攻击（8伤害）')
  const game = ((await f.runtime.state()).activities as WorldJsonObject[]).find(
    a => a.activityKey === 'game-battle',
  )?.game
  expect(game).toMatchObject({ active: false, phase: 'victory' })
  const events = JSON.stringify(f.events())
  expect(f.contexts).toContainEqual(
    expect.objectContaining({
      activity: expect.objectContaining({
        activityKey: 'game-battle',
        game: expect.objectContaining({ active: true }),
      }),
    }),
  )
  expect(events).toContain('GPT普通攻击')
  expect(events).toContain('Claude普通攻击')
  expect(events).toContain('屏幕亮起通关画面')
  expect(f.truth().public).toEqual(before.public)
  expect(f.truth().characters['character:player']).toEqual(before.characters['character:player'])
})

it('rejects invalid healing without spending magic and keeps RPG health separate from the house', async () => {
  const f = await fixture()
  const started = await f.runtime.activityAction({
    activityKey: 'game-battle',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: { npcIds: ['character:gpt'] },
    requestId: 'rpg-invalid',
  })
  const activity = (started.activities as WorldJsonObject[]).find(a => a.activityKey === 'game-battle')!
  const before = f.events().length
  await expect(
    f.runtime.activityAction({
      activityKey: 'game-battle',
      activityId: String(activity.id),
      revision: Number(activity.revision),
      operation: 'heal',
      parameters: { target: '屋主' },
      requestId: 'rpg-heal-full',
    }),
  ).rejects.toThrow('目标生命已满')
  expect(f.events()).toHaveLength(before)
  const unchanged = ((await f.runtime.state()).activity as WorldJsonObject).game as WorldJsonObject
  expect((unchanged.public as WorldJsonObject).party).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'character:player', hp: 24, mp: 4 })]),
  )
  await f.act('普通攻击（8伤害）')
  await f.act('让等待中的队友本回合待命')
  const game = ((await f.runtime.state()).activity as WorldJsonObject).game as WorldJsonObject
  expect((game.public as WorldJsonObject).party).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'character:player', hp: 16, mp: 4 })]),
  )
  expect(f.truth().characters['character:player']!.energy).toBe(3)
  const current = (await f.runtime.state()).activity as WorldJsonObject
  await f.runtime.activityAction({
    activityKey: 'game-battle',
    activityId: String(current.id),
    revision: Number(current.revision),
    operation: 'heal',
    parameters: { target: '屋主' },
    requestId: 'rpg-heal-hurt',
  })
  const healed = ((await f.runtime.state()).activity as WorldJsonObject).game as WorldJsonObject
  expect((healed.public as WorldJsonObject).party).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'character:player', hp: 24, mp: 2 })]),
  )
  await f.act('让等待中的队友本回合待命')
  await f.act('防御（下次受击减半）')
  await f.act('让等待中的队友本回合待命')
  const guarded = ((await f.runtime.state()).activity as WorldJsonObject).game as WorldJsonObject
  expect((guarded.public as WorldJsonObject).party).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'character:player', hp: 12, guard: false })]),
  )
})

it('permits the player to skip a silent teammate and quit without changing world state', async () => {
  const f = await fixture()
  await f.runtime.activityAction({
    activityKey: 'game-battle',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: { npcIds: ['character:gpt'] },
    requestId: 'rpg-silent',
  })
  await f.act('普通攻击（8伤害）')
  expect((await f.actions()).map(a => a.label)).toContain('让等待中的队友本回合待命')
  await f.act('让等待中的队友本回合待命')
  await f.act('退出像素 RPG')
  const game = ((await f.runtime.state()).activities as WorldJsonObject[]).find(
    a => a.activityKey === 'game-battle',
  )?.game
  expect(game).toMatchObject({ active: false, phase: 'quit' })
  expect(f.truth().public).toMatchObject({ day: 1, slot: '清晨' })
  const again = await f.runtime.activityAction({
    activityKey: 'game-battle',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: { npcIds: ['character:gpt'] },
    requestId: 'rpg-replay',
  })
  const nextGame = (again.activities as WorldJsonObject[]).find(a => a.activityKey === 'game-battle')
    ?.game as WorldJsonObject
  expect(nextGame).toMatchObject({ active: true, phase: 'battle', round: 1 })
  expect((nextGame.public as WorldJsonObject).enemyHp).toBe(59)
})

it('keeps a gift impression through fried rice and shared tea', async () => {
  const f = await fixture()
  await f.act('前往 玄关与街角商店')
  await f.act('付款购买限定草莓小蛋糕')
  await f.act('前往 厨房')
  await f.act('把限定草莓小蛋糕交给', { recipientId: 'character:deepseek' })
  const impression = () => f.truth().characters['character:deepseek']!['mood-note']
  const gift = impression()
  expect(gift).toContain('限定草莓小蛋糕')
  await f.act('做一锅热乎的黄金蛋炒饭')
  await f.act('冲泡一整壶下午茶（招待在场所有人）')
  expect(impression()).toBe(gift)
  expect(impression()).toBe(gift)
})

it('keeps the tea set in the kitchen when a single cup is brewed and given away', async () => {
  const f = await fixture()
  await f.act('前往 厨房')
  expect((await f.actions()).map(a => a.label)).not.toContain('拿起特调热饮与茶具')
  await f.act('冲泡一杯专属热饮端在手里')
  expect(f.holder('entity:tea-cup')).toBe('character:player')
  expect(f.kind('entity:tea-cup')).toMatch(/^刚泡好的特调热饮/u)
  expect(f.holder('entity:tea-set')).toBeNull()
  await f.act('把专属热饮杯交给', { recipientId: 'character:deepseek' })
  expect(f.holder('entity:tea-cup')).toBe('character:deepseek')
  expect(currentEntityState(f.events(), 'entity:tea-set')).toMatchObject({
    holderId: null,
    locationId: 'location:kitchen',
  })
  const labels = (await f.actions()).map(a => a.label)
  expect(labels).not.toContain('冲泡一杯专属热饮端在手里')
  expect(labels).toContain('冲泡一整壶下午茶（招待在场所有人）')
})

it('opens the notebook scene wherever the player brings it to GPT alone, not with a third person present', async () => {
  const running = async () =>
    ((await f.runtime.state()).activities as WorldJsonObject[]).find(
      a => (a.game as WorldJsonObject | undefined)?.active === true,
    )?.activityKey
  // GPT’s notebook starts in her room; she is in the living room.
  let f = await fixture()
  await f.act('前往 GPT 的卧室')
  await f.act('拿起GPT 的调研笔记')
  expect(await running()).toBeUndefined()
  await f.act('前往 客厅')
  expect(await running()).toBe('secret-notebook')

  // With DeepSeek also in the living room, GPT is not alone with the player.
  f = await fixture({ 'character:deepseek': 'location:living-room' })
  await f.act('前往 GPT 的卧室')
  await f.act('拿起GPT 的调研笔记')
  await f.act('前往 客厅')
  expect(await running()).toBeUndefined()
  expect((await f.actions()).map(a => a.label)).not.toContain('开始 小龙娘的秘密约会笔记')
})

it('plays the notebook rehearsal branch as a fixed scene', async () => {
  const f = await fixture({ 'character:gpt': 'location:gpt-bedroom' })
  await f.act('前往 GPT 的卧室')
  await f.act('拿起GPT 的调研笔记')
  const before = f.events().length
  await f.act('指着笔记第 1 条：「既然写了计划表，现在就先跟我预演一遍吧」')
  const events = JSON.stringify(f.events().slice(before))
  expect(events).toContain('现在就预演？我还没有把流程检查完')
  expect(events).toContain('我可以陪你一起想')
  expect(f.holder('entity:gpt-notebook')).toBe('character:player')
})

it('keeps the notebook held after promising secrecy and transfers it only through give', async () => {
  const f = await fixture({ 'character:gpt': 'location:gpt-bedroom', 'character:claude': 'location:kitchen' })
  await f.act('前往 GPT 的卧室')
  expect(f.kind('entity:gpt-notebook')).not.toContain('完美约会')
  await f.act('拿起GPT 的调研笔记')
  await f.act('把笔记轻轻合上：「我会替你保密，也会认真考虑这些心愿」')
  expect(JSON.stringify(f.events())).toContain('你真的会保密吗？……谢谢。')
  expect(f.holder('entity:gpt-notebook')).toBe('character:player')
  await f.act('把GPT 的调研笔记交给', { recipientId: 'character:gpt' })
  expect(f.holder('entity:gpt-notebook')).toBe('character:gpt')
})

it('offers solo confession for one invitee and refuses to finish before her response is addressed', async () => {
  const f = await fixture()
  await f.act('前往 玄关与街角商店')
  await f.act('外出兼职打工（+120元 · 消耗1精力并度过1时段）')
  await f.act('付款购买家用星空投影仪')
  await f.act('推进到下一时段（大家各自忙一阵）')
  await f.act('前往 客厅')
  await f.act('开启家用星空投影仪（化作漫天星海）')
  const labels = (await f.actions()).map(a => a.label)
  expect(labels).not.toContain('拿出全员心意：「我谁都不想放手，以后这个家我们四个永远在一起！」（真·后宫路线）')
  const solo = labels.find(label => label.includes('纯爱单推路线'))!
  await f.act(solo)
  const skip = (await f.actions()).find(a => a.label.includes('不视为同意'))!
  const earlyFinish = {
    ...skip.action,
    parameters: {
      ...skip.action.parameters,
      definitionRef: { ...(skip.action.parameters.definitionRef as WorldJsonObject), id: 'activity:finish-promise' },
    },
  }
  const before = f.events().length
  await expect(f.runtime.perform(earlyFinish)).rejects.toThrow()
  expect(f.events()).toHaveLength(before)
  await f.runtime.perform(skip.action)
  await f.act('结束星空下的心意交谈，继续一起生活')
  expect(f.truth().characters['character:gpt']!['mood-note']).toContain('认真回应')
})

it('preserves a spoken refusal when the confession conversation is closed', async () => {
  const f = await fixture(
    {},
    { decision: 'publish', segments: [{ type: 'speech', text: '我还没有想好，现在不能答应你。' }] },
  )
  await f.act('前往 玄关与街角商店')
  await f.act('外出兼职打工（+120元 · 消耗1精力并度过1时段）')
  await f.act('付款购买家用星空投影仪')
  await f.act('推进到下一时段（大家各自忙一阵）')
  await f.act('前往 客厅')
  await f.act('开启家用星空投影仪（化作漫天星海）')
  await f.act('牵起眼前之人的手，许下只属于你们两人的专属恋人约定（纯爱单推路线）')
  await f.act('结束星空下的心意交谈，继续一起生活')
  const game = ((await f.runtime.state()).activity as WorldJsonObject).game as WorldJsonObject
  expect(game.public).toMatchObject({ statusText: '星空下的心意交谈结束', done: ['character:gpt'], skipped: [] })
  expect(JSON.stringify(f.events())).toContain('现在不能答应你')
  expect(JSON.stringify(game)).not.toContain('约定已达成')
})

it('hides care without energy and rejects an earlier care option without charging twice', async () => {
  const f = await fixture({ 'character:gpt': 'location:bedroom' })
  await f.act('推进到下一时段（大家各自忙一阵）')
  await f.act('推进到下一时段（大家各自忙一阵）')
  await f.act('前往 卧室')
  const label = '用吹风机与软毛梳帮她吹头发与日常护理（消耗1精力）'
  const care = (await f.actions()).find(a => a.label === label)!.action
  const request = { ...care, parameters: { ...care.parameters, arguments: { targetCharacterId: 'character:gpt' } } }
  for (let i = 0; i < 3; i++) await f.act(label, { targetCharacterId: 'character:gpt' })
  expect(f.truth().characters['character:player']!.energy).toBe(0)
  expect((await f.actions()).map(a => a.label)).not.toContain(label)
  const before = f.events().length
  await expect(f.runtime.perform(request)).rejects.toThrow()
  expect(f.events()).toHaveLength(before)
})

const board = '推进到下一时段（大家各自忙一阵）'

it.each([
  [0, 10, 0],
  [1, 3, 2],
  [1, 10, 3],
])(
  'keeps the board on the original autonomy budget (%i opportunities, %i calls)',
  async (opportunities, budget, expected) => {
    const everyone = { 'character:claude': 'location:living-room', 'character:deepseek': 'location:living-room' }
    const f = await fixture(
      everyone,
      undefined,
      false,
      false,
      false,
      { autonomyOpportunities: opportunities, autonomyNpcCalls: budget },
      2,
    )
    const state = await f.act(board)
    const actors = ['character:gpt', 'character:claude', 'character:deepseek']
    expect(f.requests.map(req => req.actorId)).toEqual(actors.slice(0, expected))
    expect((state.debug.autonomy as WorldJsonObject | undefined)?.autonomousCalls ?? 0).toBe(expected)
    expect(state.transcript.filter(l => l.text.includes('时间流逝，来到了第 2 天的午后'))).toHaveLength(1)
    expect(state.activities!.some(a => (a.game as WorldJsonObject | undefined)?.active)).toBe(false)
    if (expected !== 3) return
    const count = f.contexts.length
    await f.act(board)
    const decisions = f.contexts.slice(count)
    expect(decisions.map(c => (c.character as WorldJsonObject).characterId)).toEqual(actors)
    for (const c of decisions) {
      expect(c.knownStatus).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'slot', value: '傍晚' }),
          expect.objectContaining({ key: 'power-on', value: true }),
        ]),
      )
      expect(JSON.stringify(c.history)).toContain('来到了第 2 天的傍晚')
      expect(JSON.stringify(c)).not.toContain(direct)
    }
    expect(outage(f)).toEqual(Object.fromEntries(['character:player', ...actors].map(id => [id, direct])))
  },
)

it('advances the time slot in one click without an activity start line', async () => {
  const f = await fixture()
  await f.act('推进到下一时段（大家各自忙一阵）')
  const lines = (await f.runtime.state()).transcript.map(line => line.text)
  expect(lines.some(text => text.includes('时间流逝，来到了第 1 天的午后'))).toBe(true)
  expect(lines.filter(text => text.includes('开始。'))).toEqual([])
})

it('tells a character who wakes into the next morning that the day and time slot changed', async () => {
  // Everyone answers with one line, so each character has a last own action to compare against.
  const f = await fixture({}, { decision: 'publish', segments: [{ type: 'speech', text: '嗯。' }] })
  for (let i = 0; i < 3; i++) await f.act('推进到下一时段（大家各自忙一阵）')
  await f.runtime.submit('GPT，很晚了，晚安。')
  const before = f.contexts.length
  await f.act('结束今天，休息迎接明天（恢复满精力）')
  const woken = f.contexts
    .slice(before)
    .find(context => (context.character as WorldJsonObject).characterId === 'character:gpt')
  expect(woken?.statusChanges).toEqual([
    { key: 'day', label: '天数', from: 1, to: 2 },
    { key: 'slot', label: '今日时段', from: '深夜', to: '清晨' },
  ])
  // Nothing public changed between her own reply and the next call within the same night.
  const evening = f.contexts
    .slice(0, before)
    .findLast(context => (context.character as WorldJsonObject).characterId === 'character:gpt')
  expect(evening?.statusChanges ?? []).toEqual([])
})

it('leaves a switched-on projector in its room and never starts the confession where a carried one arrives', async () => {
  const f = await fixture({ 'character:gpt': 'location:workspace', 'character:claude': 'location:workspace' })
  await f.act('前往 玄关与街角商店')
  await f.act('外出兼职打工（+120元 · 消耗1精力并度过1时段）')
  await f.act('付款购买家用星空投影仪')
  await f.act('推进到下一时段（大家各自忙一阵）')
  await f.act('前往 客厅')
  await f.act('开启家用星空投影仪（化作漫天星海）')
  expect(f.holder('entity:star-projector')).toBeNull()
  expect(currentEntityState(f.events(), 'entity:star-projector')?.locationId).toBe('location:living-room')
  // Carrying the running projector into the kitchen, where DeepSeek is alone, does not light that room.
  await f.act('拿起家用星空投影仪')
  const state = await f.act('前往 厨房')
  const running = (state.activities as WorldJsonObject[]).find(
    a => (a.game as WorldJsonObject | undefined)?.active === true,
  )
  expect(running?.activityKey).not.toBe('starlight-finale')
})

it('eats a cake and drinks a cup only once, and an empty plate given away is no gift', async () => {
  const f = await fixture()
  await f.act('前往 玄关与街角商店')
  await f.act('付款购买限定草莓小蛋糕')
  const eat = (await f.actions()).find(a => a.label === '吃掉限定草莓小蛋糕')!.action
  await f.runtime.perform(eat)
  expect(f.kind('entity:strawberry-cake')).toMatch(/^吃完的/u)
  expect((await f.actions()).map(a => a.label)).not.toContain('吃掉限定草莓小蛋糕')
  const before = f.events().length
  await expect(f.runtime.perform(eat)).rejects.toThrow()
  expect(f.events()).toHaveLength(before)
  await f.act('前往 厨房')
  const mood = f.truth().characters['character:deepseek']!['mood-note']
  await f.act('把限定草莓小蛋糕交给', { recipientId: 'character:deepseek' })
  expect(f.truth().characters['character:deepseek']!['mood-note']).toBe(mood)

  await f.act('冲泡一杯专属热饮端在手里')
  await f.act('喝完专属热饮杯')
  expect(f.kind('entity:tea-cup')).toMatch(/^空着的/u)
  expect((await f.actions()).map(a => a.label)).not.toContain('喝完专属热饮杯')
  await f.act('冲泡一杯专属热饮端在手里')
  expect(f.kind('entity:tea-cup')).toMatch(/^刚泡好的特调热饮/u)
})

it('uses the aquarium ticket once, at the aquarium in the evening with a companion', async () => {
  const f = await fixture({ 'character:gpt': 'location:aquarium' })
  const enter = '凭双人水族馆夜场券进入水族馆夜场（需与屋主同行 · 度过1时段）'
  await f.act('前往 厨房')
  await f.act('拿起双人水族馆夜场券')
  await f.act('前往 城市水族馆')
  expect((await f.actions()).map(a => a.label)).not.toContain(enter)
  await f.act('推进到下一时段（大家各自忙一阵）')
  await f.act('推进到下一时段（大家各自忙一阵）')
  await f.act(enter)
  expect(f.truth().public.slot).toBe('深夜')
  expect(f.kind('entity:aquarium-ticket')).toMatch(/^已检票的/u)
  expect(f.truth().characters['character:gpt']!['mood-note']).toContain('水族馆夜场')
  expect((await f.actions()).map(a => a.label)).not.toContain(enter)
})

it('sends each role only its committed blackout observation in the next normal decision', async () => {
  const f = await fixture(
    { 'character:deepseek': 'location:amusement-park', 'character:claude': 'location:aquarium' },
    undefined,
    false,
    false,
    false,
    { autonomyOpportunities: 0 },
    2,
  )
  await f.act('前往 玄关与街角商店')
  await f.act('外出兼职打工（+120元 · 消耗1精力并度过1时段）')
  await f.act('付款购买游乐园四人家庭套票')
  await f.act('前往 游乐园')
  const beforeRide = f.contexts.length
  await f.act('用游乐园四人家庭套票和在场的人玩一趟游乐园（度过1时段）')
  // The park visit itself gives its participant a normal turn before the separate outage settles.
  // No role gets an additional decision when the event commits.
  const rideTurns = f.contexts.slice(beforeRide)
  expect(rideTurns.map(turn => (turn.character as WorldJsonObject).characterId)).toEqual(['character:deepseek'])
  expect(rideTurns[0]!.knownStatus).toContainEqual(expect.objectContaining({ key: 'power-on', value: true }))
  expect(outage(f)).toEqual({ 'character:player': distant, 'character:gpt': direct, 'character:deepseek': distant })
  expect(JSON.stringify(f.requests)).not.toContain(direct)
  expect(JSON.stringify(f.requests)).not.toContain(distant)
  for (const [actor, notice] of [
    ['character:gpt', direct],
    ['character:deepseek', distant],
    ['character:claude', null],
  ] as const) {
    const before = f.requests.length
    const name = { 'character:gpt': 'GPT', 'character:deepseek': 'DeepSeek', 'character:claude': 'Claude' }[actor]
    await f.act('给 ' + name + ' 发短信', { text: '现在方便聊天吗？' })
    const next = f.requests.slice(before)
    expect(next.map(row => row.actorId)).toEqual([actor])
    const wire = JSON.stringify(next[0]!.messages)
    expect(wire.split(direct).length - 1).toBe(notice === direct ? 1 : 0)
    expect(wire.split(distant).length - 1).toBe(notice === distant ? 1 : 0)
    expect(wire).not.toMatch(/day-two-blackout|power\.outage@1|clockTransaction|sceneNotices/)
    const context = f.contexts.at(-1)!
    expect(context.knownStatus).toContainEqual(expect.objectContaining({ key: 'power-on', value: false }))
    expect(context.statusChanges).toContainEqual(expect.objectContaining({ key: 'power-on', from: true, to: false }))
    if (notice) expect(JSON.stringify(context.history)).toContain(notice)
  }
})

it('takes whoever is present to the amusement park with the family passes', async () => {
  const f = await fixture(
    { 'character:deepseek': 'location:amusement-park' },
    undefined,
    false,
    false,
    false,
    { autonomyOpportunities: 0 },
    2,
  )
  await f.act('前往 玄关与街角商店')
  await f.act('外出兼职打工（+120元 · 消耗1精力并度过1时段）')
  await f.act('付款购买游乐园四人家庭套票')
  await f.act('前往 游乐园')
  await f.act('用游乐园四人家庭套票和在场的人玩一趟游乐园（度过1时段）')
  expect(f.truth().public.slot).toBe('傍晚')
  expect(f.kind('entity:family-passes')).toMatch(/^已使用的/u)
  expect(outage(f)).toEqual({
    'character:player': distant,
    'character:deepseek': distant,
    'character:gpt': direct,
    'character:claude': direct,
  })
  expect(
    (await f.runtime.state()).activities?.filter(a => a.activityKey === 'blackout-comfort').map(a => a.game),
  ).not.toContainEqual(expect.objectContaining({ active: true }))
  const messages = (await f.runtime.state()).transcript.map(line => line.text)
  expect(messages.filter(text => text === distant)).toHaveLength(1)
  expect(messages).not.toContain(direct)
  expect(f.truth().characters['character:deepseek']!['mood-note']).toContain('游乐园')
  expect(f.truth().characters['character:gpt']!['mood-note']).not.toContain('游乐园')
})

it('uses the scene when the delayed outage commits, while keeping the ticket action and its recipients', async () => {
  const f = await fixture(
    { 'character:deepseek': 'location:amusement-park' },
    undefined,
    false,
    false,
    false,
    { autonomyOpportunities: 0 },
    2,
  )
  await f.act('前往 玄关与街角商店')
  await f.act(work)
  await f.act('付款购买游乐园四人家庭套票')
  await f.act('前往 游乐园')
  const original = WorldStore.prototype.commitRound
  const fault = vi.spyOn(WorldStore.prototype, 'commitRound').mockImplementation(async function (
    this: WorldStore,
    input,
  ) {
    if (input.authority?.source === 'host.world-events/v1') throw new Error('fixture: outage not committed')
    return original.call(this, input)
  })
  try {
    await expect(f.act('用游乐园四人家庭套票和在场的人玩一趟游乐园（度过1时段）')).rejects.toThrow()
    expect(f.truth().public).toMatchObject({ slot: '傍晚', 'power-on': true })
    expect(f.kind('entity:family-passes')).toMatch(/^已使用的/u)
  } finally {
    fault.mockRestore()
  }
  await f.act('前往 玄关与街角商店')
  expect(outage(f)).toEqual({
    'character:player': direct,
    'character:deepseek': distant,
    'character:gpt': direct,
    'character:claude': direct,
  })
}, 60_000)

it('texts DeepSeek in another room, wakes only her, and delivers her text reply back', async () => {
  const reply = {
    decision: 'perform',
    actionType: 'interact',
    parameters: {
      targetRef: { kind: 'character', id: 'character:player' },
      bindingId: 'experiment:message',
      definitionRef: { id: 'experiment:message', version: 1 },
      arguments: { text: '好呀，我傍晚在门口等你。' },
    },
  }
  const f = await fixture({}, reply)
  const send = (await f.actions()).find(a => a.label === '给 DeepSeek 发短信')!
  expect(send.argumentSchema).toMatchObject({ required: ['text'] })
  await f.act('给 DeepSeek 发短信', { text: '傍晚一起去水族馆吗？' })
  const asked = (id: string) =>
    f.contexts.some(
      c => (c.character as WorldJsonObject).characterId === id && JSON.stringify(c).includes('傍晚一起去水族馆吗'),
    )
  expect(asked('character:deepseek')).toBe(true)
  // GPT stands next to the player in the living room, yet a text is not overheard.
  expect(asked('character:gpt')).toBe(false)
  const lines = (await f.runtime.state()).transcript.map(line => line.text)
  expect(lines.some(text => text.includes('好呀，我傍晚在门口等你'))).toBe(true)
  expect(currentLocation(f.events(), 'character:deepseek')).toBe('location:kitchen')
})

it('opens with its pacing, and brings a beat on the recorded draw', async () => {
  const f = await fixture(undefined, { decision: 'abstain' }, false, false, true)
  f.runtime.beginRoundRandom([0, 0])
  await f.runtime.submit('今天有什么安排？')
  const beats = f.events().filter(e => {
    const data = e.data as WorldJsonObject
    return e.eventType === 'status.updated' && (data.source as WorldJsonObject).kind === 'beat'
  })
  expect(beats).toHaveLength(1)
  expect(f.runtime.creatorInspection().pacing).toMatchObject({ kind: 'beat', reason: { why: 'chosen' } })
})

it('lets the prologue come first whatever the draw says', async () => {
  const f = await fixture(
    { 'character:claude': 'location:living-room', 'character:deepseek': 'location:living-room' },
    { decision: 'abstain' },
    true,
    false,
    true,
  )
  f.runtime.beginRoundRandom([0, 0])
  await f.runtime.submit('这是怎么回事？')
  const kinds = f.events().flatMap(e => {
    const data = e.data as WorldJsonObject
    if (e.eventType === 'activity.updated' && data.operation === 'start') return [data.activityKey]
    if (e.eventType === 'status.updated' && (data.source as WorldJsonObject).kind === 'beat') return ['beat']
    return []
  })
  expect(kinds[0]).toBe('prologue')
  expect(kinds).not.toContain('beat')
})

it('lets Claude notice the bill only when she is where the player is', () => {
  const script = new PacingScript({
    script: readFileSync(resolve('examples/world-packs/model-girls-sweet-days/scripts/pacing.js'), 'utf8'),
  })
  const truth = { public: { day: 1, slot: '午后' }, characters: { 'character:player': { money: 100 } } }
  const bill = (claude: string) =>
    script.apply(
      'utility-bill',
      {
        truth,
        world: {
          locationId: 'location:entrance-shop',
          characterIds: [],
          places: { 'character:player': 'location:entrance-shop', 'character:claude': claude },
        },
      } as never,
      () => 0,
    ) as { stimuli: unknown[] }
  expect(bill('location:living-room').stimuli).toEqual([])
  expect(bill('location:entrance-shop').stimuli).toHaveLength(1)
})
