import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorldAddress } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'

/**
 * Paid/manual: a real model plays the frozen world through **the page's own runtime**, turn after turn,
 * and the world is closed and reopened in the middle of the session - so what is exercised is the playtest
 * a person gets, restart included, rather than a shorter path written for the experiment.
 *
 * Usage: DEEPSEEK_API_KEY=... node --import tsx tests/experiments/frozen-playtest-drive.ts
 *   [--model <id>] [--pack <v5 source directory>] [--scenario hand-in-hand|ai-girls] [--turns N]
 */
const modelIndex = process.argv.indexOf('--model')
const model = modelIndex === -1 ? 'deepseek-flash' : (process.argv[modelIndex + 1] ?? 'deepseek-flash')
const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
if (apiKey === undefined || apiKey.length === 0) throw new TypeError('DeepSeek credential unavailable')
const dataDirectory = resolve('.tmp', `frozen-playtest-drive-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`)
mkdirSync(dataDirectory, { recursive: true })
const packIndex = process.argv.indexOf('--pack')
const packPath = resolve(packIndex === -1
  ? 'examples/world-packs/hand-in-hand'
  : (process.argv[packIndex + 1] ?? 'examples/world-packs/hand-in-hand'))
const scenarioIndex = process.argv.indexOf('--scenario')
const scenario = scenarioIndex === -1 ? 'hand-in-hand' : (process.argv[scenarioIndex + 1] ?? 'hand-in-hand')
if (scenario !== 'hand-in-hand' && scenario !== 'ai-girls') throw new TypeError('unknown frozen playtest scenario')

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

const turns = scenario === 'ai-girls' ? aiGirlsTurns : handInHandTurns
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
  const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory, packPath, provider: 'deepseek',
    model, ...(apiKey === undefined ? {} : { apiKey }), timeoutMs: 90_000 })
  address ??= runtime.address
  currentSession = session
  try {
    const opened = await runtime.state()
    const openedDebug = opened.debug as { headSeq: number; playerInputMode: string }
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
  playerInputMode: 'interpreted-free-text',
  address,
  providerCalls: calls,
  providerLog: providerPath,
  // What the world recorded: the steps the model stated, the transfers, and the contact the fold ended.
  expressions,
  transfers: events.filter(event => event.eventType === 'entity.transferred').length,
  relationsStarted: events.filter(event => event.eventType === 'character.relation-started').length,
  relationsEnded: events.filter(event => event.eventType === 'character.relation-ended').length,
  turns: transcript,
}
writeFileSync(resolve(dataDirectory, 'outcome.json'), JSON.stringify(outcome, null, 2))
console.log(`\n数据目录：${dataDirectory}`)
