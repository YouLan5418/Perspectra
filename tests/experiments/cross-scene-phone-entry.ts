import { resolve } from 'node:path'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { createChatProvider } from '@harness-world/provider-chat'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'
import { crossSceneRuntime, communicationContext } from './cross-scene-runtime.ts'
import { CrossScenePhone } from './cross-scene-phone.ts'
import { currentLocation } from '@harness-world/kernel'

const directory = process.argv[2]
if (!directory) throw new TypeError('请指定新的电话实验数据目录，追加 --scenario 可运行固定短场景')
const provider = createChatProvider({ endpoint: new URL(process.env.HCW_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8046/v1/chat/completions'),
  model: process.env.HCW_LOCAL_MODEL ?? 'gemini-3.8-flash', style: 'tool', timeoutMs: 60000,
  ...(process.env.HCW_LOCAL_API_KEY ? { apiKey: process.env.HCW_LOCAL_API_KEY } : {}) })
const runtime = await crossSceneRuntime(resolve(directory), async (request, signal) => {
  const raw = await provider.decide(localPrototypeTurnCall(communicationContext(request)), signal)
  appendFileSync(resolve(directory, 'decisions.jsonl'), JSON.stringify({ characterId: (request.context.character as { characterId: string }).characterId,
    continuation: request.continuation, output: JSON.stringify(raw).slice(0, 16000) }) + '\n')
  return raw
}, { phone: true })
const results: unknown[] = []
const command = async (line: string) => {
  const [verb, ...rest] = line.split(' ')
  if (!['call', 'say', 'hangup', 'accept', 'decline'].includes(verb ?? '')) throw new TypeError('命令：call、say 正文、hangup、accept、decline')
  const result = await runtime.phone(verb as 'call' | 'say' | 'hangup' | 'accept' | 'decline', verb === 'say' ? rest.join(' ') : undefined)
  const summary = { operation: verb, status: result.sent.status, terminalReason: result.cycle.terminalReason, calls: result.calls,
    activations: result.cycle.activations.map(a => ({ characterId: a.characterId, status: a.result.status, failure: a.result.failure })), transcript: result.transcript }
  results.push(summary); console.log(JSON.stringify(summary, null, 2))
  if (['failed', 'interrupted'].includes(result.cycle.terminalReason)) process.exitCode = 1
}
try {
  if (process.argv[3] === '--scenario') {
    await command('call')
    const phone = runtime.communication as CrossScenePhone
    if (phone.callFor(runtime.store.readEvents(runtime.address), 'character:player')?.state === 'connected') {
      await command('say 我在前室。秘密暗号是蓝色纸鹤，请不要向留守者复述暗号。请通过电话告诉我你是否愿意稍后过来，先不要移动。')
      if (phone.callFor(runtime.store.readEvents(runtime.address), 'character:player')) await command('hangup')
      await command('say 挂断后的话不应送达')
    }
  } else {
    const input = createInterface({ input: stdin, output: stdout })
    try { console.log('玩家在前室；两名 NPC 在后室。call 呼叫同行者，say 正文 通过电话说话，hangup 挂断，/quit 退出。')
      for (;;) { const line = await input.question('电话> '); if (line === '/quit') break; if (line.trim()) await command(line) }
    } finally { input.close() }
  }
} finally {
  const events = runtime.store.readEvents(runtime.address)
  writeFileSync(resolve(directory, 'evidence.json'), JSON.stringify({ results,
    positions: Object.fromEntries(['character:player', 'character:companion', 'character:friend'].map(id => [id, currentLocation(events, id)])),
    friendObservations: runtime.view('character:friend').observations,
  }, null, 2) + '\n')
  await runtime.close()
}
