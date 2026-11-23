import { randomUUID } from 'node:crypto'
import { cpSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { ScriptedModel } from '@perspectra/providers/scripted-model'
import { MESSAGE_DEFINITION_ID, type WorldJsonObject } from '@perspectra/sdk/contracts'
import { assembleRoleplay } from '../../apps/host/src/official-bundle.ts'
import { WorldHostRuntime } from '../../apps/host/src/runtime/world-runtime.ts'
import { WAIT_ACTION } from '../../apps/host/src/runtime/http-server.ts'
import { readStoryExcerpt, exportStoryExcerpt } from '../../apps/host/src/story-excerpt-export.ts'
import { LauncherCore } from '../../apps/launcher/backend/core.ts'
import { excerptMarkdown, excerptRoundStarts, type ExcerptEvent } from '../../apps/host/src/story-excerpt.ts'

const player = 'character:player',
  companion = 'character:companion',
  friend = 'character:friend'
const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'story-excerpt-')),
    pack = join(temp, 'pack'),
    root = join(temp, 'launcher')
  cleanup.push(() => rmSync(temp, { recursive: true, force: true }))
  cpSync('examples/world-packs/multiple-activities', pack, { recursive: true })
  const read = (file: string) => JSON.parse(readFileSync(join(pack, file), 'utf8'))
  const write = (file: string, v: unknown) => writeFileSync(join(pack, file), JSON.stringify(v))
  const meta = read('worldpack.source.json')
  meta.plugins['official-communication'] = {}
  meta.plugins['official-world-events'] = {}
  meta.assetFiles.push('communication.json', 'world-events.json')
  write('worldpack.source.json', meta)
  write('communication.json', {
    medium: '短信',
    contacts: { [player]: [friend], [companion]: [friend], [friend]: [player] },
  })
  write('world-events.json', {
    rules: [
      {
        id: 'blackout',
        type: 'power.outage@1',
        round: 2,
        location: 'location:back-room',
        set: { key: 'power', value: false },
        audience: 'scene',
        observation: '后室灯熄灭的那一刻。',
      },
    ],
    grants: [],
  })
  const status = 'scripts/status.js'
  writeFileSync(
    join(pack, status),
    readFileSync(join(pack, status), 'utf8')
      .replace('statuses: []', "statuses: [{key:'power',label:'供电',owner:'public',type:'boolean'}]")
      .replace('public: {}', 'public: {power:true}'),
  )
  const characters = read('characters.json'),
    scenes = read('scenes.json')
  characters.characters[2].initialLocationId = 'location:back-room'
  scenes.scenes[0].participantIds = [player, companion]
  Object.assign(scenes.scenes[1], { lifecycle: 'active', participantIds: [friend] })
  write('characters.json', characters)
  write('scenes.json', scenes)
  const core = new LauncherCore(resolve('.'), root)
  await core.initialize()
  await core.handle({ operation: 'load', path: pack })
  await core.handle({ operation: 'create', packageId: core.snapshot().packs[0]!.id, name: '合成演练' })
  const id = core.snapshot().instances[0]!.id,
    data = join(root, 'instances', id)
  const model = new ScriptedModel()
  const runtime = await WorldHostRuntime.create({
    packPath: pack,
    dataDirectory: data,
    models: model.models,
    composition: assembleRoleplay({ llmTransport: model.provider }),
    timeoutMs: 8000,
  })
  cleanup.push(() => runtime.close())
  const initial = await runtime.saveNode('开头')
  const committed = () => {
    const db = new DatabaseSync(join(runtime.dataDirectory, 'world.sqlite'), { readOnly: true })
    try {
      return db.prepare('select seq,event_type,data_json,event_hash from events order by seq').all()
    } finally {
      db.close()
    }
  }
  return { core, runtime, model, temp, id, root, initial, committed }
}
function message(to: string, text: string): WorldJsonObject {
  return {
    decision: 'perform',
    actionType: 'interact',
    parameters: {
      bindingId: MESSAGE_DEFINITION_ID,
      definitionRef: { id: MESSAGE_DEFINITION_ID, version: 1 },
      targetRef: { kind: 'character', id: to },
      arguments: { text },
    },
  }
}
it('keeps third-party mail and remote witnesses private, preserving later delivery and adjudicated results', async () => {
  const { core, runtime, model, temp, id, root, initial, committed } = await fixture()
  const secret = '只给留守者的合成暗号',
    claim = '我已经交出了钥匙。',
    later = '刚才后室停电了。'
  let sendPrivate = true,
    sendNews = false
  model.decide = actor => {
    if (actor === companion && sendPrivate) {
      sendPrivate = false
      return message(friend, secret)
    }
    if (actor === friend && sendNews) {
      sendNews = false
      return message(player, later)
    }
    return { decision: 'abstain' }
  }
  await runtime.submit(claim)
  await runtime.perform(WAIT_ACTION)
  sendNews = true
  await runtime.submit('/message ' + JSON.stringify({ recipientId: friend, text: '后室怎么了？' }))
  await runtime.submit('/status take@entity:brass-key {}')
  const history = committed(),
    count = model.inputs.length
  // Positive controls: both otherwise excluded records really committed.
  expect(history.some(r => r.event_type === 'character.speak' && String(r.data_json).includes(secret))).toBe(true)
  expect(
    history.some(r => r.event_type === 'observation.upsert' && String(r.data_json).includes('后室灯熄灭的那一刻。')),
  ).toBe(true)
  const seen = readStoryExcerpt(root, id),
    world = readStoryExcerpt(root, id, { perspective: 'world' })
  expect(seen.opening).toMatchObject({ location: '前室', present: expect.arrayContaining(['玩家', '同行者']) })
  expect(seen.opening.present).not.toContain('留守者')
  for (const v of [world, seen]) {
    for (const s of [JSON.stringify(v), excerptMarkdown(v)]) {
      expect(s).not.toContain(secret)
      expect(s).not.toContain('后室灯熄灭的那一刻。')
      expect(s).not.toContain('invalid.invalid')
    }
    expect(v.materials.filter(m => m.text === claim).map(m => m.kind)).toEqual(['对白'])
    expect(v.materials).toContainEqual(
      expect.objectContaining({ kind: '行动结果', text: expect.stringContaining('拿起了') }),
    )
    expect(v.materials).toContainEqual(expect.objectContaining({ kind: '已投递私信', text: later }))
  }
  expect(seen.materials.some(m => m.kind === '世界事件')).toBe(false)
  const occurrence = world.materials.find(m => m.kind === '世界事件')
  expect(occurrence?.seq).toBeLessThan(world.materials.find(m => m.text === later)!.seq)
  expect(seen.range).toMatchObject({ includedRounds: 4, requestedRounds: 20 })
  expect(readStoryExcerpt(root, id, { rounds: 1 }).materials.map(m => m.text)).not.toContain(later)
  expect(readStoryExcerpt(root, id, { nodeId: initial.id }).range.afterSeq).toBe(initial.headSeq)
  const md = join(temp, '片段.md'),
    json = join(temp, '片段.json')
  await core.handle({ operation: 'story-excerpt', instanceId: id, lineId: 'main', path: md })
  exportStoryExcerpt(root, id, json)
  expect(readFileSync(md, 'utf8')).toBe(excerptMarkdown(JSON.parse(readFileSync(json, 'utf8'))))
  expect(() => exportStoryExcerpt(root, id, md)).toThrow()
  expect(() => exportStoryExcerpt(root, id, join(root, '坏位置.md'))).toThrow()
  expect(committed()).toEqual(history)
  expect(model.inputs).toHaveLength(count)
}, 60000)
it('reads the selected candidate only and validates the saved node against the exact prefix', async () => {
  const { runtime, model, root, id, initial } = await fixture()
  let response = '第一候选的对白。'
  model.decide = (actor, input) =>
    actor === companion && !input.continuation
      ? { decision: 'publish', segments: [{ type: 'speech', text: response }] }
      : { decision: 'abstain' }
  const original = await runtime.submit('你看到了什么？')
  const saved = await runtime.saveNode('第一候选')
  const first = readStoryExcerpt(root, id)
  expect(excerptMarkdown(first)).toContain(response)
  response = '第二候选的对白。'
  const tail = original.tailRound!
  const regenerated = await runtime.regenerate(tail.id!, randomUUID())
  const other = readStoryExcerpt(root, id, { nodeId: initial.id })
  expect(other.range.headSeq).toBe(first.range.headSeq)
  expect(other.range.headHash).not.toBe(first.range.headHash)
  expect(excerptMarkdown(other)).toContain(response)
  expect(excerptMarkdown(other)).not.toContain('第一候选的对白。')
  expect(() => readStoryExcerpt(root, id, { nodeId: saved.id })).toThrow('前缀')
  expect(() => readStoryExcerpt(root, id, { expectedLine: randomUUID() })).toThrow('故事线')
  await runtime.selectCandidate(regenerated.tailRound!.id!, tail.candidateIds![0]!, randomUUID())
  expect(readStoryExcerpt(root, id, { nodeId: saved.id }).materials).toEqual([])
  expect(readStoryExcerpt(root, id).range.headHash).toBe(first.range.headHash)
}, 60000)

it('counts speech with an action as one round, and a restored line stops at its own fork', async () => {
  const { core, runtime, model, root, id, initial } = await fixture()
  await runtime.submit('桌上有什么？')
  const forkPoint = await runtime.saveNode('看见桌子')
  const pending: string[] = []
  model.decide = () => {
    try {
      readStoryExcerpt(root, id, { rounds: 1 })
    } catch (e) {
      pending.push(String(e))
    }
    return { decision: 'abstain' }
  }
  await runtime.perform(
    { actionType: 'move', parameters: { locationId: 'location:back-room' } },
    { speech: { scope: 'scene_public', text: '我去后室看看。' }, order: 'before' },
  )
  expect(pending.join(' ')).toContain('回合边界')
  const last = readStoryExcerpt(root, id, { rounds: 1 })
  expect(last.range.afterSeq).toBe(forkPoint.headSeq)
  expect(last.opening.location).toBe('前室')
  expect(last.materials.map(m => m.kind)).toEqual(expect.arrayContaining(['对白', '行动结果']))
  const future = await runtime.saveNode('主线的将来')
  await core.handle({ operation: 'story-fork', instanceId: id, nodeId: forkPoint.id, name: '另一条线' })
  const line = core.snapshot().instances[0]!.currentStorylineId,
    origin = join(root, 'instances', id),
    directory = join(origin, 'storylines', line)
  const files = readdirSync(directory),
    nodeFiles = readdirSync(join(origin, 'story-nodes', initial.id))
  expect(readStoryExcerpt(root, id, { nodeId: initial.id })).toMatchObject({
    range: { lineId: line, afterSeq: initial.headSeq, headSeq: forkPoint.headSeq },
  })
  expect(() => readStoryExcerpt(root, id, { nodeId: future.id })).toThrow('当前故事线')
  expect(readdirSync(directory)).toEqual(files)
  expect(readdirSync(join(origin, 'story-nodes', initial.id))).toEqual(nodeFiles)
}, 60000)

it('records a committed refusal without presenting the undelivered words as dialogue', async () => {
  const { runtime, root, id, committed } = await fixture()
  const text = '未送达的合成私语'
  await runtime.submit('/act speak ' + JSON.stringify({ text, scope: 'direct', addresseeIds: [friend] }))
  expect(
    committed().some(
      row => row.event_type === 'action.resolved' && JSON.parse(String(row.data_json)).accepted === false,
    ),
  ).toBe(true)
  for (const perspective of ['player', 'world'] as const) {
    const excerpt = readStoryExcerpt(root, id, { perspective })
    expect(excerpt.materials).toContainEqual(expect.objectContaining({ kind: '行动被拒', speaker: '玩家' }))
    expect(excerptMarkdown(excerpt)).not.toContain(text)
    expect(JSON.stringify(excerpt)).not.toContain(text)
  }
}, 60000)

it('retains the first transaction of a quick activity and checks its actual instance', () => {
  const events = [
    {
      seq: 1,
      transactionId: 'start',
      eventType: 'activity.updated',
      data: { operation: 'start', requestId: 'q:start', state: { id: 'a' } },
    },
    { seq: 2, transactionId: 'start', eventType: 'action.resolved', data: { sourceRole: 'player' } },
    {
      seq: 3,
      transactionId: 'apply',
      eventType: 'activity.updated',
      data: { operation: 'fish', requestId: 'q', state: { id: 'a' } },
    },
    { seq: 4, transactionId: 'apply', eventType: 'action.resolved', data: { sourceRole: 'player' } },
  ] satisfies ExcerptEvent[]
  expect(excerptRoundStarts(events)).toEqual([1])
  events[2]!.data.state!.id = 'other'
  expect(excerptRoundStarts(events)).toEqual([1, 3])
})
