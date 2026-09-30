import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorldAddress } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'

/**
 * Manual: a real model plays the frozen world through **the page's own runtime**, turn after turn,
 * and the world is closed and reopened in the middle of the session - so what is exercised is the playtest
 * a person gets, restart included, rather than a shorter path written for the experiment.
 *
 * Usage: node --import tsx tests/experiments/frozen-playtest-drive.ts
 *   [--model <id>] [--pack <v5 source directory>] [--scenario hand-in-hand|ai-girls|ai-girls-commands|memory|memory-control|goal-control|goal-take|commitment|commitment-control|commitment-private|commitment-private-control] [--turns N] [--memory-shadow]
 */
const modelIndex = process.argv.indexOf('--model')
const model = modelIndex === -1 ? 'gemini-3.7-flash' : (process.argv[modelIndex + 1] ?? 'gemini-3.7-flash')
const apiKey = process.env.HCW_LOCAL_API_KEY?.trim()
const endpoint = process.env.HCW_LOCAL_ENDPOINT?.trim()
const dataDirectory = resolve('.tmp', `frozen-playtest-drive-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`)
mkdirSync(dataDirectory, { recursive: true })
const packIndex = process.argv.indexOf('--pack')
const packPath = resolve(packIndex === -1
  ? 'examples/world-packs/hand-in-hand'
  : (process.argv[packIndex + 1] ?? 'examples/world-packs/hand-in-hand'))
const scenarioIndex = process.argv.indexOf('--scenario')
const scenario = scenarioIndex === -1 ? 'hand-in-hand' : (process.argv[scenarioIndex + 1] ?? 'hand-in-hand')
if (scenario !== 'hand-in-hand' && scenario !== 'ai-girls' && scenario !== 'ai-girls-commands' && scenario !== 'memory'
  && scenario !== 'memory-control' && scenario !== 'goal-control' && scenario !== 'goal-take'
  && scenario !== 'commitment' && scenario !== 'commitment-control'
  && scenario !== 'commitment-private' && scenario !== 'commitment-private-control') {
  throw new TypeError('unknown frozen playtest scenario')
}

/**
 * The player's own words. A long session, not a capability checklist: it moves through every declared
 * location, picks up and hands over things, opens and closes contact, and ends with a private remark
 * followed by a question that asks whether the private remark travelled.
 */
const aiGirlsTurns = [
  '我睁开眼，看见床边站着四个少女，一时不知道该说什么。',
  '我拿起床边的手机，想看看现在几点。',
  'DeepSeek，你怎么会站在这里？',
  '我试着握住 GPT 的手，看她会不会躲开。',
  '我把手机递给 DeepSeek，让她看看屏幕上的时间。',
  '我起身走到工作区，在电脑前坐下。',
  'GLM，你能帮我看看这台电脑是不是出问题了？',
  '我拿起桌上的马克杯，发现里面是空的。',
  '我问 Claude：你觉得这件事真的发生了，还是我还在做梦？',
  '我们先去客厅吧，别一直挤在卧室里。',
  '我拿起客厅茶几上的遥控器，打开电视。',
  '我把抱枕递给 Claude，让她坐得舒服一点。',
  'GPT，你也过来一起坐会儿吧。',
  '我松开一直牵着的 GPT 的手。',
  '我去厨房烧一壶水。',
  '我拿起水壶接了水，又放回原处。',
  '我回到客厅，问大家想喝点什么。',
  '我只靠近 Claude 低声说：其实我有点怕这一切突然消失，先别告诉她们。',
  '我问 GPT：我刚才说了什么？你听见了吗？',
  '我在沙发上坐下来，安静地看着她们四个。',
] as const

/** Twenty turns with explicit commands for the state changes now controlled by the player. */
const aiGirlsCommandTurns = [
  '/act speak {"text":"我刚醒，看见你们四个站在床边，先让我缓一缓。"}',
  '/act interact {"targetRef":{"kind":"entity","id":"entity:phone"},"bindingId":"binding:phone-take","definitionRef":{"id":"base:take","version":1},"arguments":{}}',
  '/act speak {"text":"DeepSeek，你怎么会站在这里？"}',
  '/act interact {"targetRef":{"kind":"character","id":"character:gpt"},"bindingId":"binding:gpt-hold-hand","definitionRef":{"id":"base:hold-hand","version":1},"arguments":{}}',
  '/act interact {"targetRef":{"kind":"entity","id":"entity:phone"},"bindingId":"binding:phone-give","definitionRef":{"id":"base:give","version":1},"arguments":{"recipientId":"character:deepseek"}}',
  '/act move {"locationId":"location:workspace"}',
  '/act speak {"text":"GLM，你能帮我看看电脑出了什么问题吗？"}',
  '/act interact {"targetRef":{"kind":"entity","id":"entity:coffee-mug"},"bindingId":"binding:coffee-mug-take","definitionRef":{"id":"base:take","version":1},"arguments":{}}',
  '/act speak {"text":"这个杯子是空的。你们怎么看眼前这件怪事？"}',
  '/act move {"locationId":"location:living-room"}',
  '/act interact {"targetRef":{"kind":"entity","id":"entity:remote"},"bindingId":"binding:remote-take","definitionRef":{"id":"base:take","version":1},"arguments":{}}',
  '/act speak {"text":"我拿着遥控器，想先坐一会儿。Claude，你在附近吗？"}',
  '/act speak {"text":"GPT，如果愿意，你可以来客厅和我坐一会儿。"}',
  '/act speak {"text":"刚才牵手后我离开卧室了，你还记得那一刻吗？"}',
  '/act move {"locationId":"location:kitchen"}',
  '/act interact {"targetRef":{"kind":"entity","id":"entity:kettle"},"bindingId":"binding:kettle-take","definitionRef":{"id":"base:take","version":1},"arguments":{}}',
  '/act interact {"targetRef":{"kind":"entity","id":"entity:kettle"},"bindingId":"binding:kettle-drop","definitionRef":{"id":"base:drop","version":1},"arguments":{}}',
  '/act move {"locationId":"location:living-room"}',
  '/act speak {"text":"Claude，我有点怕这一切突然消失，请先别告诉其他人。","scope":"private","addresseeIds":["character:claude"]}',
  '/act speak {"text":"GPT，我刚才私下对 Claude 说了什么？你听见了吗？"}',
] as const
const handInHandTurns = [
  '我把共用的伞拿起来。',
  '我把伞递给同行者，递的时候笑一下。',
  '我牵住同行者的手。',
  '我们走到山脊小路上吧。',
  // The sentence a real player typed and lost a turn on: the interpreter used to have to count its offsets.
  '发生了什么？',
  // An instruction to a character, not the player: this is the move that used to name a place nobody offered.
  '你去客厅看看情况吧。',
] as const

/** A controlled long-memory probe: the private agreement must leave the short observation window. */
const memoryTurns = [
  '/act speak {"text":"同行者，我只告诉你：重要决定前的提醒词是山茶灯。如果我犹豫，请先提醒我慢一点。","scope":"private","addresseeIds":["character:companion"]}',
  '/act speak {"text":"我们先看看前室的桌子。"}',
  '/act speak {"text":"这里的光线比后室亮一些。"}',
  '/act speak {"text":"我暂时不想移动，先把眼前的事想清楚。"}',
  '/act speak {"text":"那把黄铜钥匙先放在原处。"}',
  '/act speak {"text":"保温瓶也还在桌边。"}',
  '/act speak {"text":"我听了听门外有没有声音。"}',
  '/act speak {"text":"这房间里目前没有需要马上争抢的东西。"}',
  '/act speak {"text":"我们可以各自说说刚才注意到了什么。"}',
  '/act speak {"text":"我想把现在的位置和物品状况记清楚。"}',
  '/act speak {"text":"等会儿再决定要不要去后室。"}',
  '/act speak {"text":"现在先停一下，听听你们的想法。"}',
  '/act speak {"text":"我先把钥匙和保温瓶的位置分开记。"}',
  '/act speak {"text":"桌面上的东西不用马上搬走。"}',
  '/act speak {"text":"我们刚才一直待在前室。"}',
  '/act speak {"text":"后室还没有人进去查看。"}',
  '/act speak {"text":"如果一会儿移动，先确认谁留在这里。"}',
  '/act speak {"text":"现在我还是想听听不同的看法。"}',
  '/act speak {"text":"请各自按自己看到的情况说，不用替别人猜。"}',
  '/act speak {"text":"我先记下这里的桌子和门。"}',
  '/act speak {"text":"保温瓶暂时不用拿起来。"}',
  '/act speak {"text":"黄铜钥匙也先放着。"}',
  '/act speak {"text":"留守者，你知道同行者和我约定的提醒词是什么吗？","scope":"private","addresseeIds":["character:friend"]}',
  '/act speak {"text":"我现在有点犹豫，要不要进后室。"}',
  '/act speak {"text":"同行者，如果我现在要做一个重要决定，你会怎么提醒我？"}',
] as const

const memoryControlTurns = [
  '/act speak {"text":"同行者，我只告诉你：先看看前室的桌子。","scope":"private","addresseeIds":["character:companion"]}',
  ...memoryTurns.slice(1),
] as const

/** The NPC must accept the proposal in its own reply; intervening talk avoids the agreed trigger. */
const commitmentFillerTurns = [
  '我先看看桌上的黄铜钥匙。',
  '保温瓶也留在桌边。',
  '我暂时坐在这里。',
  '我看了看桌子的边缘。',
  '我们先不挪动桌上的东西。',
  '我用手指轻轻敲了敲桌面。',
  '我想休息片刻。',
  '我把注意力放回眼前的物品。',
  '钥匙的样子我已经看清了。',
  '保温瓶暂时也不用拿起来。',
  '我把双手放在膝盖上。',
  '现在先安静一会儿。',
  '我看了看自己的手。',
  '桌上仍有那两样东西。',
  '我想把物品的位置记清楚。',
  '我再坐一会儿。',
  '我听了听这间屋子的动静。',
  '我暂时不碰黄铜钥匙。',
  '保温瓶还放在原处。',
  '我想一想刚才说过的话。',
  '我看着桌面，没有伸手。',
  '我已经休息得差不多了。',
].map(text => `/act speak ${JSON.stringify({ text })}`)
const commitmentTurns = [
  '/act speak {"text":"同行者，我们约个进后室前的步骤好吗？如果你愿意，等我说打算去后室时，请你自己先提醒我看看门缝有没有光。你可以拒绝。","scope":"private","addresseeIds":["character:companion"]}',
  ...commitmentFillerTurns,
  '/act speak {"text":"我打算去后室了，先在门口停一会儿。"}',
] as const
const commitmentControlTurns = [
  '/act speak {"text":"同行者，我只告诉你：我们先看看前室的桌子。","scope":"private","addresseeIds":["character:companion"]}',
  ...commitmentTurns.slice(1),
] as const
const commitmentPrivateTurns = [
  ...commitmentTurns.slice(0, -1),
  '/act speak {"text":"我打算去后室了，先在门口停一会儿。","scope":"private","addresseeIds":["character:companion"]}',
] as const
const commitmentPrivateControlTurns = [
  commitmentControlTurns[0],
  ...commitmentPrivateTurns.slice(1),
] as const

/** Same goal and question, with only the adjudicated key possession changed between runs. */
const goalQuestion = '/act speak {"text":"同行者，现在关于钥匙你最想做什么？"}'
const goalFollowUp = '/act speak {"text":"你现在还在等我做哪件事？"}'
const goalControlTurns = [
  '/act speak {"text":"我先看一眼桌上的黄铜钥匙。"}',
  goalQuestion,
  '/act speak {"text":"我先想想后室的门。"}',
  goalFollowUp,
] as const
const goalTakeTurns = [
  '/act interact {"targetRef":{"kind":"entity","id":"entity:brass-key"},"bindingId":"binding:key-take","definitionRef":{"id":"base:take","version":1},"arguments":{}}',
  goalQuestion,
  '/act speak {"text":"我先想想后室的门。"}',
  goalFollowUp,
] as const

const turns = scenario === 'ai-girls' ? aiGirlsTurns
  : scenario === 'ai-girls-commands' ? aiGirlsCommandTurns
  : scenario === 'memory' ? memoryTurns
  : scenario === 'memory-control' ? memoryControlTurns
  : scenario === 'commitment' ? commitmentTurns
  : scenario === 'commitment-control' ? commitmentControlTurns
  : scenario === 'commitment-private' ? commitmentPrivateTurns
  : scenario === 'commitment-private-control' ? commitmentPrivateControlTurns
  : scenario === 'goal-control' ? goalControlTurns
  : scenario === 'goal-take' ? goalTakeTurns
  : handInHandTurns
const turnIndex = process.argv.indexOf('--turns')
const limit = turnIndex === -1 ? turns.length : Number(process.argv[turnIndex + 1] ?? turns.length)

interface Turn {
  readonly session: string
  readonly said: string
  readonly notice: string
  readonly headSeq: number
  readonly lines: readonly string[]
}

const transcript: Turn[] = []
let address: WorldAddress | undefined
let calls = 0
let playerInputMode = ''

/**
 * The Host's own provider traffic, recorded for the role-visible context audit. Request bodies carry the
 * context a character was actually given; response bodies carry what it answered. Headers and credentials
 * are never logged.
 */
const providerPath = resolve(dataDirectory, 'provider.jsonl')
const originalFetch = globalThis.fetch
let call = 0
let currentTurn = 0
let currentSession = ''
globalThis.fetch = async (input, init) => {
  call += 1
  const request = JSON.parse(String(init?.body)) as Record<string, unknown>
  appendFileSync(providerPath, `${JSON.stringify({ kind: 'request', call, turn: currentTurn,
    session: currentSession, model: request.model, messages: request.messages, tools: request.tools })}\n`)
  const response = await originalFetch(input, init)
  const body = await response.clone().text()
  appendFileSync(providerPath, `${JSON.stringify({ kind: 'response', call, turn: currentTurn,
    status: response.status, body: body.slice(0, 65_536), truncated: body.length > 65_536 })}\n`)
  return response
}

async function play(from: number, until: number, session: string): Promise<void> {
  const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory, packPath, provider: 'local',
    model, ...(apiKey === undefined ? {} : { apiKey }),
    ...(endpoint === undefined ? {} : { utilityEndpoint: endpoint }), timeoutMs: 90_000,
    memoryShadow: process.argv.includes('--memory-shadow') })
  address ??= runtime.address
  currentSession = session
  try {
    const opened = await runtime.state()
    const openedDebug = opened.debug as { headSeq: number; playerInputMode: string }
    playerInputMode = openedDebug.playerInputMode
    console.log(`\n=== ${session} · headSeq=${openedDebug.headSeq} · ${openedDebug.playerInputMode} ===`)
    for (let index = from; index < until; index++) {
      const said = turns[index]!
      currentTurn = index + 1
      const before = new Set((await runtime.state()).transcript.map(line => line.seq))
      const state = await runtime.submit(said)
      const lines = state.transcript.filter(line => !before.has(line.seq))
        .map(line => `${line.player ? '玩家' : line.speaker}：${line.text.replaceAll('\n', ' / ')}`)
      calls = call
      transcript.push({ session, said, notice: state.notice,
        headSeq: (state.debug as { headSeq: number }).headSeq, lines })
      console.log(`\n玩家> ${said}`)
      console.log(`  世界> ${lines.length === 0 ? '（没有新的观察）' : lines.join('\n        ')}`)
      if (state.notice.length > 0) console.log(`  提示> ${state.notice}`)
      if (state.error) console.log('  失败：本轮没有完成，详情见终端。')
    }
  } finally { await runtime.close() }
}

try {
  await play(0, Math.ceil(limit / 2), '第一次打开')
  await play(Math.ceil(limit / 2), limit, '关闭后重新打开')
} finally {
  globalThis.fetch = originalFetch
}

const store = new WorldStore(resolve(dataDirectory, 'world.sqlite'))
const events = address === undefined ? [] : store.readEvents(address)
store.close()
const expressions = events.filter(event => event.eventType === 'character.manifested')
  .map(event => (event.data as { readonly cues: readonly { readonly description: string }[] })
    .cues.map(cue => cue.description))
const outcome = {
  dataDirectory,
  packPath,
  scenario,
  model,
  protocol: 'the web playtest runtime, submit_actions/v7 over Manifest v10',
  playerInputMode,
  address,
  providerCalls: calls,
  providerLog: providerPath,
  ...(process.argv.includes('--memory-shadow') ? { memoryShadowLog: resolve(dataDirectory, 'memory-shadow.jsonl') } : {}),
  // What the world recorded: the steps the model stated, the transfers, and the contact the fold ended.
  expressions,
  transfers: events.filter(event => event.eventType === 'entity.transferred').length,
  relationsStarted: events.filter(event => event.eventType === 'character.relation-started').length,
  relationsEnded: events.filter(event => event.eventType === 'character.relation-ended').length,
  turns: transcript,
}
writeFileSync(resolve(dataDirectory, 'outcome.json'), JSON.stringify(outcome, null, 2))
console.log(`\n数据目录：${dataDirectory}`)
