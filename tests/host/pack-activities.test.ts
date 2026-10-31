import { type Server } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WorldStore } from '@harness-world/store-sqlite'
import type { WorldJsonObject } from '@harness-world/contracts'
import { brandId, interactionPackageDescription, resolutionAuthority } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { WorldBranchComponentFactory } from '@harness-world/application'
import { compileWorldPackSource } from '@harness-world/world-pack'
import type { CompiledWorldManifest } from '@harness-world/kernel'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import type { HostState } from '../../desktop/host/http-server.ts'
import { frontendActionRequest } from '../../packages/frontend/src/player-view.ts'
import { projectPlayerView, FrontendActions } from '../../desktop/host/frontend-adapter.ts'
import { PackActivity, readActivityWorld } from '../../desktop/host/pack-activity.ts'
import { PackActivities } from '../../desktop/host/pack-activities.ts'
import { restoreStoryNode } from '../../desktop/story-nodes.ts'
import type { CoreRunner } from '../../desktop/host/memory/python-worker.ts'
import { createChatServer, fakeModels } from '../support/fake-provider.ts'

const roots: string[] = [],
  servers: Server[] = [],
  runtimes: WorldHostRuntime[] = [],
  catalogs: PackActivities[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const catalog of catalogs.splice(0)) catalog.close()
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})
async function fixture(secondHook = '', dynamic?: { min: number; max: number; candidates?: string[] }) {
  const root = mkdtempSync(join(tmpdir(), 'multi-activity-'))
  roots.push(root)
  const pack = join(root, 'pack'),
    data = join(root, 'data')
  cpSync(resolve('examples/world-packs/launcher-demo'), pack, { recursive: true })
  mkdirSync(join(pack, 'scripts/activities'))
  const original = readFileSync(join(pack, 'scripts/activity.js'), 'utf8').replace(
    'const answer = 1 + Math.floor(Math.random() * 100);',
    'const answer = 73;',
  )
  for (const key of ['guess', 'other'])
    writeFileSync(
      join(pack, 'scripts/activities', key + '.js'),
      original
        .replace("title: '轮流猜数字'", "title: '" + key + "'")
        .replace('internal: { answer }', "internal: { answer, secret:'" + key + "-internal-secret' }")
        .replace(
          'private: { [playerId]: {}, [npcId]: {} }',
          "private: { [playerId]: {}, [npcId]: { secret:'" + key + "-npc-secret' } }",
        ) + (key === 'other' ? secondHook : ''),
    )
  if (dynamic) {
    const file = join(pack, 'scripts/activities/other.js')
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        "npcIds: ['character:companion']",
        'participants: ' + JSON.stringify({ mode: 'player-select', ...dynamic }),
      ),
    )
  }
  const manifest = JSON.parse(readFileSync(join(pack, 'worldpack.source.json'), 'utf8'))
  manifest.assetFiles = ['scripts/activities/guess.js', 'scripts/activities/other.js']
  writeFileSync(join(pack, 'worldpack.source.json'), JSON.stringify(manifest))
  const inputs: WorldJsonObject[] = []
  const server = createChatServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += String(chunk)
    })
    request.on('end', () => {
      const wire = JSON.parse(body),
        input = JSON.parse(wire.messages.findLast((message: { role: string }) => message.role === 'user').content)
      inputs.push(input)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: 'submit_actions', arguments: JSON.stringify({ decision: 'abstain' }) } },
                ],
              },
            },
          ],
        }),
      )
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  const options = {
    packPath: pack,
    models: fakeModels('http://127.0.0.1:' + port + '/v1/chat/completions', 'openai', 'fixture'),
    timeoutMs: 5000,
  }
  const memoryRun: CoreRunner = async input =>
    input.operation === 'build'
      ? {
          archive: { scope: input.scope!, sources: input.sources!, facts: [], episodes: [], observations: [] },
          index: { scope: input.scope!, units: [], vectors: [] },
        }
      : { delivery: [], deliveryTrace: { delivered: [], activityCoverage: [] } }
  const create = async (directory = data) => {
    const runtime = await WorldHostRuntime.create({
      ...options,
      dataDirectory: directory,
      ...(directory === data ? {} : { memoryCore: true, memoryCoreRun: memoryRun, memoryCoreBuildRun: memoryRun }),
    })
    runtimes.push(runtime)
    return runtime
  }
  const runtime = await create()
  const events = () => {
    const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
    try {
      return store.readEvents(runtime.address)
    } finally {
      store.close()
    }
  }
  return { runtime, root, pack, data, inputs, create, events }
}
function progress(state: HostState, key: string): WorldJsonObject {
  return state.activities!.find(activity => activity.activityKey === key)!
}
function request(state: HostState, key: string, operation: string, parameters: WorldJsonObject = {}) {
  const activity = progress(state, key)
  return {
    activityKey: key,
    activityId: operation === 'start' ? null : (activity.id as string),
    revision: operation === 'start' ? 0 : Number(activity.revision),
    operation,
    parameters,
    requestId: randomUUID(),
  }
}
async function choose(runtime: WorldHostRuntime, label: string) {
  const action = projectPlayerView(await runtime.state()).actions.find(action => action.label === label)!
  expect(action).toBeDefined()
  return runtime.perform(action.action)
}

it('keeps the mounted application through activity handoffs and tail backups', async () => {
  const f = await fixture(),
    creates = vi.spyOn(WorldBranchComponentFactory.prototype, 'create')
  const started = await choose(f.runtime, '开始 guess')
  await f.runtime.activityAction(request(started, 'guess', 'guess', { value: 1 }))
  expect(creates).not.toHaveBeenCalled()
})

it('does not load world history for fixed-roster menus or absent automatic-start hooks', async () => {
  const f = await fixture(),
    pack = await compileWorldPackSource(
      f.pack,
      createInstalledInteractionPackages().map(interactionPackageDescription),
    ),
    catalog = PackActivities.load(f.pack, pack, join(f.data, 'world.sqlite'), f.runtime.address, 'character:player')!
  try {
    const reads = vi.spyOn(WorldStore.prototype, 'readEvents')
    expect(catalog.view('character:player')!.manualStart).not.toBe(false)
    expect(catalog.views('character:player')).toHaveLength(2)
    expect(await catalog.autoStart()).toBe(false)
    expect(reads).not.toHaveBeenCalled()
  } finally {
    catalog.close()
  }
})

it('shares committed activity state, reads only the new prefix, and closes its retained connection', async () => {
  const f = await fixture(),
    active = await choose(f.runtime, '开始 guess'),
    pack = await compileWorldPackSource(
      f.pack,
      createInstalledInteractionPackages().map(interactionPackageDescription),
    ),
    catalog = PackActivities.load(f.pack, pack, join(f.data, 'world.sqlite'), f.runtime.address, 'character:player')!
  const beforeSeq = Number(active.debug.headSeq)
  try {
    const original = catalog.current()!,
      copy = catalog.current()!,
      reads = vi.spyOn(WorldStore.prototype, 'readEventsRange'),
      closes = vi.spyOn(WorldStore.prototype, 'close')
    copy.game.active = false
    Object.assign(copy.game.private, { 'character:companion': { secret: 'overwritten' } })
    expect(catalog.current()).toEqual(original)
    expect((catalog.view('character:player')!.game as WorldJsonObject).private).toEqual({})
    expect(reads).not.toHaveBeenCalled()
    expect(closes).not.toHaveBeenCalled()
    const paused = await f.runtime.activityAction(request(active, 'guess', 'suspend'))
    reads.mockClear()
    closes.mockClear()
    expect(catalog.current()!.game.active).toBe(false)
    expect(catalog.current()!.revision).toBe(paused.activity!.revision)
    expect(reads).toHaveBeenCalledExactlyOnceWith(f.runtime.address, beforeSeq, Number(paused.debug.headSeq), [
      'activity.updated',
    ])
    expect(closes).not.toHaveBeenCalled()
    reads.mockClear()
    expect(catalog.current()!.game.active).toBe(false)
    expect(reads).not.toHaveBeenCalled()
    catalog.close()
    expect(closes).toHaveBeenCalledTimes(1)
    expect(() => catalog.current()).toThrow('Activity catalog is closed')
  } finally {
    catalog.close()
  }
})

it('selects independent activities, pauses both, isolates secrets, rejects old actions, and restores all progress from a story node', async () => {
  const f = await fixture(),
    initial = await f.runtime.state()
  expect(initial.activities).toHaveLength(2)
  let state = await choose(f.runtime, '开始 guess')
  const firstId = state.activity!.id
  const oldOption = projectPlayerView(state).actions.find(action => action.label === '主动让出回合')!.action
  await expect(f.runtime.activityAction(request(state, 'other', 'start'))).rejects.toThrow('已有活动')
  state = await f.runtime.activityAction(request(await f.runtime.state(), 'guess', 'guess', { value: 1 }))
  expect(f.inputs.length).toBeGreaterThan(0)
  expect(JSON.stringify(f.inputs)).toContain('guess-npc-secret')
  expect(JSON.stringify(f.inputs)).not.toContain('other-npc-secret')
  expect(JSON.stringify(f.inputs)).not.toContain('internal-secret')
  const debug = f.runtime.creatorInspection()
  expect(JSON.stringify(debug.activities)).toContain('guess-internal-secret')
  expect(JSON.stringify(debug.activities)).toContain('guess-npc-secret')
  expect(JSON.stringify(projectPlayerView(state))).not.toContain('guess-internal-secret')
  const game = structuredClone(state.activity!.game as WorldJsonObject)
  const committedGame = structuredClone(
    (
      (
        f
          .events()
          .findLast(
            event => event.eventType === 'activity.updated' && (event.data as WorldJsonObject).activityKey === 'guess',
          )!.data as WorldJsonObject
      ).state as WorldJsonObject
    ).game,
  )
  const pause = request(state, 'guess', 'suspend')
  state = await f.runtime.activityAction(pause)
  const pauseObservation = f.events().findLast(event => event.eventType === 'observation.upsert')!
    .data as WorldJsonObject
  expect(
    (((pauseObservation.value as WorldJsonObject).content as WorldJsonObject).resultMetadata as WorldJsonObject)
      .activity,
  ).toMatchObject({ lifecycle: 'suspended', active: false })
  const eventCount = f.events().length
  await f.runtime.activityAction(pause)
  expect(f.events()).toHaveLength(eventCount)
  expect(state.activity!.suspended).toBe(true)
  expect(state.availableActions?.some(action => action.actionType === 'move')).toBe(true)
  state = await choose(f.runtime, '开始 other')
  await expect(f.runtime.perform(oldOption)).rejects.toThrow()
  const latest = await f.runtime.state()
  state = await f.runtime.activityAction(request(latest, 'other', 'pass'))
  const otherInputs = f.inputs.filter(
    input => (input.context as WorldJsonObject).activity && (input.context as WorldJsonObject).activity !== undefined,
  )
  expect(JSON.stringify(otherInputs.at(-1))).toContain('other-npc-secret')
  expect(JSON.stringify(otherInputs.at(-1))).not.toContain('guess-npc-secret')
  state = await choose(f.runtime, '暂停 other')
  expect(state.activities!.every(activity => activity.suspended === true)).toBe(true)
  expect(JSON.stringify(projectPlayerView(state))).not.toContain('secret')
  const saved = structuredClone(state.activities)
  const node = await f.runtime.saveNode('两场活动暂停')
  state = await choose(f.runtime, '继续 guess')
  expect(state.activity!.id).toBe(firstId)
  expect((state.activity!.game as WorldJsonObject).public).toEqual(game.public)
  expect((state.activity!.game as WorldJsonObject).turn).toEqual(game.turn)
  const resumeEvent = f
    .events()
    .findLast(
      event => event.eventType === 'activity.updated' && (event.data as WorldJsonObject).operation === 'resume',
    )!
  expect(((resumeEvent.data as WorldJsonObject).state as WorldJsonObject).game).toEqual(committedGame)
  expect(progress(state, 'other').suspended).toBe(true)
  await f.runtime.escape()
  await f.runtime.close()
  const childData = join(f.root, 'child')
  restoreStoryNode(f.data, node.id, childData, node.packHash)
  const child = await f.create(childData)
  expect((await child.state()).activities).toEqual(saved)
  const resumed = await choose(child, '继续 other')
  expect(progress(resumed, 'guess').suspended).toBe(true)
  expect((resumed.activity!.game as WorldJsonObject).active).toBe(true)
}, 120_000)

it('checks current world conditions on resume and preserves paused progress when a hook rejects', async () => {
  const f = await fixture(
    "\nactivityScript.resume = (view, world) => world.locationId === 'location:back-room' ? {rejectReason:'请回前室继续'} : null;",
  )
  await choose(f.runtime, '开始 guess')
  await choose(f.runtime, '暂停 guess')
  await choose(f.runtime, '开始 other')
  await choose(f.runtime, '暂停 other')
  await f.runtime.submit('/act move {"locationId":"location:back-room"}')
  const paused = await f.runtime.state(),
    before = f.events()
  await expect(f.runtime.activityAction(request(paused, 'guess', 'resume'))).rejects.toThrow('同一场景')
  await expect(f.runtime.activityAction(request(await f.runtime.state(), 'other', 'resume'))).rejects.toThrow(
    '请回前室继续',
  )
  expect(f.events()).toEqual(before)
  expect((await f.runtime.state()).activities).toEqual(paused.activities)
  const abandoned = await choose(f.runtime, '放弃 other')
  expect(progress(abandoned, 'other').suspended).toBe(false)
  expect(progress(abandoned, 'guess').suspended).toBe(true)
  await f.runtime.submit('/act move {"locationId":"location:front-room"}')
  await choose(f.runtime, '开始 other')
  await choose(f.runtime, '暂停 other')
  const resumed = await choose(f.runtime, '继续 other')
  expect((resumed.activity!.game as WorldJsonObject).active).toBe(true)
}, 90_000)

it('rolls back a failed pause commit and retains active permissions and revision', async () => {
  const f = await fixture(),
    active = await choose(f.runtime, '开始 guess'),
    before = f.events()
  const commit = vi.spyOn(WorldStore.prototype, 'commitRound').mockRejectedValueOnce(new Error('pause commit failed'))
  await expect(f.runtime.activityAction(request(active, 'guess', 'suspend'))).rejects.toThrow('pause commit failed')
  commit.mockRestore()
  expect(f.events()).toEqual(before)
  const current = await f.runtime.state()
  expect(current.activity).toEqual(active.activity)
  expect(current.availableActions?.some(action => action.actionType === 'move')).toBe(false)
}, 60_000)

it('selects a visible partner, isolates the bystander, and retains the selected roster on pause and resume', async () => {
  const f = await fixture('', { min: 1, max: 1 }),
    initial = await f.runtime.state(),
    before = f.events().length
  const start = projectPlayerView(initial).actions.find(action => action.label === '开始 other')!
  expect(start.participantSelection?.candidates).toEqual([
    { id: 'character:companion', name: '同行者' },
    { id: 'character:friend', name: '留守者' },
  ])
  for (const npcIds of [
    [],
    ['character:player'],
    ['character:missing'],
    ['character:friend', 'character:friend'],
    ['character:friend', 'character:companion'],
  ]) {
    await expect(f.runtime.activityAction(request(initial, 'other', 'start', { npcIds }))).rejects.toThrow()
    expect(f.events()).toHaveLength(before)
  }
  const frontend = new FrontendActions(f.runtime)
  await frontend.perform(
    frontendActionRequest({
      requestId: 'selection:request',
      actionId: 'selection:action',
      operation: 'perform',
      payload: { optionId: start.id, npcIds: ['character:friend'] },
    }),
  )
  let state = await f.runtime.state()
  expect(state.activity!.participants).toEqual(['character:player', 'character:friend'])
  const newObservations = () =>
    f
      .events()
      .slice(before)
      .filter(event => event.eventType === 'observation.upsert')
      .map(event => (event.data as WorldJsonObject).value as WorldJsonObject)
  expect(newObservations().map(value => value.observerId)).not.toContain('character:companion')
  state = await f.runtime.activityAction(request(state, 'other', 'guess', { value: 1 }))
  expect(f.inputs.length).toBeGreaterThan(0)
  expect(JSON.stringify(f.inputs)).toContain('other-npc-secret')
  expect(JSON.stringify(f.inputs)).not.toContain('internal-secret')
  expect(newObservations().map(value => value.observerId)).not.toContain('character:companion')
  const source = readFileSync(join(f.pack, 'scripts/activities/other.js'), 'utf8')
  const activity = new PackActivity(
    source,
    join(f.data, 'world.sqlite'),
    f.runtime.address,
    'character:player',
    'other',
  )
  const context = { character: { characterId: 'character:companion' }, affordances: [] }
  expect(activity.projectContext(context, true)).toEqual(context)
  expect(() => activity.scoped(activity.current()!, 'character:companion')).toThrow('不是活动参与者')
  const store = new WorldStore(join(f.data, 'world.sqlite'))
  try {
    const record = store.readManifest(f.runtime.address)!,
      resolver = activity.rulebooks().resolve('builtin:speak-move', 2, 'outsider', f.runtime.address)
    const snapshot = activity.current()!
    expect(() =>
      resolver.resolve({
        manifest: record.manifest as CompiledWorldManifest,
        manifestHash: record.manifestHash,
        events: f.events(),
        characterId: brandId('character:companion', 'CharacterId'),
        resolutionAuthority: resolutionAuthority('agent', 'standard'),
        asOfWorldSeq: store.head(f.runtime.address).headSeq,
        action: {
          actionType: 'interact',
          parameters: {
            targetRef: { kind: 'character', id: 'character:companion' },
            bindingId: snapshot.id,
            definitionRef: { id: 'activity:quit', version: 1 },
            arguments: { activityId: snapshot.id, revision: snapshot.revision },
          },
        },
      }),
    ).toThrow('请求已失效')
  } finally {
    store.close()
  }
  const outsiderView = activity.view('character:companion')
  expect(outsiderView.id).toBeNull()
  expect(outsiderView.game).toBeUndefined()
  expect(outsiderView.participantSelection).toBeUndefined()
  const malicious = new PackActivity(
    source + "\nactivityScript.schedule=()=>({kind:'activate',characterId:'character:companion'});",
    join(f.data, 'world.sqlite'),
    f.runtime.address,
    'character:player',
    'other',
  )
  expect(() => malicious.schedule()).toThrow('未授权角色')
  const publicStart = f.events().length
  await f.runtime.submit('/act speak {"text":"PUBLIC_MARKER","scope":"scene_public"}')
  expect(
    f
      .events()
      .slice(publicStart)
      .filter(event => event.eventType === 'observation.upsert')
      .map(event => (event.data as WorldJsonObject).value as WorldJsonObject)
      .some(value => value.observerId === 'character:companion' && JSON.stringify(value).includes('PUBLIC_MARKER')),
  ).toBe(true)
  const privateStart = f.events().length
  await f.runtime.submit('/act speak {"text":"PRIVATE_MARKER","scope":"private","addresseeIds":["character:friend"]}')
  const bystander = f
    .events()
    .slice(privateStart)
    .filter(event => event.eventType === 'observation.upsert')
    .map(event => (event.data as WorldJsonObject).value as WorldJsonObject)
    .find(value => value.observerId === 'character:companion')!
  expect(bystander.content).toMatchObject({ contentVisibility: 'occurrence_only' })
  expect(JSON.stringify(bystander)).not.toContain('PRIVATE_MARKER')
  const directStart = f.events().length
  await f.runtime.submit('DIRECT_MARKER')
  expect(
    f
      .events()
      .slice(directStart)
      .filter(event => event.eventType === 'observation.upsert')
      .map(event => (event.data as WorldJsonObject).value as WorldJsonObject)
      .some(value => value.observerId === 'character:companion'),
  ).toBe(false)
  state = await choose(f.runtime, '暂停 other')
  expect(activity.view('character:companion').suspended).toBe(false)
  const saved = state.activity!.participants
  state = await choose(f.runtime, '继续 other')
  expect(state.activity!.participants).toEqual(saved)
  await f.runtime.escape()
  await f.runtime.submit('/act move {"locationId":"location:back-room"}')
  const remote = await f.runtime.state(),
    remoteEvents = f.events()
  expect((progress(remote, 'other').participantSelection as WorldJsonObject).candidates).toEqual([])
  await expect(
    f.runtime.activityAction(request(remote, 'other', 'start', { npcIds: ['character:friend'] })),
  ).rejects.toThrow('同一场景')
  expect(f.events()).toEqual(remoteEvents)
}, 120_000)

it('enforces an author candidate list and rejects changing a fixed activity roster', async () => {
  const f = await fixture('', { min: 1, max: 1, candidates: ['character:friend'] }),
    initial = await f.runtime.state()
  expect(
    ((progress(initial, 'other').participantSelection as WorldJsonObject).candidates as WorldJsonObject[]).map(
      candidate => candidate.id,
    ),
  ).toEqual(['character:friend'])
  const before = f.events()
  await expect(
    f.runtime.activityAction(request(initial, 'other', 'start', { npcIds: ['character:companion'] })),
  ).rejects.toThrow('候选限制')
  await expect(
    f.runtime.activityAction(request(initial, 'guess', 'start', { npcIds: ['character:friend'] })),
  ).rejects.toThrow('没有参数')
  expect(f.events()).toEqual(before)
}, 60_000)

it('lets only the selected invitee accept or decline and keeps invitation acceptance separate from movement', async () => {
  const f = await fixture(
    readFileSync(resolve('examples/world-packs/multiple-activities/scripts/activities/invite.js'), 'utf8'),
  )
  const state = await f.runtime.activityAction(
    request(await f.runtime.state(), 'other', 'start', { npcIds: ['character:friend'] }),
  )
  expect((state.activity!.game as WorldJsonObject).phase).toBe('invited')
  await expect(f.runtime.activityAction(request(state, 'other', 'respond', { choice: '接受' }))).rejects.toThrow(
    '未被允许',
  )
  const source = readFileSync(join(f.pack, 'scripts/activities/other.js'), 'utf8')
  const activity = new PackActivity(
    source,
    join(f.data, 'world.sqlite'),
    f.runtime.address,
    'character:player',
    'other',
  )
  const store = new WorldStore(join(f.data, 'world.sqlite'))
  try {
    const record = store.readManifest(f.runtime.address)!,
      snapshot = activity.current()!,
      resolver = activity.rulebooks().resolve('builtin:speak-move', 2, 'invite-test', f.runtime.address)
    for (const [choice, phase] of [
      ['接受', 'date'],
      ['拒绝', 'declined'],
    ]) {
      const result = resolver.resolve({
        manifest: record.manifest as CompiledWorldManifest,
        manifestHash: record.manifestHash,
        events: f.events(),
        characterId: brandId('character:friend', 'CharacterId'),
        resolutionAuthority: resolutionAuthority('agent', 'standard'),
        asOfWorldSeq: store.head(f.runtime.address).headSeq,
        action: {
          actionType: 'interact',
          parameters: {
            targetRef: { kind: 'character', id: 'character:friend' },
            bindingId: snapshot.id,
            definitionRef: { id: 'activity:respond', version: 1 },
            arguments: { activityId: snapshot.id, revision: snapshot.revision, choice: choice! },
          },
        },
      })
      const next = (result.events.find(event => event.eventType === 'activity.updated')!.data as WorldJsonObject)
        .state as WorldJsonObject
      expect(next.game).toMatchObject({ phase, active: choice === '接受' })
      expect(result.events.some(event => event.eventType === 'character.moved')).toBe(false)
      expect(result.observationScope?.recipientIds).toEqual(['character:player', 'character:friend'])
    }
  } finally {
    store.close()
  }
}, 60_000)

it('skips other activities’ start checks while one runs and offers the same start choices once it ends', async () => {
  const f = await fixture('', { min: 1, max: 1 })
  const idle = projectPlayerView(await f.runtime.state()).actions.find(action => action.label === '开始 other')!
  let state = await choose(f.runtime, '开始 guess')
  // While guess runs, no surface lists other's start, so its candidates and start conditions are not computed.
  const checks = vi.spyOn(PackActivity.prototype, 'autoStartCandidate')
  state = await f.runtime.activityAction(request(state, 'guess', 'guess', { value: 1 }))
  expect(checks).not.toHaveBeenCalled()
  expect(progress(state, 'other').participantSelection).toBeUndefined()
  expect(projectPlayerView(state).actions.some(action => action.label === '开始 other')).toBe(false)
  checks.mockRestore()
  state = await f.runtime.activityAction(request(await f.runtime.state(), 'guess', 'quit'))
  expect(state.activity?.game).toMatchObject({ active: false })
  const after = projectPlayerView(state).actions.find(action => action.label === '开始 other')!
  expect(after.participantSelection).toEqual(idle.participantSelection)
})

/** The `other` activity with an autoStart hook, read through a standalone catalog over the fixture world. */
async function autoStartCatalog(hook: string) {
  const f = await fixture('\nactivityScript.autoStart = ' + hook + ';\n'),
    pack = await compileWorldPackSource(
      f.pack,
      createInstalledInteractionPackages().map(interactionPackageDescription),
    ),
    catalog = PackActivities.load(f.pack, pack, join(f.data, 'world.sqlite'), f.runtime.address, 'character:player')!
  catalogs.push(catalog)
  return { f, catalog }
}

it('starts on labelled when entries like booleans and reports each labelled check', async () => {
  const { f, catalog } = await autoStartCatalog("() => ({ when: [['时段是深夜', true], ['玩家在厨房', true]] })")
  await f.runtime.close() // The standalone catalog commits the start, so the runtime releases its writer lease.
  expect(await catalog.autoStart()).toBe(true)
  expect(catalog.lastAutoStart()).toEqual([
    {
      activityKey: 'other',
      title: 'other',
      checks: [
        { label: '时段是深夜', met: true },
        { label: '玩家在厨房', met: true },
      ],
      started: true,
    },
  ])
  expect(catalog.current()?.game.active).toBe(true)
})

it('mixes labelled and bare entries and starts only when all hold', async () => {
  const { catalog } = await autoStartCatalog("() => ({ when: [['A', true], false] })")
  expect(await catalog.autoStart()).toBe(false)
  expect(catalog.lastAutoStart()).toEqual([
    {
      activityKey: 'other',
      title: 'other',
      checks: [
        { label: 'A', met: true },
        { label: null, met: false },
      ],
      started: false,
    },
  ])
})

it('rejects bad label shapes', async () => {
  const f = await fixture(),
    worldPath = join(f.data, 'world.sqlite'),
    source = readFileSync(join(f.pack, 'scripts/activities/other.js'), 'utf8'),
    world = readActivityWorld(worldPath, f.runtime.address)
  for (const when of [[['', true]], [['A']], [['A', 1]], [['长'.repeat(81), true]]]) {
    const activity = new PackActivity(
      source + '\nactivityScript.autoStart = () => ({ when: ' + JSON.stringify(when) + ' });\n',
      worldPath,
      f.runtime.address,
      'character:player',
      'other',
    )
    expect(() => activity.autoStartCandidate(world)).toThrow('自动开始条件必须是 1–32 个布尔值或 [标签, 布尔值]')
  }
  const longest = new PackActivity(
    source + "\nactivityScript.autoStart = () => ({ when: [['" + '长'.repeat(80) + "', true]] });\n",
    worldPath,
    f.runtime.address,
    'character:player',
    'other',
  )
  expect(longest.autoStartCandidate(world)?.checks).toEqual([{ label: '长'.repeat(80), met: true }])
})

it('evaluates automatic starts from committed state without committing', async () => {
  const { f, catalog } = await autoStartCatalog("() => ({ when: [['总是', true]] })")
  const before = f.events().length
  expect(catalog.evaluateAutoStart()).toEqual([
    { activityKey: 'other', title: 'other', checks: [{ label: '总是', met: true }], started: false },
  ])
  expect(f.events()).toHaveLength(before)
  expect(catalog.current()).toBeUndefined()
  expect(catalog.lastAutoStart()).toEqual([])
})

it('reports a throwing autoStart hook in evaluation and still throws in a round', async () => {
  const { f, catalog } = await autoStartCatalog("() => { throw new Error('坏了') }")
  const before = f.events().length
  expect(catalog.evaluateAutoStart()).toEqual([
    { activityKey: 'other', title: 'other', checks: null, started: false, error: '包内活动脚本执行失败或超时' },
  ])
  await expect(catalog.autoStart()).rejects.toThrow('包内活动脚本执行失败或超时')
  expect(catalog.lastAutoStart()).toEqual([
    { activityKey: 'other', title: 'other', checks: null, started: false, error: '包内活动脚本执行失败或超时' },
  ])
  expect(f.events()).toHaveLength(before)
})
