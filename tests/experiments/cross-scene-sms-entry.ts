import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { createChatProvider } from '@harness-world/provider-chat'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'
import { crossSceneRuntime, communicationContext } from './cross-scene-runtime.ts'

const directory = process.argv[2]
if (!directory) throw new TypeError('请显式指定新的实验数据目录：node --import tsx tests/experiments/cross-scene-sms-entry.ts <目录> [短信正文]')
const provider = createChatProvider({ endpoint: new URL(process.env.HCW_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8046/v1/chat/completions'),
  model: process.env.HCW_LOCAL_MODEL ?? 'gemini-3.8-flash', style: 'tool', timeoutMs: 60000,
  ...(process.env.HCW_LOCAL_API_KEY ? { apiKey: process.env.HCW_LOCAL_API_KEY } : {}) })
const runtime = await crossSceneRuntime(resolve(directory), async (request, signal) => {
  const raw = await provider.decide(localPrototypeTurnCall(communicationContext(request)), signal)
  appendFileSync(resolve(directory, 'decisions.jsonl'), JSON.stringify({ characterId: (request.context.character as { characterId: string }).characterId,
    continuation: request.continuation, output: JSON.stringify(raw).slice(0, 16000) }) + '\n')
  return raw
})
const display = async (text: string) => {
  const result = await runtime.send(text)
  console.log(JSON.stringify({ status: result.sent.status, terminalReason: result.cycle.terminalReason,
    activations: result.cycle.activations.map(a => ({ characterId: a.characterId, status: a.result.status, calls: a.result.calls, failure: a.result.failure })), transcript: result.transcript }, null, 2))
  if (result.sent.status === 'rejected' || ['failed', 'interrupted'].includes(result.cycle.terminalReason)) process.exitCode = 1
}
try {
  if (process.argv[3]) await display(process.argv[3])
  else {
    const input = createInterface({ input: stdin, output: stdout })
    try { console.log('玩家在前室；同行者与留守者在后室。输入短信发给同行者，/quit 退出。')
      for (;;) { const text = await input.question('短信> '); if (text === '/quit') break; if (text.trim()) await display(text) }
    } finally { input.close() }
  }
} finally { await runtime.close() }
