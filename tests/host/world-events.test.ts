import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { installWorldEventRegistry } from '../../apps/host/src/world-event-registry.ts'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { firstPackTimeCrossing } from '../../apps/host/src/runtime/pack-time.ts'
import { playSettings } from '../../apps/host/src/play-settings.ts'
import { parseEventBook } from '@perspectra/sdk'
import type { StoredWorldEvent } from '@perspectra/sdk/contracts'
import { WorldEventRuntime } from '../../apps/host/src/runtime/world-events.ts'
import { executeWorldRound, WorldExecutionEngine } from '@perspectra/core'
import { WriterLeaseService, WorldStore } from '@perspectra/core/store'
import { brandId, type WorldJsonObject } from '@perspectra/sdk/contracts'
import { WorldHostRuntime } from '../../apps/host/src/runtime/world-runtime.ts'
import { loadHostPlugins } from '../../apps/host/src/host-plugins.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'
import { PacingScript } from '@perspectra/plugins/pacing'
import { restoreStoryNode } from '../../apps/host/src/story-nodes.ts'
import { officialWorldEvents } from '@perspectra/plugins/world-events'
import { projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
const type = 'power.outage@1',
  source = 'host.world-events/v1'
const rule = {
  id: 'kitchen-blackout',
  type,
  round: 4,
  location: 'location:front-room',
  set: { key: 'power', value: false },
  observation: '灯熄灭了。',
}
const wait = { actionType: 'interact', parameters: { definitionRef: { id: 'host:wait', version: 1 } } } as const
async function fixture(
  round = 4,
  additionalRules: Record<string, unknown>[] = [],
  sharedLocation = false,
  pacing?: { keys: string[]; cooldown?: number; legacyBeat?: boolean; managedCook?: boolean },
  calendar = false,
  wakes?: { recipients: string[]; failModel?: boolean; ordinary?: boolean },
) {
  const root = mkdtempSync(join(tmpdir(), 'world-events-')),
    pack = join(root, 'pack'),
    data = join(root, 'save')
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  cpSync(resolve('examples/world-packs/multiple-activities'), pack, { recursive: true })
  const read = (file: string) => JSON.parse(readFileSync(join(pack, file), 'utf8'))
  const write = (file: string, value: unknown) => writeFileSync(join(pack, file), JSON.stringify(value))
  const meta = read('worldpack.source.json')
  const pluginIds = ['stage-cue', 'story-a', 'story-b', 'ungranted']
  meta.plugins = Object.fromEntries(['pack-scripts', 'official-world-events', ...pluginIds].map(id => [id, {}]))
  meta.plugins['alternate-rules'] = { config: 'world-events.json' }
  meta.assetFiles = ['scripts/status.js', 'scripts/activities/cook.js', 'world-events.json']
  if (wakes?.ordinary) {
    meta.plugins['official-autonomy'] = {}
    meta.assetFiles.push('autonomy.json')
    write('autonomy.json', {
      characters: [
        {
          characterId: 'character:friend',
          everyPlayerTurns: 1,
          opportunities: 2,
          triggers: [{ actionType: 'interact', definitionId: 'status:take' }],
          interactions: [],
          locationIds: ['location:back-room'],
        },
      ],
    })
  }
  if (pacing) {
    meta.plugins['official-pacing'] = {}
    meta.assetFiles.push('scripts/pacing.js')
    const definition = {
      cycleRounds: 8,
      chance: 1,
      recoveryRounds: 0,
      cooldownRounds: { low: 0, medium: 0, high: pacing.cooldown ?? 0 },
      ...(pacing.managedCook ? { activities: { cook: { intensity: 'low' } } } : {}),
      ...(pacing.legacyBeat ? { beats: { knock: { intensity: 'low' } } } : {}),
      events: Object.fromEntries(pacing.keys.map(key => [key, { intensity: 'high' }])),
    }
    const beats = pacing.legacyBeat
      ? `{ knock: {
      when: truth => [['准备好', !truth.public.story]],
      apply: () => ({changes:[{holderId:null,key:'story',value:true}]})
    } }`
      : '{}'
    writeFileSync(
      join(pack, 'scripts/pacing.js'),
      `globalThis.pacingScript = {definition:${JSON.stringify(definition)}, beats:${beats}}`,
    )
  }
  delete meta.scripts
  write('worldpack.source.json', meta)
  cpSync(resolve('tests/fixtures/world-event-cook.js'), join(pack, 'scripts/activities/cook.js'))
  if (pacing?.managedCook)
    appendFileSync(
      join(pack, 'scripts/activities/cook.js'),
      "\nactivityScript.autoStart = (truth, world, previous) => ({ when: [['可开锅', truth.public.story && previous === null]] })",
    )
  // This witness is active but remote. The other two share the kitchen scene.
  const characters = read('characters.json'),
    scenes = read('scenes.json')
  if (sharedLocation) scenes.scenes[1].locationId = 'location:front-room'
  characters.characters[2].initialLocationId = scenes.scenes[1].locationId
  scenes.scenes[0].participantIds = scenes.scenes[0].participantIds.filter((id: string) => id !== 'character:friend')
  scenes.scenes[1].lifecycle = 'active'
  scenes.scenes[1].participantIds = ['character:friend']
  write('characters.json', characters)
  write('scenes.json', scenes)
  write('world-events.json', {
    rules: [
      {
        ...rule,
        ...(wakes ? { wakeCharacters: wakes.recipients } : {}),
        round: calendar ? undefined : round,
        ...(calendar ? { when: { crossesPackTime: clock } } : {}),
        audience: { anyOf: ['scene', { holds: 'entity:thermos' }] },
      },
      ...additionalRules.map(extra => ({ ...rule, round, ...extra })),
    ],
    grants: [
      { plugin: 'stage-cue', type, mode: 'live' },
      { plugin: 'story-a', type, mode: 'durable' },
      { plugin: 'story-b', type, mode: 'durable', effect: { key: 'story', value: true } },
    ],
  })
  const script = join(pack, 'scripts/status.js')
  writeFileSync(
    script,
    readFileSync(script, 'utf8')
      .replace('statuses: []', "statuses: ['power','story'].map(key=>({key,label:key,owner:'public',type:'boolean'}))")
      .replace('public: {}', 'public: {power:true,story:false}'),
  )
  if (calendar)
    appendFileSync(
      script,
      `
    statusScript.definition.statuses.push(...[['day','number'],['slot','string'],['wage','number']].map(([key,type])=>({key,label:key,type,owner:'public'})))
    const init=statusScript.initialize, perform=statusScript.resolve
    statusScript.initialize=ids=>{const v=init(ids);Object.assign(v.public,{day:2,slot:'午后',wage:0});return v}
    statusScript.resolve=(truth,actor,op,...rest)=>{const r=perform(truth,actor,op,...rest)
      if(op==='take' && !r.rejectReason) r.changes.push({holderId:null,key:'slot',value:'深夜'},{holderId:null,key:'wage',value:truth.public.wage+120})
      return r}
  `,
    )
  const log = join(root, 'observed.jsonl'),
    marker = join(root, 'attempt')
  const mods = pluginIds.map((id, i) => {
    const mode = i === 1 || i === 2 ? 'durable' : 'live'
    const file = join(root, id + '.mjs')
    if (id === 'stage-cue') cpSync(resolve('tests/fixtures/world-event-stage-cue.mjs'), file)
    else
      writeFileSync(
        file,
        `import fs from 'node:fs'
      export const hostApi='2.12'
      export default function install(ctx){
        ctx.effect(()=>ctx.worldEvents.subscribe({mode:${JSON.stringify(mode)},type:${JSON.stringify(type)},
          open(){return event=>{
            fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({id:${JSON.stringify(id)},event})+'\\n')
            ${i === 2 ? `if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'1');throw Error('temporary')}return 'apply'` : "return 'ack'"}
          }}
        }))
      }`,
      )
    writeFileSync(
      join(root, id + '.plugin.json'),
      JSON.stringify({ id, name: id, version: '1', services: ['worldEvents'] }),
    )
    return { id: 'install-' + id, enabled: true, nativeAllowed: true, path: file }
  })
  const alternatePath = join(root, 'alternate.mjs'),
    useAlternate = join(root, 'use-alternate')
  writeFileSync(
    alternatePath,
    `import fs from 'node:fs'; export const hostApi='2.12'
    export default ctx=>{ctx.effect(()=>ctx.content.register({
      id:'alternate-rules',version:'1',dataVersion:1,configFile:'alternative-rules.json',
      generate(config){return fs.existsSync(${JSON.stringify(useAlternate)}) ? {worldEventRules:config.rules.map(r=>r.id)} : {}}
    }))}`,
  )
  writeFileSync(
    join(root, 'alternate.plugin.json'),
    JSON.stringify({ id: 'alternate-rules', name: 'replacement', version: '1', services: ['content'] }),
  )
  mods.push({ id: 'alternate-install', enabled: true, nativeAllowed: true, path: alternatePath })
  const plugins = await loadHostPlugins(mods, {}, {}, { gameplayIds: Object.keys(meta.plugins) })
  cleanup.push(() => plugins.close())
  const stub = await startFakeProvider('openai', () =>
    wakes?.failModel ? { dropReply: true } : { tool: { decision: 'abstain' } },
  )
  cleanup.push(() => stub.close())
  async function open(replace = false, directory = data) {
    // Same locked pack and save. A different, installed Cordis generator now proposes the rule ID.
    if (replace) writeFileSync(useAlternate, '1')
    const content = plugins.seams.content!.map(g =>
      g.id === officialWorldEvents.id && replace ? { ...g, identity: 'inactive', generate: () => ({}) } : g,
    )
    return WorldHostRuntime.create({
      models: fakeModels(stub.endpoint),
      ...(wakes
        ? { playSettings: playSettings({ autonomyOpportunities: wakes.ordinary ? 2 : 0, autonomyNpcCalls: 2 }) }
        : {}),
      packPath: pack,
      dataDirectory: directory,
      ...(pacing || calendar || wakes ? { storyNodes: true } : {}),
      plugins: { ...plugins.seams, content },
    })
  }
  let runtime = await open()
  cleanup.push(() => runtime.close())
  function history() {
    const db = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
    try {
      const events = db.readEvents(runtime.address)
      const commits = events
        .filter(e => e.eventType === 'world.tick-advanced')
        .flatMap(e => {
          const a = db.readRoundAuthority(runtime.address, e.transactionId)?.authority
          return a?.source === source ? [{ seq: e.seq, tx: e.transactionId, a }] : []
        })
      return { events, commits }
    } finally {
      db.close()
    }
  }
  return {
    get runtime() {
      return runtime
    },
    history,
    consumers: plugins.seams.worldEventConsumers!,
    root,
    pack,
    stub,
    log: (): { id: string; event: Record<string, string> }[] =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map(s => JSON.parse(s))
        : [],
    async restore(node: { id: string; packHash: string }) {
      await runtime.close()
      const target = join(root, 'restored-' + randomUUID())
      restoreStoryNode(data, node.id, target, node.packHash)
      runtime = await open(false, target)
    },
    async reopen(replace = false) {
      await runtime.close()
      runtime = await open(replace)
    },
  }
}

it('settles round four during cooking, delivers authorized envelopes and persists independent receipts across reopen', async () => {
  const f = await fixture()
  await f.runtime.perform(wait)
  await f.runtime.perform(wait)
  const started = await f.runtime.activityAction({
    activityKey: 'cook',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: randomUUID(),
  })
  const cook = started.activities!.find(a => a.activityKey === 'cook')!
  expect(f.log()).toEqual([])
  const callsBeforeOutage = f.stub.calls.length
  const dark = await f.runtime.activityAction({
    activityKey: 'cook',
    activityId: String(cook.id),
    revision: Number(cook.revision),
    operation: 'heat-stove',
    parameters: {},
    requestId: randomUUID(),
  })
  expect(dark.activities!.filter(a => (a.game as WorldJsonObject | undefined)?.active)).toHaveLength(1)
  expect(dark.activities!.find(a => a.activityKey === 'cook')).toMatchObject({
    id: cook.id,
    game: { phase: 'simmer', public: { completed: 1 } },
  })
  const before = dark.activities!.find(a => a.activityKey === 'cook')!
  const withStove = () =>
    f.runtime.activityAction({
      activityKey: 'cook',
      activityId: String(before.id),
      revision: Number(before.revision),
      operation: 'electric-finish',
      parameters: {},
      requestId: randomUUID(),
    })
  await expect(withStove()).rejects.toThrow('停电，电炉无法加热。')
  const after = await f.runtime.state()
  expect(after.activities).toEqual(dark.activities)
  expect(before.game).toMatchObject({ public: { completed: 1, portions: 1 } })
  expect(f.stub.calls.length).toBe(callsBeforeOutage)
  const { events, commits } = f.history()
  expect(commits).toHaveLength(1)
  const rows = events.filter(e => e.transactionId === commits[0]!.tx)
  expect(rows.map(r => r.eventType)).toEqual([
    'status.updated',
    'observation.upsert',
    'observation.upsert',
    'world.tick-advanced',
  ])
  expect(
    rows
      .slice(1, 3)
      .map(r => ((r.data as WorldJsonObject).value as WorldJsonObject).observerId)
      .sort(),
  ).toEqual(['character:companion', 'character:player'])
  expect(projectPlayerView(dark).history.some(row => row.text === rule.observation)).toBe(true)
  expect(f.log().map(r => r.id)).toEqual(['stage-cue'])
  expect(Object.keys(f.log()[0]!.event).sort()).toEqual(['occurrenceId', 'type'])
  await f.reopen(true)
  const simmer = (await f.runtime.state()).activities!.find(a => a.activityKey === 'cook')!
  const finished = await f.runtime.activityAction({
    activityKey: 'cook',
    activityId: String(simmer.id),
    revision: Number(simmer.revision),
    operation: 'plate',
    parameters: {},
    requestId: randomUUID(),
  })
  expect(finished.activities!.find(a => a.activityKey === 'cook')).toMatchObject({
    id: cook.id,
    game: { active: false, phase: 'finished', public: { completed: 2, portions: 0 } },
  })
  const ack = f.history().commits.at(-1)!
  expect(ack.a.receipts).toHaveLength(1)
  expect(
    f
      .history()
      .events.filter(e => e.transactionId === ack.tx)
      .map(e => e.eventType),
  ).toEqual(['world.tick-advanced'])
  await f.reopen(true)
  await f.runtime.perform(wait)
  await f.runtime.perform(wait)
  expect(f.log().map(r => r.id)).toEqual(['stage-cue', 'story-a', 'story-b', 'story-b'])
  const applied = f.history().commits.at(-1)!
  expect(f.history().events.find(e => e.transactionId === applied.tx)).toMatchObject({
    eventType: 'status.updated',
    data: { changes: [{ key: 'story', value: true }] },
  })
  expect(f.history().commits.flatMap(c => c.a.occurrences)).toHaveLength(1)
  expect(f.runtime.creatorInspection().worldEvents[0]?.occurrence?.deliveries).toEqual([
    { plugin: 'stage-cue', mode: 'live', receipt: false },
    { plugin: 'story-a', mode: 'durable', receipt: true },
    { plugin: 'story-b', mode: 'durable', receipt: true },
  ])
}, 60_000)

function failCommit(kind: 'before' | 'after' | 'receipt') {
  const original = WorldStore.prototype.commitRound
  let fired = false
  const spy = vi.spyOn(WorldStore.prototype, 'commitRound').mockImplementation(async function (
    this: WorldStore,
    request,
  ) {
    const matches =
      request.authority?.source === source &&
      (kind !== 'receipt' || (request.authority.receipts as string[]).length > 0)
    if (!matches || fired) return original.call(this, request)
    fired = true
    if (kind === 'after') await original.call(this, request)
    throw new Error('test interruption: ' + kind)
  })
  return {
    get fired() {
      return fired
    },
    restore: () => spy.mockRestore(),
  }
}

const clock = { dayKey: 'day', slotKey: 'slot', slots: ['清晨', '午后', '傍晚', '深夜'], at: { day: 2, slot: '傍晚' } }
const work = '/status take@entity:thermos {}'
const wageWrites = (f: Awaited<ReturnType<typeof fixture>>) =>
  f
    .history()
    .events.filter(e => e.eventType === 'status.updated')
    .flatMap(e => (e.data as WorldJsonObject).changes as WorldJsonObject[])
    .filter(c => c.key === 'wage' && c.value === 120)

it('recovers a committed wage and clock crossing on reopen and at all three branch prefixes', async () => {
  const f = await fixture(99, [], false, undefined, true)
  const before = await f.runtime.saveNode('before A')
  const fault = failCommit('before')
  await f.runtime.submit(work).catch(() => undefined)
  expect(fault.fired).toBe(true)
  fault.restore()
  expect(wageWrites(f)).toHaveLength(1)
  expect(occurrences(f)).toEqual([])
  const between = await f.runtime.saveNode('after A before B')
  await f.reopen()
  await f.runtime.state()
  expect(occurrences(f)).toEqual([])
  await f.runtime.perform(wait)
  const [outage] = occurrences(f)
  expect(outage).toMatchObject({ ruleId: rule.id, clockTransaction: expect.any(String) })
  expect(wageWrites(f)).toHaveLength(1)
  const after = await f.runtime.saveNode('after B')
  await f.restore(before)
  await f.runtime.perform(wait)
  expect(occurrences(f)).toEqual([])
  expect(wageWrites(f)).toEqual([])
  await f.restore(between)
  await f.runtime.perform(wait)
  expect(occurrences(f)).toMatchObject([{ clockTransaction: outage!.clockTransaction }])
  expect(wageWrites(f)).toHaveLength(1)
  await f.restore(after)
  await f.runtime.perform(wait)
  expect(occurrences(f)).toEqual([outage])
  expect(wageWrites(f)).toHaveLength(1)
})

it('refuses a changed calendar pack before activation and can reopen the original branch', async () => {
  const f = await fixture(99, [], false, undefined, true)
  const source = join(f.pack, 'worldpack.source.json')
  const locked = readFileSync(source, 'utf8')
  const before = f.history()
  writeFileSync(source, JSON.stringify({ ...JSON.parse(locked), packVersion: '2.1.0' }))
  await expect(f.reopen()).rejects.toThrow('锁定的世界包')
  writeFileSync(source, locked)
  await f.reopen()
  expect(f.history()).toEqual(before)
})

it('reconciles a lost calendar-event reply and withholds live cues from regeneration', async () => {
  const f = await fixture(99, [], false, undefined, true)
  const fault = failCommit('after')
  await f.runtime.submit(work).catch(() => undefined)
  expect(fault.fired).toBe(true)
  fault.restore()
  const original = occurrences(f)
  expect(original).toHaveLength(1)
  await f.reopen()
  await f.runtime.perform(wait)
  expect(occurrences(f)).toEqual(original)
  expect(f.log().filter(row => row.id === 'stage-cue')).toHaveLength(1)
  const g = await fixture(99, [], false, undefined, true)
  const state = await g.runtime.submit(work)
  const first = occurrences(g)[0]!
  await g.runtime.regenerate(state.tailRound!.id!, randomUUID())
  expect(occurrences(g)).toHaveLength(1)
  expect(occurrences(g)[0]!.occurrenceId).not.toBe(first.occurrenceId)
  expect(g.log().filter(row => row.id === 'stage-cue')).toHaveLength(1)
})

it('compares whole transactions and never bridges unknown clock values', () => {
  function row(tx: string, values: Record<string, unknown>, initial = false) {
    return {
      eventType: 'status.updated',
      transactionId: tx,
      data: {
        source: { kind: initial ? 'initial' : 'operation' },
        changes: Object.entries(values).map(([key, value]) => ({ key, value, holderId: null })),
      },
    } as unknown as StoredWorldEvent
  }
  const find = (...events: StoredWorldEvent[]) => firstPackTimeCrossing(events, clock, invalid)?.[0]?.transactionId
  const invalid = vi.fn()
  expect(
    find(
      row('init', { day: 1, slot: '深夜' }, true),
      row('sleep', { day: 2 }),
      row('sleep', { slot: '清晨' }),
      row('later', { slot: '深夜' }),
    ),
  ).toBe('later')
  expect(
    find(row('init', { day: 2, slot: '傍晚' }, true), row('same', { slot: '傍晚' }), row('back', { slot: '午后' })),
  ).toBeUndefined()
  expect(find(row('init', { day: 2 }, true), row('x', { slot: '未知' }), row('y', { slot: '深夜' }))).toBeUndefined()
  expect(invalid).toHaveBeenCalledTimes(2)
  invalid.mockClear()
  expect(
    find(row('native', { score: 0 }, true), row('pack', { day: 1, slot: '午后' }, true), row('due', { day: 3 })),
  ).toBe('due')
  expect(invalid).not.toHaveBeenCalled()
  expect(find(row('init', { score: 0 }, true))).toBeUndefined()
  expect(invalid).toHaveBeenCalledTimes(1)
  const facts = { locationIds: [rule.location], entityIds: [], characterIds: [], names: {}, entityLocations: {} }
  for (const extra of [
    { round: 1 },
    { trigger: 'paced' },
    { sceneNotices: [{ locations: [rule.location] }] },
    { audience: 'global', sceneNotices: [] },
    { when: { crossesPackTime: { ...clock, slots: ['傍晚', '傍晚'] } } },
  ])
    expect(() =>
      parseEventBook({ rules: [{ ...rule, round: undefined, when: { crossesPackTime: clock }, ...extra }] }, facts),
    ).toThrow()
})

const paced = (id: string, round: number, duringActivity = false) => ({
  id,
  round,
  trigger: 'paced',
  duringActivity,
  observation: id,
})
type Fixture = Awaited<ReturnType<typeof fixture>>
const occurrences = (f: Fixture) => f.history().commits.flatMap(commit => commit.a.occurrences as WorldJsonObject[])

it('offers only the opted-in event in an occupied kitchen, leaving the same activity and NPCs in place', async () => {
  const f = await fixture(99, [paced('optional', 2, true), paced('idle-only', 2)], false, {
    keys: ['optional', 'idle-only'],
  })
  const state = await f.runtime.activityAction({
    activityKey: 'cook',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: randomUUID(),
  })
  const cook = state.activities!.find(row => row.activityKey === 'cook')!
  const calls = f.stub.calls.length
  const act = (operation: string, revision: number) =>
    f.runtime.activityAction({
      activityKey: 'cook',
      activityId: String(cook.id),
      revision,
      operation,
      parameters: {},
      requestId: randomUUID(),
    })
  const dark = await act('heat-stove', Number(cook.revision))
  const simmer = dark.activities!.filter(row => (row.game as WorldJsonObject)?.active)
  expect(simmer).toHaveLength(1)
  expect(simmer[0]).toMatchObject({ id: cook.id, game: { phase: 'simmer', public: { completed: 1, portions: 1 } } })
  expect(occurrences(f)).toMatchObject([{ ruleId: 'optional', pacedRound: 2 }])
  const monitor = f.runtime.creatorInspection({ limit: 1 })
  expect(monitor.pacingDiagnostics?.decisions[0]).toMatchObject({
    round: 2,
    busy: true,
    candidates: [{ kind: 'event', key: 'optional' }],
    choice: { kind: 'event', key: 'optional' },
  })
  expect(monitor.worldEvents.find(r => r.rule.id === 'idle-only')).toMatchObject({
    lastCheck: { result: 'activity', round: 2 },
    occurrence: null,
  })
  expect(projectPlayerView(dark).history.some(row => row.text === 'optional')).toBe(true)
  expect(f.log().map(row => row.id)).toEqual(['stage-cue'])
  expect(f.stub.calls.length).toBe(calls)
  await expect(act('electric-finish', Number(simmer[0]!.revision))).rejects.toThrow('停电')
  await act('plate', Number(simmer[0]!.revision))
  expect(occurrences(f)).toMatchObject([{ ruleId: 'optional' }, { ruleId: 'idle-only', pacedRound: 3 }])
})

it('settles hard rules while pacing is off, then settles due hard rules before the chosen paced rule', async () => {
  const f = await fixture(1, [paced('optional', 1), { id: 'another-hard', round: 2 }], false, {
    keys: ['optional'],
    cooldown: 8,
  })
  await f.runtime.setPacing(false)
  await f.runtime.perform(wait)
  expect(occurrences(f).map(row => [row.ruleId, row.pacedRound])).toEqual([['kitchen-blackout', undefined]])
  await f.runtime.setPacing(true)
  await f.runtime.perform(wait)
  expect(occurrences(f).map(row => [row.ruleId, row.pacedRound])).toEqual([
    ['kitchen-blackout', undefined],
    ['another-hard', undefined],
    ['optional', 2],
  ])
  const [hard, selected] = f
    .history()
    .commits.filter(c =>
      (c.a.occurrences as WorldJsonObject[]).some(r => ['another-hard', 'optional'].includes(String(r.ruleId))),
    )
  expect(hard!.tx).not.toBe(selected!.tx)
  expect(hard!.seq).toBeLessThan(selected!.seq)
})

it('interleaves legacy beat and committed occurrence history for the same chooser', async () => {
  const choose = vi.spyOn(PacingScript.prototype, 'choose')
  const f = await fixture(99, [{ ...paced('second', 2), set: { key: 'story', value: false } }], false, {
    keys: ['second'],
    cooldown: 5,
    legacyBeat: true,
  })
  await f.runtime.perform(wait)
  await f.runtime.perform(wait)
  await f.runtime.perform(wait)
  expect(choose.mock.lastCall![0]).toMatchObject({
    candidates: [{ kind: 'beat', key: 'knock' }],
    history: {
      round: 3,
      fired: [
        { kind: 'beat', key: 'knock', round: 1 },
        { kind: 'event', key: 'second', round: 2 },
      ],
    },
  })
  expect(f.runtime.creatorInspection().pacing).toMatchObject({ reason: { why: 'cooling' } })
  const count = choose.mock.calls.length
  const first = f.runtime.creatorInspection({ limit: 1 })
  const second = f.runtime.creatorInspection({ limit: 1 })
  expect(second.pacingDiagnostics?.decisions.map(d => [d.round, d.choice?.kind, d.beats[0]?.checks[0]?.met])).toEqual([
    [3, 'none', true],
    [2, 'event', false],
    [1, 'beat', true],
  ])
  expect(second.pacingDiagnostics).toEqual(first.pacingDiagnostics)
  expect(second.headSeq).toBe(first.headSeq)
  expect(choose).toHaveBeenCalledTimes(count)
})

it('uses commit order when a legacy managed start and a paced event share a projected round number', async () => {
  const choose = vi.spyOn(PacingScript.prototype, 'choose')
  const f = await fixture(
    99,
    [
      { ...paced('unlock', 1), set: { key: 'story', value: true } },
      { ...paced('at-start', 2, true), set: { key: 'story', value: true } },
      paced('at-simmer', 3, true),
    ],
    false,
    { keys: ['unlock', 'at-start', 'at-simmer'], cooldown: 5, managedCook: true },
  )
  await f.runtime.perform(wait)
  const state = await f.runtime.activityAction({
    activityKey: 'cook',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: randomUUID(),
  })
  const cook = state.activities!.find(row => row.activityKey === 'cook')!
  await f.runtime.activityAction({
    activityKey: 'cook',
    activityId: String(cook.id),
    revision: Number(cook.revision),
    operation: 'heat-stove',
    parameters: {},
    requestId: randomUUID(),
  })
  expect(choose.mock.lastCall![0].history.fired).toEqual([
    { kind: 'event', key: 'unlock', round: 1 },
    { kind: 'activity', key: 'cook', round: 1 },
    { kind: 'event', key: 'at-start', round: 2 },
  ])
  expect(f.runtime.creatorInspection().pacing).toMatchObject({ reason: { why: 'cooling', round: 3 } })
  expect(occurrences(f).map(row => row.ruleId)).toEqual(['unlock', 'at-start'])
})

it('ignores a provider choice outside the offered IDs and a rolled-back commit when deciding cooldown', async () => {
  const f = await fixture(99, [paced('first', 1), paced('later', 9)], false, { keys: ['first', 'later'], cooldown: 12 })
  const choose = vi
    .spyOn(PacingScript.prototype, 'choose')
    .mockReturnValueOnce({ kind: 'event', key: 'later', reason: {} })
  await f.runtime.perform(wait).catch(() => undefined)
  expect(choose.mock.calls[0]![0].candidates).toEqual([{ kind: 'event', key: 'first' }])
  expect(f.runtime.creatorInspection().pacingDiagnostics?.decisions[0]?.error).toContain('条件未满足')
  expect(occurrences(f)).toEqual([])
  choose.mockRestore()
  const fault = failCommit('before')
  await f.runtime.perform(wait).catch(() => undefined)
  expect(fault.fired).toBe(true)
  expect(occurrences(f)).toEqual([])
  expect(f.log()).toEqual([])
  fault.restore()
  await f.runtime.perform(wait)
  expect(occurrences(f)).toMatchObject([{ ruleId: 'first', pacedRound: 3 }])
  const inspected = f.runtime.creatorInspection({ limit: 1 })
  const committedId = inspected.worldEvents.find(r => r.rule.id === 'first')!.occurrence!.id
  const [committed, rolledBack, rejected] = inspected.pacingDiagnostics!.decisions
  expect(committed?.occurrenceId).toBe(committedId)
  expect(rolledBack?.occurrenceId).toEqual(expect.any(String))
  expect(rolledBack?.occurrenceId).not.toBe(committedId)
  expect(rejected?.occurrenceId).toBeUndefined()
})

it('replays the selected rule and uses only the effective node prefix for its cooldown', async () => {
  const f = await fixture(99, [paced('first', 2), paced('second', 3)], false, {
    keys: ['first', 'second'],
    cooldown: 6,
  })
  await f.runtime.perform(wait)
  const before = await f.runtime.saveNode('before-selection')
  const at = await f.runtime.perform(wait)
  const original = occurrences(f)[0]!
  expect(original).toMatchObject({ ruleId: 'first', pacedRound: 2 })
  await f.runtime.regenerate(at.tailRound!.id!, randomUUID())
  const replay = occurrences(f)[0]!
  expect(replay).toMatchObject({ ruleId: 'first', pacedRound: 2 })
  expect(replay.occurrenceId).not.toBe(original.occurrenceId)
  expect(f.log().map(row => row.id)).toEqual(['stage-cue'])
  await f.runtime.perform(wait)
  expect(occurrences(f)).toHaveLength(1)
  expect(f.runtime.creatorInspection().pacing).toMatchObject({ reason: { why: 'cooling', round: 3 } })
  await f.restore(before)
  expect(occurrences(f)).toEqual([])
  await f.runtime.setPacing(false)
  await f.runtime.perform(wait)
  await f.runtime.setPacing(true)
  await f.runtime.perform(wait)
  expect(occurrences(f)).toHaveLength(1)
  expect(occurrences(f)[0]!.pacedRound).toBe(3)
})

it.each(['before', 'after'] as const)('reconciles the committed prefix after a %s-commit fault', async kind => {
  const f = await fixture(1),
    fault = failCommit(kind)
  await f.runtime.perform(wait).catch(() => undefined)
  expect(fault.fired).toBe(true)
  expect(f.history().commits.length).toBe(kind === 'before' ? 0 : 1)
  expect(f.log().length).toBe(kind === 'before' ? 0 : 1)
  fault.restore()
  await f.runtime.perform(wait)
  expect(f.log().filter(e => e.id === 'stage-cue')).toHaveLength(1)
  expect(f.history().commits.flatMap(c => c.a.occurrences)).toHaveLength(1)
})

it('delivers a committed occurrence even when an independent later settlement hook fails', async () => {
  let failed = false
  const register = WorldExecutionEngine.prototype.registerCoreCycleEndHook
  vi.spyOn(WorldExecutionEngine.prototype, 'registerCoreCycleEndHook').mockImplementation(function (
    this: WorldExecutionEngine,
    hook,
  ) {
    if (hook.pluginId === 'host-world-events')
      register.call(this, {
        pluginId: 'test-following-hook',
        hookId: 'fail',
        order: 40,
        resolve: () => {
          failed = true
          throw new Error('controlled later fault')
        },
      })
    return register.call(this, hook)
  })
  const f = await fixture(1)
  await f.runtime.perform(wait).catch(() => undefined)
  expect(failed).toBe(true)
  expect(f.history().commits).toHaveLength(1)
  expect(f.log().map(x => x.id)).toEqual(['stage-cue'])
})

it('reopens after receipt preparation but before commit; branch forks inherit only effective receipts', async () => {
  const f = await fixture(1)
  await f.runtime.perform(wait)
  const occurrence = f.history().commits[0]!,
    fault = failCommit('receipt')
  await f.runtime.perform(wait).catch(() => undefined)
  expect(fault.fired).toBe(true)
  expect(f.history().commits).toHaveLength(1)
  fault.restore()
  await f.reopen()
  await f.runtime.perform(wait)
  const receipt = f.history().commits.at(-1)!
  expect(receipt.a.receipts).toHaveLength(2)
  expect(f.log().map(x => x.id)).toEqual(['stage-cue', 'story-a', 'story-b', 'story-a', 'story-b'])
  const db = new WorldStore(join(f.runtime.dataDirectory, 'world.sqlite'))
  try {
    const forks = [
      { seq: occurrence.seq, seen: false },
      { seq: receipt.seq, seen: true },
    ]
    for (const fork of forks) {
      const child = { ...f.runtime.address, branchId: brandId('branch:fork-' + fork.seq, 'BranchId') }
      db.forkBranch(f.runtime.address, child, fork.seq)
      expect(db.readRoundAuthority(child, occurrence.tx)?.authority).toEqual(occurrence.a)
      expect(!!db.readRoundAuthority(child, receipt.tx)).toBe(fork.seen)
      const path = join(f.runtime.dataDirectory, 'world.sqlite'),
        store = new WorldStore(path),
        leases = new WriterLeaseService(path)
      const mounted = new WorldEventRuntime(
        store,
        child,
        String(occurrence.a.packId),
        { rules: [], grants: [{ plugin: 'story-a', type, mode: 'durable' }] },
        f.consumers,
        undefined,
        new Set(),
      )
      try {
        mounted.select()
        const settled = await executeWorldRound(
          { store, leases, address: child, owner: 'test:child:' + fork.seq },
          snapshot => mounted.settle(snapshot, 'test:fork-cycle', snapshot.head.headSeq),
        )
        expect(!!settled).toBe(!fork.seen)
      } finally {
        mounted.close()
        leases.close()
      }
    }
  } finally {
    db.close()
  }
})

it('regenerates without delivering discarded or historical live cues and consumes only the selected occurrence', async () => {
  const f = await fixture(1)
  const state = await f.runtime.perform(wait),
    original = f.log()[0]!.event.occurrenceId
  const tail = state.tailRound!
  expect(tail.canRegenerate).toBe(true)
  const other = await f.runtime.regenerate(tail.id!, randomUUID())
  const alternate = (f.history().commits[0]!.a.occurrences as WorldJsonObject[])[0]!.occurrenceId
  expect(alternate).not.toBe(original)
  expect(f.log().map(x => x.event.occurrenceId)).toEqual([original])
  await f.runtime.selectCandidate(other.tailRound!.id!, tail.candidateIds![0]!, randomUUID())
  await f.runtime.perform(wait)
  expect(new Set(f.log().map(x => x.event.occurrenceId))).toEqual(new Set([original]))
  expect(f.log().filter(x => x.id === 'stage-cue')).toHaveLength(1)
})

it('uses exact custody and active scene membership at commit; global and no-witness facts also commit', async () => {
  const f = await fixture(2, [
    { id: 'all', audience: 'global', observation: 'global' },
    { id: 'empty', audience: { holds: 'entity:brass-key' }, observation: 'unseen' },
    { id: 'default', observation: 'local' },
  ])
  await f.runtime.submit('/status take@entity:thermos {}')
  await f.runtime.submit('/act move {"locationId":"location:back-room"}')
  const { commits, events } = f.history()
  expect(commits).toHaveLength(1)
  const lines = events
    .filter(e => e.transactionId === commits[0]!.tx && e.eventType === 'observation.upsert')
    .map(e => (e.data as WorldJsonObject).value as WorldJsonObject)
  const witnesses = (text: string) =>
    lines
      .filter(l => (l.content as WorldJsonObject).eventNotice === text)
      .map(l => l.observerId)
      .sort()
  expect(witnesses(rule.observation)).toEqual(['character:companion', 'character:player'])
  expect(witnesses('global')).toEqual(['character:companion', 'character:friend', 'character:player'])
  expect(witnesses('local')).toEqual(['character:companion'])
  expect(witnesses('unseen')).toEqual([])
  expect(commits[0]!.a.occurrences).toHaveLength(4)
})

it('requires the actual subscribing plugin to declare the service, including nested registrations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'world-event-owner-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'hidden.mjs')
  writeFileSync(
    file,
    `export const hostApi='2.12'; export default ctx=>{
    ctx.plugin(function child(c){c.worldEvents.subscribe({mode:'live',type:'power.outage@1',open:()=>()=>{}})})
  }`,
  )
  writeFileSync(
    join(root, 'hidden.plugin.json'),
    JSON.stringify({ id: 'hidden', name: 'hidden', version: '1', services: ['content'] }),
  )
  await expect(loadHostPlugins([{ id: 'stage-cue', path: file, enabled: true, nativeAllowed: true }])).rejects.toThrow()
})

it.each(['dead', 'departed', 'incapacitated'])(
  'excludes %s characters from global service-independent observations',
  async lifecycleState => {
    const register = WorldExecutionEngine.prototype.registerCoreCycleEndHook
    vi.spyOn(WorldExecutionEngine.prototype, 'registerCoreCycleEndHook').mockImplementation(function (
      this: WorldExecutionEngine,
      hook,
    ) {
      if (hook.pluginId === 'host-world-events')
        register.call(this, {
          pluginId: 'test-lifecycle',
          hookId: 'setup',
          order: -16,
          resolve: () => ({
            events: [
              {
                eventType: 'character.lifecycle-changed',
                eventVersion: 1,
                data: { characterId: 'character:friend', lifecycleState },
              },
            ],
            authority: { source: 'fixture-lifecycle' },
          }),
        })
      return register.call(this, hook)
    })
    const f = await fixture(1, [{ id: 'global-event', audience: 'global', observation: 'all-active' }])
    await f.runtime.perform(wait)
    const { commits, events } = f.history()
    const observers = events
      .filter(e => e.eventType === 'observation.upsert' && e.transactionId === commits[0]!.tx)
      .map(e => (e.data as WorldJsonObject).value as WorldJsonObject)
      .filter(v => (v.content as WorldJsonObject).eventNotice === 'all-active')
    expect(observers.map(v => v.observerId).sort()).toEqual(['character:companion', 'character:player'])
  },
)

it('recovers a missing receipt after abrupt child-process exit inside leased adjudication', async () => {
  const f = await fixture(1)
  await f.runtime.perform(wait)
  const occurrence = f.history().commits[0]!
  const path = join(f.runtime.dataDirectory, 'world.sqlite'),
    address = f.runtime.address
  await f.runtime.close()
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/fixtures/world-event-receipt-crash.mjs',
      path,
      f.root,
      JSON.stringify(address),
      String(occurrence.a.packId),
    ],
    { encoding: 'utf8', timeout: 15000 },
  )
  expect(result.status, result.stderr).toBe(86)
  await delay(170)
  await f.reopen()
  expect(f.history().commits).toHaveLength(1)
  expect(f.log().map(e => e.id)).toEqual(['stage-cue', 'story-a'])
  await f.runtime.perform(wait)
  expect(f.log().map(e => e.id)).toEqual(['stage-cue', 'story-a', 'story-a', 'story-b'])
  const receipt = f.history().commits.at(-1)!
  expect(receipt.a.receipts).toHaveLength(1)
}, 30000)

it('deduplicates overlapping witness predicates and rejects an undeclared state write', async () => {
  const f = await fixture(1)
  await f.runtime.submit('/status take@entity:thermos {}')
  const { commits, events } = f.history()
  const witnesses = events.filter(e => e.transactionId === commits[0]!.tx && e.eventType === 'observation.upsert')
  expect(witnesses.map(e => ((e.data as WorldJsonObject).value as WorldJsonObject).observerId).sort()).toEqual([
    'character:companion',
    'character:player',
  ])
  await expect(fixture(1, [{ id: 'unowned', set: { key: 'private-flag', value: true } }])).rejects.toThrow(
    'pack-owned public boolean',
  )
})

it('seals startup registration and cancels an open handler when its fiber is disposed', async () => {
  const root = new Context(),
    bind = installWorldEventRegistry(root)
  cleanup.push(() => root.fiber.dispose())
  const receive = vi.fn()
  let signal: AbortSignal | undefined
  const sub = {
    type,
    mode: 'live' as const,
    open(scope: { signal: AbortSignal }) {
      signal = scope.signal
      return receive
    },
  }
  let late!: () => unknown
  const fiber = root.plugin(ctx => {
    ctx.worldEvents.subscribe(sub)
    late = () => ctx.worldEvents.subscribe(sub)
  })
  await fiber
  const consumers = bind(new Map([[fiber.uid!, { id: 'stage-cue', allowed: true }]]))
  const [consumer] = consumers
  expect(consumer!.active()).toBe(true)
  expect(late).toThrow('during plugin startup')

  const f = await fixture(1, [{ id: 'second-outage', round: 2 }])
  const mounted = new WorldEventRuntime(
    new WorldStore(join(f.runtime.dataDirectory, 'world.sqlite')),
    f.runtime.address,
    'pack:multiple-activities',
    { rules: [], grants: [{ plugin: 'stage-cue', type, mode: 'live' }] },
    consumers,
    undefined,
    new Set(),
  )
  cleanup.push(() => mounted.close())
  mounted.select()
  await f.runtime.perform(wait)
  mounted.flushLive()
  expect(receive).toHaveBeenCalledTimes(1)
  expect(signal?.aborted).toBe(false)

  await fiber.dispose()
  expect(consumer!.active()).toBe(false)
  expect(signal?.aborted).toBe(true)
  await f.runtime.perform(wait)
  mounted.flushLive()
  expect(receive).toHaveBeenCalledTimes(1)
})

it('surfaces a failed committed-record verification without delivering an unverified envelope', async () => {
  const f = await fixture(1)
  const read = WorldStore.prototype.readRoundAuthority
  const spy = vi.spyOn(WorldStore.prototype, 'readRoundAuthority').mockImplementation(function (
    this: WorldStore,
    address,
    tx,
  ) {
    const record = read.call(this, address, tx)
    if (record?.authority.source === source) throw new Error('simulated storage verification fault')
    return record
  })
  const state = await f.runtime.perform(wait)
  expect(state.error).toBe(true)
  expect(state.notice).toContain('无法核实')
  expect(f.log()).toEqual([])
  spy.mockRestore()
  expect(f.history().commits).toHaveLength(1)
})

it('never combines separate active scenes just because their physical location matches', async () => {
  const f = await fixture(1, [], true)
  await f.runtime.submit('/status take@entity:thermos {}')
  const { commits, events } = f.history()
  const observers = events.filter(e => e.transactionId === commits[0]!.tx && e.eventType === 'observation.upsert')
  expect(observers.map(e => ((e.data as WorldJsonObject).value as WorldJsonObject).observerId)).toEqual([
    'character:player',
  ])
})

const wakeCompanion = { recipients: ['character:companion', 'character:friend'] }
const wakeTransitions = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.history().commits.flatMap(c => (c.a.wakeKey ? [c.a.to] : []))

function focusedNotice(context: {
  stimulus: { observation?: string; content?: { eventNotice?: string } }[]
  history: { kind: string; content: { content: { eventNotice?: string } } }[]
}) {
  const [item] = context.stimulus
  const match = /^context\.history\[(\d+)\]$/.exec(item?.observation ?? '')
  return match ? context.history[Number(match[1])]?.content.content.eventNotice : item?.content?.eventNotice
}

it('delivers one committed personal event decision outside ordinary autonomy, including retry and reopen', async () => {
  const f = await fixture(1, [], false, undefined, false, wakeCompanion)
  await f.runtime.perform(wait)
  expect(f.stub.calls).toHaveLength(1)
  const wire = f.stub.calls[0]!.userText
  const context = JSON.parse(wire).context
  expect(context.character.characterId).toBe('character:companion')
  expect(context.stimulus).toEqual([{ observation: expect.stringMatching(/^context\.history\[\d+\]$/) }])
  expect(focusedNotice(context)).toBe(rule.observation)
  expect(wire.split(rule.observation)).toHaveLength(2)
  expect(wire).not.toMatch(/kitchen-blackout|power\.outage@1|wakeRecipients|:witness:/)
  expect(wakeTransitions(f)).toEqual(['claimed', 'completed'])
  await f.reopen()
  expect(f.stub.calls).toHaveLength(1)
  await f.runtime.perform(wait)
  expect(f.stub.calls).toHaveLength(1)
})

it('holds the event decision through an active cooking turn and reopen until its participant is released', async () => {
  const f = await fixture(2, [], false, undefined, false, wakeCompanion)
  const start = await f.runtime.activityAction({
    activityKey: 'cook',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: 'cook-start',
  })
  const cook = start.activities!.find(a => a.activityKey === 'cook')!
  const step = (revision: number, operation: string) =>
    f.runtime.activityAction({
      activityKey: 'cook',
      activityId: String(cook.id),
      revision,
      operation,
      parameters: {},
      requestId: 'cook-' + operation,
    })
  const simmer = await step(Number(cook.revision), 'heat-stove')
  expect(f.stub.calls).toHaveLength(0)
  for (let i = 0; i < 17; i++) await f.runtime.submit('我想调查停电。', 'cooking-line-' + i)
  expect(f.stub.calls).toHaveLength(0)
  const events = f
    .history()
    .events.filter(row => row.eventType === 'observation.upsert')
    .map(row => (row.data as WorldJsonObject).value as WorldJsonObject)
  const own = events.filter(row => row.observerId === 'character:companion')
  const startAt = own.findIndex(row => (row.content as WorldJsonObject).eventNotice === rule.observation)
  expect(startAt).toBeGreaterThanOrEqual(0)
  expect(own.slice(startAt + 1).filter(row => JSON.stringify(row.content).includes('我想调查停电。'))).toHaveLength(17)
  await f.reopen()
  expect(f.stub.calls).toHaveLength(0)
  const revision = Number(simmer.activities!.find(a => a.activityKey === 'cook')!.revision)
  await step(revision, 'plate')
  const wire = f.stub.calls[0]!.userText
  expect(JSON.parse(wire).context.stimulus).toEqual([{ content: { eventNotice: rule.observation } }])
  expect(wire.split(rule.observation)).toHaveLength(2)
  expect(wakeTransitions(f)).toEqual(['claimed', 'completed'])
  expect(f.stub.calls).toHaveLength(1)
  await step(revision, 'plate')
  expect(f.stub.calls).toHaveLength(1)
})

it.each(['before', 'after'] as const)('recovers wakeups only from committed occurrences after %s fault', async kind => {
  const f = await fixture(1, [], false, undefined, false, wakeCompanion)
  const fault = failCommit(kind)
  await f.runtime.perform(wait).catch(() => undefined)
  expect(fault.fired).toBe(true)
  expect(f.stub.calls).toHaveLength(0)
  expect(f.history().commits).toHaveLength(kind === 'before' ? 0 : 1)
  fault.restore()
  await f.reopen()
  expect(f.stub.calls).toHaveLength(0)
  await f.runtime.perform(wait)
  expect(f.stub.calls).toHaveLength(1)
  expect(wakeTransitions(f)).toEqual(['claimed', 'completed'])
})

it('withholds an indeterminate event decision across reopen and subsequent eligible windows', async () => {
  const f = await fixture(1, [], false, undefined, false, { ...wakeCompanion, failModel: true })
  await f.runtime.perform(wait).catch(() => undefined)
  expect(f.stub.calls).toHaveLength(1)
  expect(wakeTransitions(f)).toEqual(['claimed'])
  await f.reopen()
  await f.runtime.perform(wait)
  expect(f.stub.calls).toHaveLength(1)
  expect(wakeTransitions(f)).toEqual(['claimed'])
})

it('does not dispatch during candidate generation or replay a completed decision on reselect', async () => {
  const f = await fixture(1, [], false, undefined, false, wakeCompanion)
  const state = await f.runtime.perform(wait)
  expect(f.stub.calls).toHaveLength(1)
  const tail = state.tailRound!
  const other = await f.runtime.regenerate(tail.id!, randomUUID())
  expect(f.stub.calls).toHaveLength(1)
  expect(wakeTransitions(f)).toEqual([])
  await f.runtime.selectCandidate(other.tailRound!.id!, tail.candidateIds![0]!, randomUUID())
  expect(wakeTransitions(f)).toEqual(['claimed', 'completed'])
  await f.runtime.perform(wait)
  expect(f.stub.calls).toHaveLength(1)
})

it('reserves each occurrence separately and leaves excess work pending to the next window', async () => {
  const companion = ['character:companion']
  const extra = Array.from({ length: 4 }, (_, i) => ({
    id: 'distinct-' + i,
    observation: i < 2 ? '又一声雷响' : '独立事项 ' + i,
    wakeCharacters: companion,
  }))
  const f = await fixture(1, extra, false, undefined, false, { recipients: companion })
  await f.runtime.perform(wait)
  expect(f.stub.calls).toHaveLength(4)
  expect(wakeTransitions(f).filter(s => s === 'completed')).toHaveLength(4)
  await f.reopen()
  await f.runtime.perform(wait)
  expect(f.stub.calls.map(c => focusedNotice(JSON.parse(c.userText).context))).toEqual([
    rule.observation,
    ...extra.map(e => e.observation),
  ])
  const duplicateText = f.stub.calls.slice(1, 3).map(c => JSON.parse(c.userText).context)
  expect(duplicateText[0].history).toEqual(duplicateText[1].history)
  expect(duplicateText[0].stimulus).not.toEqual(duplicateText[1].stimulus)
  expect(wakeTransitions(f).filter(s => s === 'completed')).toHaveLength(5)
})

it('serves a pending occurrence after ordinary autonomy runs out of its own budget', async () => {
  const f = await fixture(1, [], false, undefined, false, { ...wakeCompanion, ordinary: true })
  const fault = failCommit('after')
  await f.runtime.submit('/act speak {"text":"自己记一下。","scope":"self","addresseeIds":[]}').catch(() => undefined)
  expect(fault.fired).toBe(true)
  fault.restore()
  await f.reopen()
  const state = await f.runtime.submit(work)
  const prompts = f.stub.calls.map(c => JSON.parse(c.userText).context)
  expect(prompts.some(c => c.character.characterId === 'character:friend')).toBe(true)
  expect(
    prompts.filter(c => focusedNotice(c) === rule.observation && c.character.characterId === 'character:companion'),
  ).toHaveLength(1)
  expect(wakeTransitions(f)).toEqual(['claimed', 'completed'])
  expect(state.debug.autonomy).toMatchObject({ terminalReason: 'call_limit', autonomousCalls: 1 })
})

it('defers a committed wake when a later settlement hook fails and never runs it on reopen alone', async () => {
  let enabled = true
  const register = WorldExecutionEngine.prototype.registerCoreCycleEndHook
  vi.spyOn(WorldExecutionEngine.prototype, 'registerCoreCycleEndHook').mockImplementation(function (
    this: WorldExecutionEngine,
    hook,
  ) {
    if (hook.pluginId === 'host-world-events')
      register.call(this, {
        pluginId: 'fault',
        hookId: 'later',
        order: 40,
        resolve: () => {
          if (enabled) throw new Error('test settlement failure')
          return undefined
        },
      })
    return register.call(this, hook)
  })
  const f = await fixture(1, [], false, undefined, false, wakeCompanion)
  await f.runtime.perform(wait).catch(() => undefined)
  expect(f.history().commits[0]!.a.occurrences).toMatchObject([{ wakeRecipients: ['character:companion'] }])
  expect(f.stub.calls).toHaveLength(0)
  enabled = false
  await f.reopen()
  expect(f.stub.calls).toHaveLength(0)
  await f.runtime.perform(wait)
  expect(wakeTransitions(f)).toEqual(['claimed', 'completed'])
  expect(f.stub.calls).toHaveLength(1)
})

it('keeps other witnesses and non-witness nominees out of the decision list', async () => {
  const f = await fixture(1, [], false, undefined, false, { recipients: ['character:friend'] })
  await f.runtime.perform(wait)
  expect(f.history().commits[0]!.a.occurrences).toHaveLength(1)
  expect(
    f
      .history()
      .events.filter(e => e.eventType === 'observation.upsert')
      .some(e => JSON.stringify(e.data).includes(rule.observation)),
  ).toBe(true)
  expect(f.stub.calls).toHaveLength(0)
  expect(wakeTransitions(f)).toEqual([])
})

it.each(['before claim', 'after claim', 'before completion', 'after completion'] as const)(
  'recovers conservatively at the %s receipt boundary',
  async fault => {
    const f = await fixture(1, [], false, undefined, false, wakeCompanion)
    const commit = WorldStore.prototype.commitRound
    let fired = false
    const spy = vi.spyOn(WorldStore.prototype, 'commitRound').mockImplementation(async function (
      this: WorldStore,
      request,
    ) {
      if (!fired && request.authority?.to === (fault.endsWith('claim') ? 'claimed' : 'completed')) {
        fired = true
        if (fault.startsWith('after')) await commit.call(this, request)
        throw new Error('controlled wake receipt interruption')
      }
      return commit.call(this, request)
    })
    await f.runtime.perform(wait).catch(() => undefined)
    expect(fired).toBe(true)
    spy.mockRestore()
    const calls = f.stub.calls.length
    expect(calls).toBe(fault.endsWith('claim') ? 0 : 1)
    await f.reopen()
    expect(f.stub.calls).toHaveLength(calls)
    await f.runtime.perform(wait)
    expect(f.stub.calls).toHaveLength(fault === 'after claim' ? 0 : 1)
    expect(wakeTransitions(f)).toEqual(
      fault === 'before completion' || fault === 'after claim' ? ['claimed'] : ['claimed', 'completed'],
    )
  },
)

it('restores only the pending or completed wake at the selected story prefix', async () => {
  const f = await fixture(2, [], false, undefined, false, wakeCompanion)
  const before = await f.runtime.saveNode('before event')
  await f.runtime.perform(wait)
  const fault = failCommit('after')
  await f.runtime.perform(wait).catch(() => undefined)
  expect(fault.fired).toBe(true)
  fault.restore()
  const pending = await f.runtime.saveNode('pending decision')
  await f.runtime.perform(wait)
  expect(f.stub.calls).toHaveLength(1)
  const completed = await f.runtime.saveNode('completed decision')
  await f.restore(before)
  expect(f.runtime.creatorInspection().worldEvents[0]?.occurrence).toBeNull()
  await f.runtime.perform(wait)
  expect(wakeTransitions(f)).toEqual([])
  expect(f.stub.calls).toHaveLength(1)
  await f.restore(pending)
  const witnessWake = () =>
    f.runtime
      .creatorInspection({ limit: 1 })
      .worldEvents[0]?.occurrence?.witnesses.find(w => w.id === 'character:companion')?.wake
  expect(witnessWake()).toBe('pending')
  expect(f.stub.calls).toHaveLength(1)
  await f.runtime.perform(wait)
  expect(f.stub.calls).toHaveLength(2)
  expect(wakeTransitions(f)).toEqual(['claimed', 'completed'])
  await f.restore(completed)
  expect(witnessWake()).toBe('completed')
  await f.runtime.perform(wait)
  expect(f.stub.calls).toHaveLength(2)
})

it('grants each selected authorized witness its own decision', async () => {
  const f = await fixture(
    1,
    [{ id: 'broadcast', audience: 'global', observation: '电台通知', wakeCharacters: wakeCompanion.recipients }],
    false,
    undefined,
    false,
    { recipients: ['character:friend'] },
  )
  await f.runtime.perform(wait)
  expect(f.stub.calls.map(c => JSON.parse(c.userText).context.character.characterId)).toEqual(wakeCompanion.recipients)
  const inspected = f.runtime.creatorInspection({ limit: 1 }).worldEvents
  expect(inspected[0]?.occurrence?.witnesses).toHaveLength(2)
  expect(inspected[0]?.occurrence?.witnesses.every(w => w.notice === rule.observation && w.wake === null)).toBe(true)
  expect(inspected[1]?.occurrence?.witnesses).toHaveLength(3)
  expect(inspected[1]?.occurrence?.witnesses.every(w => w.notice === '电台通知')).toBe(true)
  for (const { userText } of f.stub.calls) {
    const context = JSON.parse(userText).context
    expect(focusedNotice(context)).toBe('电台通知')
    expect(userText.split('电台通知')).toHaveLength(2)
    if (context.character.characterId === 'character:friend') expect(userText).not.toContain(rule.observation)
  }
})

it('rejects invalid wake declarations when loading author rules', () => {
  const facts = {
    characterIds: ['character:player', 'character:npc'],
    playerId: 'character:player',
    locationIds: [rule.location],
    entityIds: [],
    entityLocations: {},
    names: {},
  }
  for (const wakeCharacters of [
    [],
    ['character:player'],
    ['missing'],
    ['character:npc', 'character:npc'],
    Array(9).fill('character:npc'),
  ])
    expect(() => parseEventBook({ rules: [{ ...rule, wakeCharacters }] }, facts)).toThrow()
})
