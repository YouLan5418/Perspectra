import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { CharacterViewBuilder, WorldStore } from '@perspectra/core/store'
import { environmentRoleModels } from '../../apps/host/src/model-connections.ts'
import { WorldHostRuntime } from '../../apps/host/src/runtime/world-runtime.ts'
import { WAIT_ACTION, type HostAction, type HostState } from '../../apps/host/src/runtime/http-server.ts'

// Real-model play of hill-ruins through the default frontend's paths: speech via submit, buttons via perform.
// Usage: node --import tsx tests/experiments/hill-ruins-live.ts [outputDir] [--model=opencode-go/glm-5.3-flash]
const model = process.argv.find(arg => arg.startsWith('--model='))?.slice(8) ?? 'opencode-go/glm-5.3-flash'
const output = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'output/hill-ruins-live-' + Date.now())
mkdirSync(output, { recursive: true })
const dataDirectory = join(output, 'world')
const PLAYER = 'character:player',
  CHENG = 'character:cheng',
  ARU = 'character:aru'

const runtime = await WorldHostRuntime.create({
  packPath: resolve('examples/world-packs/hill-ruins'),
  dataDirectory,
  models: environmentRoleModels({
    PERSPECTRA_MODEL_ENDPOINT: 'http://127.0.0.1:3495/v1/chat/completions',
    PERSPECTRA_MODEL: model,
  }),
  timeoutMs: 120_000,
})

const log: { step: string; ok: boolean; error?: string; lines: string[]; scene?: string | undefined; status?: string }[] =
  []
let seen = 0
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))
async function settled(): Promise<HostState> {
  for (let i = 0; i < 240; i++) {
    const state = await runtime.state()
    if (!state.busy) return state
    await delay(500)
  }
  return runtime.state()
}
function newLines(state: HostState): string[] {
  const lines = state.transcript
    .filter(line => line.seq > seen)
    .map(line => `${line.speaker}：${line.segments ? line.segments.map(s => (s.type === 'narration' ? `（${s.text}）` : s.text)).join('') : line.text}`)
  seen = state.transcript.at(-1)?.seq ?? seen
  return lines
}
const truth = () => runtime.creatorInspection({ limit: 1 }).statusTruth as WorldJsonObject
const party = () => ((truth().public as WorldJsonObject)['rpg-party'] as string[] | undefined) ?? []
const hp = (id: string) => ((truth().characters as Record<string, WorldJsonObject>)[id] ?? {})['rpg-hp']
async function step(name: string, run: () => Promise<unknown>) {
  let ok = true,
    error: string | undefined
  try {
    await run()
  } catch (cause) {
    ok = false
    error = cause instanceof Error ? cause.message : String(cause)
  }
  const state = await settled()
  const entry = {
    step: name,
    ok,
    ...(error ? { error } : {}),
    lines: newLines(state),
    scene: state.world.currentScene?.locationName,
    status: (state.statusBar ?? []).map(s => `${s.holderName ?? s.holderId}·${s.label}=${JSON.stringify(s.value)}${s.current ? '' : '(旧)'}`).join('；'),
  }
  log.push(entry)
  console.log(`\n== ${name}${ok ? '' : ' ✘ ' + error}\n  场景：${entry.scene}\n  状态：${entry.status}`)
  for (const line of entry.lines) console.log('  ' + line)
  writeFileSync(join(output, 'log.json'), JSON.stringify(log, null, 2))
}
const say = (text: string) => step('说：' + text, () => runtime.submit(text))
const move = (locationId: string) =>
  step('移动到 ' + locationId, () => runtime.perform({ actionType: 'move', parameters: { locationId } }))
function option(state: HostState, definitionId: string, targetId?: string): WorldJsonObject | undefined {
  return (state.availableActions ?? [])
    .filter(a => a.actionType === 'interact')
    .flatMap(a => a.interactions ?? [])
    .find(
      o =>
        (o.definitionRef as WorldJsonObject).id === definitionId &&
        (targetId === undefined || (o.targetRef as WorldJsonObject | undefined)?.id === targetId),
    )
}
async function interact(name: string, definitionId: string, extra: WorldJsonObject = {}, targetId?: string) {
  const found = option(await settled(), definitionId, targetId)
  if (!found) {
    log.push({ step: name, ok: false, error: '未提供：' + definitionId, lines: [] })
    console.log(`\n== ${name} ✘ 未提供 ${definitionId}`)
    return false
  }
  const action: HostAction = {
    actionType: 'interact',
    parameters: {
      targetRef: found.targetRef!,
      bindingId: found.bindingId!,
      definitionRef: found.definitionRef!,
      arguments: { ...((found.arguments as WorldJsonObject | undefined) ?? {}), ...extra },
    },
  }
  await step(name, () => runtime.perform(action))
  return true
}

try {
  await step('开场', async () => undefined)
  for (const line of [
    '澄，屋后山上的遗迹好像有人在守着，我想去看看，你愿意陪我一起去吗？',
    '那就说定了，你跟我一队吧。',
    '准备好了就出发？',
  ]) {
    if (party().includes(CHENG)) break
    await say(line)
  }
  console.log('\n队伍：', party())
  await move('location:ruin-1')
  // The battle is running while its skill option is offered; wait a few rounds when it is someone else's turn.
  for (let turn = 0, idle = 0; turn < 16 && idle < 3; turn++) {
    const state = await settled()
    if (!option(state, 'activity:skill')) {
      if (!(state.activities ?? []).some(a => (a.game as WorldJsonObject | undefined)?.active === true)) break
      idle++
      await step('静观（等她行动）', () => runtime.perform(WAIT_ACTION))
      continue
    }
    idle = 0
    const mp = ((truth().characters as Record<string, WorldJsonObject>)[PLAYER] ?? {})['rpg-mp'] as number
    const skill = mp >= 3 ? '火球术' : '普通攻击'
    await interact(`战斗：${skill}`, 'activity:skill', { skill, target: '遗迹守卫' })
  }
  console.log('\n活动：', JSON.stringify((await settled()).activities).slice(0, 400))
  await say('澄，你还好吗？刚才那一下好险。')
  await interact('拿起铁钥匙', 'status:take', {}, 'entity:iron-key')
  // Whoever holds the key (she may have picked it up first) unlocks the door; ask her if it isn't the player.
  if (!(await interact('用铁钥匙开锁', 'status:rpg-unlock', {}, 'entity:iron-key')))
    await say('澄，钥匙在你那儿吧？帮忙把铁门打开。')
  await move('location:ruin-2')
  await say('第二层好安静啊。')
  await interact('拿起药水', 'status:take', {}, 'entity:potion-2')
  await move('location:ruin-1')
  await move('location:living-room')
  await say('阿茹，我们回来了！今天在外面发生了什么你猜得到吗？')
  await move('location:bedroom')
  await interact('睡一觉', 'status:rpg-rest')
} finally {
  // What reached Ah-Ru's own view, as her model sees it.
  const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
  const head = store.head(runtime.address).headSeq
  const events = store.readEvents(runtime.address)
  const aru = new CharacterViewBuilder(store)
    .rebuildFromEvents(runtime.address, ARU as never, head, events)
    .observations.map(record => JSON.stringify((record.value as WorldJsonObject).content))
  store.close()
  const battleWords = ['遗迹守卫', '火球', '倒下', '生命']
  const summary = {
    model,
    party: party(),
    hp: { player: hp(PLAYER), cheng: hp(CHENG) },
    aruObservations: aru.length,
    aruBattleMentions: aru.filter(text => battleWords.some(word => text.includes(word))),
    failedSteps: log.filter(entry => !entry.ok).map(entry => `${entry.step}：${entry.error}`),
  }
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log('\n== 总结\n' + JSON.stringify(summary, null, 2))
  await runtime.close()
}
