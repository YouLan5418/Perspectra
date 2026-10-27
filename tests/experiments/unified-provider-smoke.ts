// Real-model smoke for the pi-ai adapter: a few rounds per DeepSeek target, native memory, a fresh data directory.
// Usage: DEEPSEEK_API_KEY=... node --import tsx tests/experiments/unified-provider-smoke.ts
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { environmentRoleModels } from '../../desktop/model-connections.ts'

const key = process.env.DEEPSEEK_API_KEY
if (!key) throw new Error('DEEPSEEK_API_KEY missing')
const root = resolve('.tmp/unified-provider-smoke-' + Date.now())
const targets = [
  { name: 'openai-unset', protocol: 'openai', endpoint: 'https://api.deepseek.com/chat/completions' },
  { name: 'openai-low', protocol: 'openai', endpoint: 'https://api.deepseek.com/chat/completions', level: 'low' },
  { name: 'anthropic-unset', protocol: 'anthropic', endpoint: 'https://api.deepseek.com/anthropic/v1/messages' },
] as const
const inputs = ['你好，这里是哪里？', '桌上那把钥匙是谁的？', '能帮我把钥匙收好吗？']
const report: unknown[] = []
for (const target of targets) {
  const dataDirectory = join(root, target.name)
  mkdirSync(dataDirectory, { recursive: true })
  const runtime = await WorldHostRuntime.create({
    dataDirectory,
    packPath: resolve('examples/world-packs/prototype-g1'),
    models: environmentRoleModels({
      PERSPECTRA_MODEL_PROTOCOL: target.protocol,
      PERSPECTRA_MODEL_ENDPOINT: target.endpoint,
      PERSPECTRA_MODEL: 'deepseek-flash',
      PERSPECTRA_MODEL_API_KEY: key,
      ...('level' in target ? { PERSPECTRA_THINKING_LEVEL: target.level } : {}),
    }),
    timeoutMs: 90_000,
  })
  runtime.requestInspection(true)
  const rounds = []
  try {
    for (const text of inputs) {
      const started = Date.now()
      const state = await runtime.submit(text)
      const inspector = runtime.requestInspection() as unknown as { requests: Record<string, unknown>[] }
      rounds.push({
        input: text,
        seconds: Math.round((Date.now() - started) / 100) / 10,
        error: state.error,
        notice: state.notice ?? null,
        lines: state.transcript.slice(-6).map(line => `${line.speaker}: ${line.text}`),
        calls: inspector.requests.map(r => ({
          status: r.status,
          failure: r.failure ?? null,
          httpStatus: r.httpStatus ?? null,
          usage: r.usage ?? null,
          toolCalls: ((r.response as { toolCalls?: { name: string }[] } | undefined)?.toolCalls ?? []).map(c => c.name),
          thinkingField: JSON.stringify((r.body as Record<string, unknown> | null)?.thinking ?? null),
          toolChoice: JSON.stringify((r.body as Record<string, unknown> | null)?.tool_choice ?? null),
        })),
      })
    }
  } finally {
    await runtime.close()
  }
  report.push({ target: target.name, rounds })
}
const leaked: string[] = []
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (readFileSync(path).includes(key.slice(0, 8))) leaked.push(path)
  }
}
walk(root)
writeFileSync(join(root, 'report.json'), JSON.stringify({ report, leaked }, null, 2))
process.stdout.write(JSON.stringify({ root, leaked }, null, 2) + '\n')
