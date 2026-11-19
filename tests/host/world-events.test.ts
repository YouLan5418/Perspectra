import { afterEach, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { installWorldEventRegistry } from '../../apps/host/src/world-event-registry.ts'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { WorldEventRuntime } from '../../apps/host/src/runtime/world-events.ts'
import { executeWorldRound, WorldExecutionEngine } from '@perspectra/core'
import { WriterLeaseService, WorldStore } from '@perspectra/core/store'
import { brandId, type WorldJsonObject } from '@perspectra/sdk/contracts'
import { WorldHostRuntime } from '../../apps/host/src/runtime/world-runtime.ts'
import { loadHostPlugins } from '../../apps/host/src/host-plugins.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'
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
async function fixture(round = 4, additionalRules: Record<string, unknown>[] = [], sharedLocation = false) {
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
  delete meta.scripts
  write('worldpack.source.json', meta)
  cpSync(resolve('tests/fixtures/world-event-cook.js'), join(pack, 'scripts/activities/cook.js'))
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
      { ...rule, round, audience: { anyOf: ['scene', { holds: 'entity:thermos' }] } },
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
  const stub = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  cleanup.push(() => stub.close())
  async function open(replace = false) {
    // Same locked pack and save. A different, installed Cordis generator now proposes the rule ID.
    if (replace) writeFileSync(useAlternate, '1')
    const content = plugins.seams.content!.map(g =>
      g.id === officialWorldEvents.id && replace ? { ...g, identity: 'inactive', generate: () => ({}) } : g,
    )
    return WorldHostRuntime.create({
      models: fakeModels(stub.endpoint),
      packPath: pack,
      dataDirectory: data,
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

it('seals startup registration and revokes a disposed fiber even without a caller-owned disposer', async () => {
  const root = new Context(),
    bind = installWorldEventRegistry(root)
  cleanup.push(() => root.fiber.dispose())
  const sub = { type, mode: 'live' as const, open: () => () => {} }
  let late!: () => unknown
  const fiber = root.plugin(ctx => {
    ctx.worldEvents.subscribe(sub)
    late = () => ctx.worldEvents.subscribe(sub)
  })
  await fiber
  const [consumer] = bind(new Map([[fiber.uid!, { id: 'stage-cue', allowed: true }]]))
  expect(consumer!.active()).toBe(true)
  expect(late).toThrow('during plugin startup')
  await fiber.dispose()
  expect(consumer!.active()).toBe(false)
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
