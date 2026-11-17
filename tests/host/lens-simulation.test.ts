import { createRequire } from 'node:module'
import type { ContentGameplay } from '@perspectra/sdk'
import { assembleRoleplay } from '../../apps/host/src/official-bundle.ts'
import { createRuntimeWithCore } from '../support/core-memory-options.ts'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { WorldStore } from '@perspectra/core/store'
import { sweetWithoutPacing } from '../support/sweet-without-pacing.ts'
import {
  LensSimulation,
  matchAction,
  sweepStaleLensCopies,
  type LensStart,
} from '../../apps/host/src/lens/simulation.ts'
import { applyScenario, parseScenario } from '../../apps/host/src/lens/scenario.ts'
import { startStubModel } from '../support/stub-model.ts'
import type { HostAction, HostState } from '../../apps/host/src/runtime/http-server.ts'

const PACK = sweetWithoutPacing()
const PLAYER = 'character:player',
  DEEPSEEK = 'character:deepseek'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function open(packPath: string, start?: LensStart) {
  const simulation = await LensSimulation.open(packPath, start)
  cleanups.push(() => simulation.close())
  return simulation
}
function tempDir(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  return root
}
const kitchenStart = (slot: string): LensStart => ({
  status: { public: { slot } },
  scenes: { [PLAYER]: 'scene:living-room', [DEEPSEEK]: 'scene:kitchen' },
  skipAutoStart: ['prologue'],
})
function moveTo(state: HostState, locationId: string): HostAction {
  const offered = (state.availableActions ?? []).some(
    a => a.actionType === 'move' && (a.destinations ?? []).some(d => d.locationId === locationId),
  )
  if (!offered) throw new Error('move to ' + locationId + ' is not offered')
  return { actionType: 'move', parameters: { locationId } }
}
function mtimes(root: string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name)
      result[path] = statSync(path).mtimeMs
    }
  return result
}

it('midnight kitchen starts the fridge event', async () => {
  const lens = await open(PACK, kitchenStart('深夜'))
  const trace = await lens.step({ kind: 'action', action: moveTo(await lens.state(), 'location:kitchen') })
  expect(trace.error).toBeUndefined()
  expect(trace.autoStart.find(e => e.activityKey === 'midnight-fridge')?.started).toBe(true)
  expect(trace.lines.some(line => line.kind === 'activity')).toBe(true)
  expect(trace.lines.find(line => line.kind === 'activity')?.activityKey).toBe('midnight-fridge')
  expect(trace.lines.some(line => line.kind === 'moved' && line.text.includes('厨房'))).toBe(true)
}, 60_000)

it('a step that commits nothing does not repeat the previous start', async () => {
  const lens = await open(PACK, kitchenStart('深夜'))
  const result = await applyScenario(lens, {
    title: '启动后误操作',
    steps: [
      { move: 'location:kitchen', expect: { started: 'midnight-fridge' } },
      { activity: 'midnight-fridge', operation: 'no-such-operation', expect: { notStarted: 'midnight-fridge' } },
    ],
  })
  const [started, rejected] = result.steps
  expect(started!.autoStart.find(e => e.activityKey === 'midnight-fridge')?.started).toBe(true)
  expect(rejected!.error).toBeTruthy()
  expect(rejected!.lines.filter(line => line.kind !== 'input')).toEqual([])
  expect(rejected!.autoStart).toEqual([])
  expect(result.steps.flatMap(step => step.expectations ?? []).every(e => e.ok)).toBe(true)
}, 60_000)

it('daytime kitchen explains the failed condition', async () => {
  const lens = await open(PACK, kitchenStart('上午'))
  const trace = await lens.step({ kind: 'action', action: moveTo(await lens.state(), 'location:kitchen') })
  const fridge = trace.autoStart.find(e => e.activityKey === 'midnight-fridge')!
  expect(fridge.started).toBe(false)
  expect(fridge.checks).toContainEqual({ label: '时段是深夜', met: false })
}, 60_000)

it('round hook shows in the trace', async () => {
  const lens = await open(PACK, { skipAutoStart: ['prologue'] })
  const trace = await lens.step({ kind: 'wait' })
  expect(trace.error).toBeUndefined()
  // Sweet days has no onRoundEnd; a pause round still commits its round record without changes.
  expect(trace.lines.filter(line => line.kind === 'round-hook').map(line => line.text)).toEqual(['回合结束：无变化'])
}, 60_000)

it('npc plan is consumed then abstains', async () => {
  const lens = await open(PACK, { skipAutoStart: ['prologue'] })
  lens.setNpcPlans({ [DEEPSEEK]: [{ kind: 'say', text: '测试台词' }] })
  const chances: boolean[] = []
  for (let i = 0; i < 6 && chances.length < 2; i++) {
    const trace = await lens.step({ kind: 'say', text: '大家好，DeepSeek 你在吗？' })
    expect(trace.error).toBeUndefined()
    if (trace.activated.includes(DEEPSEEK))
      chances.push(trace.lines.some(line => line.kind === 'speech' && line.text.includes('测试台词')))
  }
  expect(chances).toEqual([true, false])
}, 120_000)

// Walkthrough 2026-11-07: [take, eat] in one round ran take, then eat vanished without a trace, because the follow-up
// after her own action may only speak; the scenario still exited 0 with a failed expectation.
it('an npc action planned for the follow-up waits for her next chance and says so', async () => {
  const lens = await open(PACK, { skipAutoStart: ['prologue'] })
  // One activation allows at most two controlled actions, so the third move must wait for another activation.
  lens.setNpcPlans({
    [DEEPSEEK]: [
      { kind: 'perform', move: 'location:kitchen' },
      { kind: 'perform', move: 'location:living-room' },
      { kind: 'perform', move: 'location:kitchen' },
    ],
  })
  const movesPerStep: number[] = []
  let deferred = false
  for (let i = 0; i < 8 && movesPerStep.reduce((a, b) => a + b, 0) < 3; i++) {
    const trace = await lens.step({ kind: 'say', text: '大家好，DeepSeek 你在吗？' })
    expect(trace.error).toBeUndefined()
    movesPerStep.push(trace.lines.filter(line => line.kind === 'moved' && line.actorId === DEEPSEEK).length)
    if (trace.lines.some(line => line.kind === 'plan' && line.actorId === DEEPSEEK && line.text.includes('跟进机会')))
      deferred = true
  }
  expect(deferred).toBe(true)
  expect(movesPerStep.filter(count => count > 0)).toEqual([2, 1])
  expect(lens.leftoverPlans()).toEqual({})
}, 180_000)

it('an npc plan that is not offered leaves a plan line instead of vanishing', async () => {
  const lens = await open(PACK, { skipAutoStart: ['prologue'] })
  lens.setNpcPlans({ [DEEPSEEK]: [{ kind: 'perform', interact: 'status:no-such-thing' }] })
  let note: string | undefined
  for (let i = 0; i < 6 && note === undefined; i++)
    note = (await lens.step({ kind: 'say', text: '大家好，DeepSeek 你在吗？' })).lines.find(
      line => line.kind === 'plan' && line.actorId === DEEPSEEK,
    )?.text
  expect(note).toContain('找不到交互 status:no-such-thing')
  expect(lens.leftoverPlans()).toEqual({})
}, 120_000)

// Walkthrough 2026-11-07: the simulation showed the cake was eaten but not who saw it, which is the game.
it('each step lists what reached each character, and knows checks her whole view', async () => {
  const lens = await open(PACK, { skipAutoStart: ['prologue'] })
  const result = await applyScenario(lens, {
    title: '谁听见了',
    steps: [
      { say: '大家好，今晚吃火锅' },
      { move: 'location:kitchen' },
      {
        wait: true,
        expect: {
          knows: { [DEEPSEEK]: '今晚吃火锅', [PLAYER]: ['今晚吃火锅', '来到 厨房'] },
          doesNotKnow: { [DEEPSEEK]: '不存在的一句话' },
        },
      },
    ],
  })
  const [said, moved] = result.steps
  // Everyone in the living room heard the player; each character's list comes from her own authorized view.
  expect(said!.perceived[PLAYER]).toContain('玩家 说：大家好，今晚吃火锅')
  expect(said!.perceived[DEEPSEEK]).toContain('玩家 说：大家好，今晚吃火锅')
  // Those left behind see the player leave; only the player sees where she went.
  expect(moved!.perceived[DEEPSEEK]).toContain('玩家 离开了 客厅')
  expect(moved!.perceived[PLAYER]).toContain('玩家 从 客厅 来到 厨房')
  expect(result.steps[2]!.expectations!.every(e => e.ok)).toBe(true)
  expect(result.passed).toBe(true)
}, 120_000)

it('knows fails for a character who never saw it', async () => {
  const lens = await open(PACK, kitchenStart('白天'))
  // The player is in the living room; DeepSeek is in the kitchen and does not hear it.
  const result = await applyScenario(lens, {
    title: '隔墙',
    steps: [
      { say: '我偷偷告诉你一个秘密', expect: { knows: { [DEEPSEEK]: '秘密' }, doesNotKnow: { [PLAYER]: '秘密' } } },
    ],
  })
  expect(result.steps[0]!.expectations).toEqual([
    { text: `${DEEPSEEK} 知道“秘密”`, ok: false },
    { text: `${PLAYER} 不知道“秘密”`, ok: false },
  ])
  expect(result.passed).toBe(false)
}, 120_000)

it('npc perform plans take the short forms player steps use, one form at a time', () => {
  const scenario = (plan: unknown) => ({ title: 't', npcPlans: { [DEEPSEEK]: [plan] }, steps: [{ wait: true }] })
  expect(() => parseScenario(scenario({ kind: 'perform', interact: 'status:take', target: 'entity:x' }))).not.toThrow()
  expect(() => parseScenario(scenario({ kind: 'perform', move: 'location:kitchen' }))).not.toThrow()
  expect(() => parseScenario(scenario({ kind: 'perform', move: 'location:a', interact: 'status:take' }))).toThrow(
    '恰好写明一种行动',
  )
  expect(() => parseScenario(scenario({ kind: 'perform', move: 'location:a', target: 'entity:x' }))).toThrow(
    '不认识的字段',
  )
})

it('arguments a plan writes are added to the ones the offer carries, so an activity operation keeps its round', () => {
  // An activity option carries which round it belongs to; a host plan only says what she chose.
  const offered = [
    {
      actionType: 'interact',
      interactions: [
        {
          bindingId: 'activity:a',
          definitionRef: { id: 'activity:respond', version: 1 },
          targetRef: { kind: 'character', id: DEEPSEEK },
          arguments: { activityId: 'activity:a', revision: 3 },
        },
      ],
    },
  ] as never
  expect(matchAction({ interact: 'activity:respond', arguments: { accept: true } }, offered).parameters).toMatchObject({
    arguments: { activityId: 'activity:a', revision: 3, accept: true },
  })
})

it('a scenario with a failed expectation or unused plans does not pass', async () => {
  const lens = await open(PACK, { skipAutoStart: ['prologue'] })
  const result = await applyScenario(lens, {
    title: '期望落空',
    npcPlans: { [DEEPSEEK]: [{ kind: 'abstain' }, { kind: 'abstain' }, { kind: 'abstain' }, { kind: 'abstain' }] },
    steps: [{ wait: true, expect: { status: { slot: '不存在的时段' } } }],
  })
  expect(result.passed).toBe(false)
  expect(result.unusedNpcPlans?.[DEEPSEEK]).toBeGreaterThan(0)
  const ok = await applyScenario(await open(PACK, { skipAutoStart: ['prologue'] }), {
    title: '无期望',
    steps: [{ wait: true }],
  })
  expect(ok.passed).toBe(true)
}, 120_000)

it('npc options follow the real status policy and autonomy whitelist', async () => {
  const cooks = (lens: LensSimulation) =>
    lens.npcOptions()[DEEPSEEK]!.filter(option => option.definitionId === 'status:cook-simple')
  // The policy offers cook-simple only with the kitchen pot at hand; at the opening she is in the living room.
  const opening = await open(PACK, { skipAutoStart: ['prologue'] })
  expect(cooks(opening)).toEqual([])
  const kitchen = await open(PACK, kitchenStart('白天'))
  const offered = cooks(kitchen)
  expect(offered).toHaveLength(1)
  expect(offered[0]!.label).toBe('做一锅热乎的黄金蛋炒饭')
  expect(offered[0]!.targetId).toBe('entity:kitchen-pot')
  // Brewing tea is not on her autonomy whitelist, so it is never offered to her own turn.
  expect(kitchen.npcOptions()[DEEPSEEK]!.some(option => option.definitionId === 'status:brew-shared-tea')).toBe(false)
  // The action is shaped for a perform plan: the same refs the runtime offered.
  expect(offered[0]!.action).toMatchObject({
    actionType: 'interact',
    parameters: { definitionRef: { id: 'status:cook-simple' }, targetRef: { id: 'entity:kitchen-pot' } },
  })
}, 120_000)

it('skipAutoStart names a single-activity pack by its default key', async () => {
  const pack = join(tempDir('lens-default-'), 'pack')
  cpSync(resolve('examples/world-packs/launcher-demo'), pack, { recursive: true })
  writeFileSync(
    join(pack, 'scripts/activity.js'),
    readFileSync(join(pack, 'scripts/activity.js'), 'utf8') +
      "\nactivityScript.autoStart = () => ({ when: [['总是', true]] });\n",
  )
  const plain = await open(pack)
  expect(plain.conditionsNow().map(e => e.activityKey)).toEqual(['default'])
  const skipped = await open(pack, { skipAutoStart: ['default'] })
  expect(skipped.conditionsNow()).toEqual([])
}, 60_000)

it('sweeps temporary copies older than a day left by a killed Launcher', () => {
  const root = tempDir('lens-sweep-')
  const old = join(root, 'perspectra-lens-old'),
    fresh = join(root, 'perspectra-lens-fresh'),
    other = join(root, 'someone-else')
  for (const dir of [old, fresh, other]) {
    mkdirSync(join(dir, 'pack'), { recursive: true })
    writeFileSync(join(dir, 'pack', 'file.txt'), 'x')
  }
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000)
  utimesSync(old, twoDaysAgo, twoDaysAgo)
  utimesSync(other, twoDaysAgo, twoDaysAgo)
  sweepStaleLensCopies(root)
  expect(existsSync(old)).toBe(false)
  expect(existsSync(fresh)).toBe(true)
  expect(existsSync(other)).toBe(true)
  expect(() => sweepStaleLensCopies(join(root, 'missing'))).not.toThrow()
})

it('does not touch the pack or data', async () => {
  const before = mtimes(PACK)
  // An author may already have lens files here; a simulation neither adds nor changes them.
  const lensFiles = existsSync(join(PACK, '.perspectra-lens'))
  const lens = await LensSimulation.open(PACK, kitchenStart('深夜'))
  const directories = readdirSync(tmpdir()).filter(name => name.startsWith('perspectra-lens-'))
  await lens.step({ kind: 'action', action: moveTo(await lens.state(), 'location:kitchen') })
  await lens.close()
  expect(mtimes(PACK)).toEqual(before)
  const after = readdirSync(tmpdir()).filter(name => name.startsWith('perspectra-lens-'))
  // The session's own temporary directory is gone; others may belong to concurrent tests.
  expect(directories.filter(name => !after.includes(name)).length).toBeGreaterThanOrEqual(1)
  expect(existsSync(join(PACK, '.perspectra-lens'))).toBe(lensFiles)
}, 60_000)

// Walkthrough 2026-11-07: a temp folder the program could not write showed only "unable to open database file".
it('a temp folder it cannot use is named in the error', async () => {
  const blocker = join(tempDir('lens-no-temp-'), 'a-file')
  writeFileSync(blocker, '')
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
  const unusable = join(blocker, 'temp')
  Object.assign(process.env, { TEMP: unusable, TMP: unusable, TMPDIR: unusable })
  try {
    await expect(LensSimulation.open(PACK)).rejects.toThrow(unusable)
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
  }
})

it('rejects unknown start references', async () => {
  await expect(LensSimulation.open(PACK, { scenes: { 'character:nobody': 'scene:kitchen' } })).rejects.toThrow(
    'character:nobody',
  )
  await expect(LensSimulation.open(PACK, { scenes: { [DEEPSEEK]: 'scene:nowhere' } })).rejects.toThrow('scene:nowhere')
  await expect(LensSimulation.open(PACK, { status: { public: { nokey: 1 } } })).rejects.toMatchObject({
    name: 'PluginFault',
    pluginId: 'official-status',
    operation: 'open',
  })
  await expect(LensSimulation.open(PACK, { skipAutoStart: ['no-such-activity'] })).rejects.toThrow('no-such-activity')
}, 60_000)

it('step with a throwing autoStart reports the error in the trace', async () => {
  const pack = join(tempDir('lens-broken-'), 'pack')
  cpSync(PACK, pack, { recursive: true })
  const script = join(pack, 'scripts/activities/midnight-fridge.js')
  writeFileSync(
    script,
    readFileSync(script, 'utf8').replace(
      'autoStart(truth, world, previous) {',
      'autoStart(truth, world, previous) {\n    throw new TypeError("冰箱坏了")',
    ),
  )
  const lens = await LensSimulation.open(pack, kitchenStart('深夜'))
  const trace = await lens.step({ kind: 'action', action: moveTo(await lens.state(), 'location:kitchen') })
  const fridge = trace.autoStart.find(e => e.activityKey === 'midnight-fridge')
  // The runtime reports script failures without the author's message.
  expect(trace.error ?? fridge?.error).toBeTruthy()
  await lens.close()
}, 60_000)

it('matches a plain host runtime', async () => {
  const start = kitchenStart('深夜')
  const lens = await open(PACK, start)
  const lensTrace = await lens.step({ kind: 'action', action: moveTo(await lens.state(), 'location:kitchen') })
  expect(lensTrace.error).toBeUndefined()

  // The same start written by hand into a pack copy, played by an ordinary host runtime.
  const root = tempDir('lens-plain-'),
    pack = join(root, 'pack')
  cpSync(PACK, pack, { recursive: true })
  const scenesFile = join(pack, 'scenes.json')
  const scenes = JSON.parse(readFileSync(scenesFile, 'utf8')) as {
    scenes: { sceneId: string; participantIds: string[] }[]
  }
  for (const scene of scenes.scenes) {
    scene.participantIds =
      scene.sceneId === 'scene:kitchen' ? [DEEPSEEK] : scene.participantIds.filter(id => id !== DEEPSEEK)
  }
  writeFileSync(scenesFile, JSON.stringify(scenes))
  const charactersFile = join(pack, 'characters.json')
  const characters = JSON.parse(readFileSync(charactersFile, 'utf8')) as {
    characters: { characterId: string; initialLocationId?: string }[]
  }
  for (const character of characters.characters)
    if (character.characterId === DEEPSEEK) character.initialLocationId = 'location:kitchen'
  writeFileSync(charactersFile, JSON.stringify(characters))
  const prologue = join(pack, 'scripts/activities/prologue.js')
  writeFileSync(prologue, readFileSync(prologue, 'utf8') + '\nglobalThis.activityScript.autoStart = undefined\n')
  const stub = await startStubModel()
  cleanups.push(() => stub.close())
  const runtime = await createRuntimeWithCore({
    packPath: pack,
    dataDirectory: join(root, 'data'),
    models: stub.models,
    memoryCore: false,
    timeoutMs: 10_000,
  })
  cleanups.push(() => runtime.close())
  await runtime.perform(moveTo(await runtime.state(), 'location:kitchen'))

  expect(await lens.statusTruth()).toEqual(runtime.creatorInspection({ limit: 1 }).statusTruth)
  const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
  let plainKeys: unknown[]
  try {
    plainKeys = store
      .readEvents(runtime.address)
      .filter(e => e.eventType === 'activity.updated')
      .map(e => (e.data as WorldJsonObject).activityKey)
  } finally {
    store.close()
  }
  expect(plainKeys).toContain('midnight-fridge')
  const lensActivity = lensTrace.lines.filter(line => line.kind === 'activity')
  expect(lensActivity).toHaveLength(plainKeys.length)
  lensActivity.forEach((line, index) => expect(line.text).toContain(String(plainKeys[index])))
}, 120_000)

it('B9 searches through committed facts, authorized requests, duplicate cost and structured exhaustion', async () => {
  const lens = await open(resolve('examples/world-packs/investigation'))
  const scenario = parseScenario(
    JSON.parse(readFileSync(resolve('examples/world-packs/investigation/scenario.json'), 'utf8')),
  )
  const result = await applyScenario(lens, scenario)
  expect(result.passed, JSON.stringify(result.steps.map(step => step.expectations))).toBe(true)
  const changes = lens
    .events()
    .filter(event => event.eventType === 'status.updated')
    .map(event => (event.data as any).changes)
  // The same committed event carries the resource debit and the private clue.
  expect(changes).toContainEqual(
    expect.arrayContaining([
      { holderId: PLAYER, key: 'energy', value: 1 },
      { holderId: PLAYER, key: 'clues', value: ['clue:letter'] },
    ]),
  )
  expect(lens.modelInputs().some(entry => entry.characterId === 'character:aru')).toBe(false)
  const later = await applyScenario(lens, {
    title: '房外隔离',
    steps: [
      { move: 'location:bedroom', expect: { contextExcludes: { 'character:aru': ['clue:letter', '在房间里翻找'] } } },
    ],
  })
  expect(later.passed, JSON.stringify(later.steps)).toBe(true)
  expect(lens.timings.executionMs).toBeGreaterThan(0)
})

it('B9 assertions fail when a context was never delivered, and fault expectations check actual rollback', async () => {
  const root = tempDir('lens-b9-fault-'),
    pack = join(root, 'pack')
  cpSync(resolve('examples/world-packs/investigation'), pack, { recursive: true })
  const script = join(pack, 'scripts/gameplay.cjs')
  writeFileSync(
    script,
    readFileSync(script, 'utf8').replace(
      'resolve: ({ actorId, state }) => {',
      "resolve: ({ actorId, state }) => { throw new TypeError('PRIVATE_INTERNAL');",
    ),
  )
  const lens = await open(pack)
  const before = await lens.statusTruth()
  const result = await applyScenario(lens, {
    title: '真实故障',
    steps: [
      {
        interact: 'investigation:search',
        expect: {
          fault: { pluginId: 'example-investigation', operation: 'resolve:investigation:search', invalidResult: false },
          status: { 'character:player.energy': 2, 'character:player.clues': [] },
        },
      },
    ],
  })
  expect(result.passed, JSON.stringify(result.steps)).toBe(true)
  expect(await lens.statusTruth()).toEqual(before)
  expect(result.steps[0]!.resolutions).toEqual([])
  expect(result.steps[0]!.error).not.toContain('PRIVATE_INTERNAL')
  const noRequest = await applyScenario(lens, {
    title: '没有请求不能证明隔离',
    steps: [
      {
        interact: 'investigation:search',
        expect: { error: 'example-investigation', contextExcludes: { 'character:aru': 'secret' } },
      },
    ],
  })
  expect(noRequest.passed).toBe(false)
})

it('B9 native and script definitions produce equal committed state and authorized delivery', async () => {
  const root = tempDir('lens-b9-native-'),
    pack = join(root, 'pack')
  cpSync(resolve('examples/world-packs/investigation'), pack, { recursive: true })
  const file = join(pack, 'worldpack.source.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  delete manifest.scripts
  manifest.plugins = { 'example-investigation': { config: 'investigation.json' } }
  manifest.assetFiles = ['investigation.json']
  delete manifest.scripts
  writeFileSync(file, JSON.stringify(manifest))
  writeFileSync(join(pack, 'investigation.json'), JSON.stringify({ energy: 2 }))
  const definition = createRequire(import.meta.url)(resolve('examples/gameplay/investigation.cjs')) as ContentGameplay
  const native = await LensSimulation.open(
    pack,
    {},
    assembleRoleplay({
      content: [
        {
          id: definition.id,
          version: definition.version,
          dataVersion: definition.dataVersion,
          configFile: 'investigation.json',
          generate: () => ({ gameplay: [definition] }),
        },
      ],
    }),
  )
  cleanups.push(() => native.close())
  const scripted = await open(resolve('examples/world-packs/investigation'))
  for (let attempt = 0; attempt < 3; attempt++) {
    const traces: Awaited<ReturnType<LensSimulation['step']>>[] = []
    for (const sim of [native, scripted])
      traces.push(
        await sim.step({
          kind: 'action',
          action: matchAction({ interact: 'investigation:search' }, (await sim.state()).availableActions ?? []),
        }),
      )
    expect(traces.map(trace => trace.error)).toEqual([undefined, undefined])
    expect(await native.statusTruth()).toEqual(await scripted.statusTruth())
    // Independent worlds have different action IDs; keep all actual observation content.
    const observations = (trace: (typeof traces)[number]) =>
      JSON.stringify(trace.perceived).replace(/action:[a-f0-9]+/gu, 'action:<id>')
    expect(observations(traces[0]!)).toEqual(observations(traces[1]!))
    expect(traces[0]!.gameplay).toEqual(traces[1]!.gameplay)
    expect(traces[0]!.resolutions?.map(r => [r.accepted, r.rejection])).toEqual(
      traces[1]!.resolutions?.map(r => [r.accepted, r.rejection]),
    )
  }
})

it('B9 parses structured fault assertions and rejects malformed assertion fields', () => {
  const fault = { pluginId: 'example-investigation', operation: 'resolve:investigation:search', invalidResult: false }
  expect(
    parseScenario({ title: '故障', steps: [{ interact: 'investigation:search', expect: { fault } }] }).steps[0]!.expect!
      .fault,
  ).toEqual(fault)
  expect(() =>
    parseScenario({ title: '故障', steps: [{ wait: true, expect: { fault: { ...fault, invalidResult: 'no' } } }] }),
  ).toThrow('invalidResult')
  expect(() => parseScenario({ title: '面板', steps: [{ wait: true, expect: { panelsContain: [] } }] })).toThrow(
    '至少一句',
  )
})

it('B9 NPC plans use authorized operation instructions and receive their own private formal result', async () => {
  const lens = await open(resolve('examples/world-packs/investigation'))
  lens.setNpcPlans({ 'character:cheng': [{ kind: 'perform', interact: 'investigation:search' }] })
  const trace = await lens.step({ kind: 'say', text: '澄，请看看房间。' })
  expect(trace.error).toBeUndefined()
  expect(await lens.statusTruth()).toMatchObject({
    characters: { 'character:cheng': { energy: 1, clues: ['clue:letter'] }, [PLAYER]: { energy: 2, clues: [] } },
  })
  const requests = lens.modelInputs().filter(entry => entry.characterId === 'character:cheng')
  const offers = (requests[0]!.input.context as any).affordances.flatMap((entry: any) => entry.interactions ?? [])
  expect(offers.filter((offer: any) => offer.definitionRef.id === 'investigation:search')).toHaveLength(1)
  expect(JSON.stringify(requests[0])).toContain('每次消耗 1 点精力')
  expect(JSON.stringify(requests[0])).not.toContain('clue:letter')
  expect(JSON.stringify(requests.slice(1))).toContain('clue:letter')
  expect(JSON.stringify(trace.gameplay)).not.toContain('一封信')
  expect(trace.perceived[PLAYER]!.some(line => line.includes('翻找'))).toBe(true)
  expect(JSON.stringify(trace.perceived[PLAYER])).not.toContain('clue:letter')
  expect(JSON.stringify(trace.perceived['character:aru'])).not.toContain('翻找')
})

it('matching preserves ambiguity between distinct bindings or arguments even on the same target', () => {
  const option = {
    bindingId: 'one',
    definitionRef: { id: 'investigation:search', version: 1 },
    targetRef: { kind: 'location', id: 'location:living-room' },
    arguments: {},
  }
  for (const alternative of [
    { ...option, bindingId: 'two' },
    { ...option, arguments: { mode: 'other' } },
  ])
    expect(() =>
      matchAction({ interact: 'investigation:search', target: 'location:living-room' }, [
        { actionType: 'interact', interactions: [option, alternative] },
      ]),
    ).toThrow('多个目标')
})
