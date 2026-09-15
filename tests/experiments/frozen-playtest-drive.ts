import { mkdirSync, writeFileSync } from 'node:fs'
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

/** The player's own words. Two of them state how it is done, which is what a step is for. */
const turns = scenario === 'ai-girls' ? [
  '我拿起床边的手机。',
  '我把手机递给DeepSeek，递的时候笑了一下。',
  '我轻轻牵住DeepSeek的手。',
  '我们一起去客厅吧。',
  '发生了什么？',
] : [
  '我把共用的伞拿起来。',
  '我把伞递给同行者，递的时候笑一下。',
  '我牵住同行者的手。',
  '我们走到山脊小路上吧。',
  // The sentence a real player typed and lost a turn on: the interpreter used to have to count its offsets.
  '发生了什么？',
  // An instruction to a character, not the player: this is the move that used to name a place nobody offered.
  '你去客厅看看情况吧。',
]
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

async function play(from: number, until: number, session: string): Promise<void> {
  const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory, packPath, provider: 'deepseek',
    model, ...(apiKey === undefined ? {} : { apiKey }), timeoutMs: 90_000 })
  address ??= runtime.address
  try {
    const opened = await runtime.state()
    const openedDebug = opened.debug as { headSeq: number; playerInputMode: string }
    console.log(`\n=== ${session} · headSeq=${openedDebug.headSeq} · ${openedDebug.playerInputMode} ===`)
    for (const said of turns.slice(from, until)) {
      const before = new Set((await runtime.state()).transcript.map(line => line.seq))
      const state = await runtime.submit(said)
      const lines = state.transcript.filter(line => !before.has(line.seq))
        .map(line => `${line.player ? '玩家' : line.speaker}：${line.text.replaceAll('\n', ' / ')}`)
      calls = (state.debug as { providerCalls: number }).providerCalls
      transcript.push({ session, said, notice: state.notice,
        headSeq: (state.debug as { headSeq: number }).headSeq, lines })
      console.log(`\n玩家> ${said}`)
      console.log(`  世界> ${lines.length === 0 ? '（没有新的观察）' : lines.join('\n        ')}`)
      if (state.notice.length > 0) console.log(`  提示> ${state.notice}`)
      if (state.error) console.log('  失败：本轮没有完成，详情见终端。')
    }
  } finally { await runtime.close() }
}

await play(0, Math.ceil(limit / 2), '第一次打开')
await play(Math.ceil(limit / 2), limit, '关闭后重新打开')

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
  protocol: 'the web playtest runtime, submit_actions/v7 over Manifest v10',
  playerInputMode: 'interpreted-free-text',
  address,
  providerCalls: calls,
  // What the world recorded: the steps the model stated, the transfers, and the contact the fold ended.
  expressions,
  transfers: events.filter(event => event.eventType === 'entity.transferred').length,
  relationsStarted: events.filter(event => event.eventType === 'character.relation-started').length,
  relationsEnded: events.filter(event => event.eventType === 'character.relation-ended').length,
  turns: transcript,
}
writeFileSync(resolve(dataDirectory, 'outcome.json'), JSON.stringify(outcome, null, 2))
console.log(`\n数据目录：${dataDirectory}`)
