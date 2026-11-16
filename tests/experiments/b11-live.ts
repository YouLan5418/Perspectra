/**
 * B11 real-model acceptance. Fresh synthetic worlds only; never reads saved player sessions.
 * node --import tsx tests/experiments/b11-live.ts [rpg|rpg-autonomous|rpg-rain|smoke]
 * Evidence includes these synthetic authorized prompts; credentials/headers are never captured.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorldStore } from '@perspectra/core/store'
import { WorldHostRuntime } from '../../apps/host/src/runtime/world-runtime.ts'
import { environmentRoleModels } from '../../apps/host/src/model-connections.ts'
import { playSettings } from '../../apps/host/src/play-settings.ts'
import { projectPlayerView, FrontendActions } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { addRpgValuesExample } from '../support/rpg-values-fixture.ts'
import { addRpgEffectsExample } from '../support/rpg-effects-fixture.ts'

type Json = Record<string, any>
const suite = process.argv[2] ?? 'rpg'
const root = resolve('.tmp/composable-engine/b11', 'live-' + suite + '-' + Date.now())
mkdirSync(root, { recursive: true })
const model = 'opencode-go/deepseek-v4.1-flash'
const endpoint = 'http://127.0.0.1:8025/v1/chat/completions'
let calls = 0
let scenario = ''
const pending: Promise<void>[] = []
const wire = join(root, 'wire.jsonl')
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url !== endpoint) throw new Error('Live acceptance only permits its explicitly configured gateway')
  if (++calls > 64) throw new Error('B11 real model send limit reached')
  const call = calls, currentScenario = scenario
  const body = JSON.parse(String(init?.body))
  appendFileSync(wire, JSON.stringify({ phase: 'request', call, scenario: currentScenario, body }) + '\n')
  console.log(JSON.stringify({ phase: 'send', call, scenario: currentScenario, model: body.model }))
  const started = performance.now()
  const response = await originalFetch(input, init)
  pending.push((async () => {
    let text = '', captureError: string | undefined
    const reader = response.clone().body?.getReader(), decoder = new TextDecoder()
    try {
      if (reader) while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
    } catch (error) { captureError = String(error) }
    appendFileSync(wire, JSON.stringify({phase:'response',call,scenario:currentScenario,status:response.status,ms:performance.now()-started,text,captureError}) + String.fromCharCode(10))
  })())
  return response
}
const models = environmentRoleModels({ PERSPECTRA_MODEL_ENDPOINT: endpoint, PERSPECTRA_MODEL: model })
const settings = playSettings({
  publicationCharacters: 600, modelTimeoutSeconds: 90, activationTimeoutSeconds: 180,
  maximumWaves: 2, maximumNpcCalls: 6, maximumCallsPerCharacter: 1,
  reactionDeadlineSeconds: 180, activityOpportunities: 2, activityDeadlineSeconds: 180,
  autonomyOpportunities: 0, autonomyNpcCalls: 2, autonomyReactionCalls: 2,
})
const summaries: Json[] = []
const save = () => writeFileSync(join(root, 'summary.json'), JSON.stringify({ model, endpoint, calls, scenarios: summaries }, null, 2))
const read = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'))
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
function events(runtime: WorldHostRuntime) {
  const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
  try { return store.readEvents(runtime.address) } finally { store.close() }
}
function snapshot(runtime: WorldHostRuntime) {
  const rows = events(runtime)
  const battle = rows.findLast(e => e.eventType === 'activity.updated' && (e.data as Json).activityKey.startsWith('rpg-map-'))
  const game = (battle?.data as Json)?.state?.game
  return { seq: rows.at(-1)?.seq, game }
}
async function step(runtime: WorldHostRuntime, label: string, run: () => Promise<unknown>, result: Json) {
  const before = snapshot(runtime), previousCalls = calls, started = performance.now()
  try {
    await run()
    const after = snapshot(runtime), state = await runtime.state()
    const rows = events(runtime).filter(e => e.seq > (before.seq ?? 0))
    const item = { label, ms: performance.now() - started, calls: calls - previousCalls, before, after,
      error: (state as Json).error,
      events: rows.filter(e => ['action.resolved', 'character.speak', 'character.expressed', 'activity.updated'].includes(e.eventType)),
      lines: (state as Json).lines, records: runtime.creatorRecords() }
    result.steps.push(item)
    console.log(JSON.stringify({ phase:'step', scenario, label, calls: item.calls, turn: after.game?.turn, lastResult: after.game?.public?.lastResult, error: item.error }))
  } catch (error) {
    result.steps.push({ label, error: error instanceof Error ? error.message : String(error) })
    console.log(JSON.stringify({ phase:'stepError', scenario, label, error: String(error) }))
  }
  save()
}
async function runRpg(kind: 'values' | 'effects') {
  scenario = 'rpg-' + kind
  const dir = join(root, scenario), pack = join(dir, 'pack')
  cpSync(resolve('tests/fixtures/rpg-pack'), pack, { recursive: true })
  const config = read(join(pack, 'rpg.json'))
  const companion = structuredClone(config.characters['character:cheng'])
  if (kind === 'values') addRpgValuesExample(config)
  else addRpgEffectsExample(config)
  if(suite==='rpg-rain') config.battleValues.shared.rain.initial=0
  config.characters['character:cheng'] = companion
  companion.skills = [...config.characters['character:player'].skills]
  companion.stats = { hp: 80, mp: 40 }
  config.characters['character:player'].stats = { hp: 100, mp: 40 }
  config.enemies.golem.hp = 300
  config.enemies.golem.attack = 1
  config.enemies.golem.strategy = 'lowest-hp'
  write(join(pack, 'rpg.json'), config)
  const characters = read(join(pack, 'characters.json'))
  for (const c of characters.characters) {
    c.initialLocationId = c.characterId === 'character:aru' ? 'location:bedroom' : 'location:ruin-1'
  }
  write(join(pack, 'characters.json'), characters)
  const scenes = read(join(pack, 'scenes.json'))
  for (const scene of scenes.scenes) {
    scene.participantIds = characters.characters.filter((c: Json) => c.initialLocationId === scene.locationId).map((c: Json) => c.characterId)
    scene.lifecycle = scene.participantIds.length ? 'active' : 'created'
  }
  write(join(pack, 'scenes.json'), scenes)
  const runtime = await WorldHostRuntime.create({ packPath: pack, dataDirectory: join(dir, 'world'), models, timeoutMs: 90000, playSettings: settings })
  runtime.requestInspection(true)
  const result: Json = { scenario, steps: [] }; summaries.push(result)
  const speak = (text: string) => runtime.submit('/act speak ' + JSON.stringify({text,scope:'direct',addresseeIds:['character:cheng']}))
  try {
    await step(runtime, 'encounter', () => speak(kind === 'values' ? '澄，我们并肩打这个守卫。观察自己的怒气和对方架势，自己判断怎么打，不要只说不动手。' : '澄，我们一起应战。你来保护和支援我，自己选适合的法术并实际使用。'), result)
    const autonomous = suite === 'rpg-autonomous'
    const prompts = suite==='rpg-rain'
      ? ['现在暴雨为零，先实际使用唤雨，目标是你自己，不要先攻击。','现在暴雨改变后，实际用雨中火球攻击守卫。']
      : autonomous
      ? (kind === 'values'
        ? ['读你自己掌握的能力规则，选择一招先削弱守卫防御再伤害它，不要只描述而不执行。','接下来选能造成火伤并持续灼烧的法术。','接下来考虑改变场上的暴雨数值，再判断后续火伤是否合算。']
        : ['我能撑住，先保护你自己，选择能替你吸收伤害的法术。','接下来让守卫持续受伤，你自己从已学技能里挑选合适的。'])
      : kind === 'values'
      ? ['先用压制削减守卫的架势，怒气够五点再用怒击。', '按现在的怒气和架势继续战斗，选择能实际施放的技能。', '试试唤雨，再根据暴雨的强度判断怎么用雨中火球。', '现在用雨中火球攻击守卫。']
      : ['先给自己施加护盾术。', '对守卫使用侵蚀术，让它持续受伤。', '现在给我施加再生术，维持我们的生命。']
    for (const [i, text] of prompts.entries()) {
      await step(runtime, 'request-' + (i + 1), () => speak(text), result)
      const view = projectPlayerView(await runtime.state())
      const guard = view.actions.find(a => a.label === '防御')
      if (!guard) { result.stop = 'No player guard offered'; break }
      await step(runtime, 'guard-' + (i + 1), () => new FrontendActions(runtime).perform({
        requestId:randomUUID(),actionId:randomUUID(),operation:'perform',payload:{optionId:guard.id},
      }), result)
    }
    const node = await runtime.saveNode('B11 ' + kind + ' live')
    result.savedNode = node.id
    result.final = snapshot(runtime)
  } finally {
    await runtime.close()
    save()
  }
}
async function runSmoke(kind: 'investigation' | 'communication' | 'autonomy' | 'trpg') {
  scenario = kind
  const source = kind === 'investigation' ? 'examples/world-packs/investigation'
    : kind === 'communication' ? 'examples/world-packs/cross-scene-sms'
    : kind === 'autonomy' ? 'examples/world-packs/character-autonomy' : 'tests/fixtures/trpg-pack'
  const dir = join(root, scenario), pack = join(dir, 'pack')
  cpSync(resolve(source), pack, {recursive:true})
  if (kind === 'investigation') {
    const manifest = read(join(pack,'worldpack.source.json'))
    manifest.scripts.gameplay.config.energy = 1
    write(join(pack,'worldpack.source.json'),manifest)
  }
  const runtime = await WorldHostRuntime.create({ packPath:pack, dataDirectory:join(dir,'world'), models,
    timeoutMs:90000, playSettings: kind === 'autonomy' ? playSettings({...settings,autonomyOpportunities:1}) : settings })
  runtime.requestInspection(true)
  const result:Json = {scenario,steps:[]};summaries.push(result)
  try {
    if (kind === 'investigation') {
      for (const [i,text] of [
        '澄，帮我搜查客厅，看有没有线索，动手搜一次就好。',
        '如果精力已经用完，就告诉我，不要声称又找到新线索。你现在还能再搜吗？',
      ].entries()) {
        await step(runtime,'ask-'+i,()=>runtime.submit('/act speak '+JSON.stringify({text,scope:'direct',addresseeIds:['character:cheng']})),result)
      }
      const view=projectPlayerView(await runtime.state()), search=view.actions.find(a=>a.label==='搜查房间')
      if(search) await step(runtime,'player-search',()=>new FrontendActions(runtime).perform({
        requestId:randomUUID(),actionId:randomUUID(),operation:'perform',payload:{optionId:search.id}
      }),result)
    } else if (kind === 'communication') {
      await step(runtime,'private-sms',()=>runtime.submit('/message '+JSON.stringify({
        recipientId:'character:companion',text:'今晚的暗号是蓝色松果。请用短信确认收到，不要向身旁的留守者透露。'
      })),result)
    } else if (kind === 'autonomy') {
      await step(runtime,'system-opportunity',()=>runtime.submit('/act speak '+JSON.stringify({
        text:'我先整理东西。你不用一直陪我说话，按你自己的想法做点事情。',scope:'scene_public'
      })),result)
    } else {
      const current=()=> (events(runtime).findLast(e=>e.eventType==='activity.updated'&&(e.data as Json).activityKey==='trpg')?.data as Json)?.state
      const act=(operation:string,parameters:Json={})=>runtime.activityAction({
        activityKey:'trpg',activityId:operation==='start'?null:current()?.id,revision:operation==='start'?0:current()?.revision,
        operation,parameters,requestId:randomUUID()
      })
      await step(runtime,'table-start',()=>act('start',{npcIds:['character:aru','character:cheng','character:mei']}),result)
      await step(runtime,'invite-host',()=>act('setup',{hostId:'character:aru',scenario:'rainy-manor'}),result)
      await step(runtime,'investigate-door',()=>act('propose',{text:'我查看门厅画像和潮湿地毯，留意能公开看见的异常，不直接揭开主持人的秘密。'}),result)
      result.trpg=current()
    }
    result.finalEvents=events(runtime)
  } finally {await runtime.close();save()}
}
try {
  if (suite === 'rpg' || suite === 'rpg-autonomous') { await runRpg('values'); await runRpg('effects') }
  else if(suite==='rpg-rain') {await runRpg('values')}
  else if (suite === 'smoke') {
    await runSmoke('investigation');await runSmoke('communication');await runSmoke('autonomy');await runSmoke('trpg')
  } else throw new Error('Unknown live suite')
} finally {
  await Promise.allSettled(pending)
  globalThis.fetch = originalFetch
  save()
  console.log(JSON.stringify({ phase: 'complete', root, calls }))
}
