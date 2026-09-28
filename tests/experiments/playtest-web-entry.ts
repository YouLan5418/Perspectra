import { readFileSync, mkdirSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseAuditItems, type ShadowOptions } from './jev-shadow.ts'
import { createClaimClassifier } from './jev-shadow-claims-client.ts'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { parsePlaytestLaunchArguments } from './playtest-launch.ts'
import { FrozenWorldPlaytestRuntime, isFrozenPackDirectory } from './playtest-frozen-runtime.ts'
import { createPlaytestServer } from './playtest-server.ts'
import { defaultPlaytestDirectory } from './playtest-view.ts'

async function main(): Promise<void> {
  const launch = parsePlaytestLaunchArguments(process.argv.slice(2))
  const provider = launch.provider
  const packPath = launch.packPath ?? (process.env.HCW_PLAYTEST_PACK?.trim() || undefined)
  const dataDirectory = launch.dataDirectory
    ?? (process.env.HCW_PLAYTEST_DATA_DIRECTORY?.trim() || defaultPlaytestDirectory())
  const endpoint = provider === 'ollama' ? process.env.HCW_OLLAMA_ENDPOINT
    : provider === 'local' ? process.env.HCW_LOCAL_ENDPOINT : undefined
  const model = provider === 'deepseek' ? (process.env.HCW_DEEPSEEK_MODEL?.trim() || 'deepseek-flash')
    : provider === 'ollama' ? process.env.HCW_OLLAMA_MODEL : process.env.HCW_LOCAL_MODEL
  const apiKey = provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY
    : provider === 'local' ? process.env.HCW_LOCAL_API_KEY : undefined
  if (packPath === undefined || !isFrozenPackDirectory(packPath)) {
    throw new Error('请通过 --pack 指定 worldpack-source/v5 世界源目录；旧 Pack 已不再由网页试玩入口运行')
  }
  let shadowAudit: ShadowOptions | undefined
  if (launch.shadowConfigPath !== undefined) {
    const items = parseAuditItems(JSON.parse(readFileSync(resolve(launch.shadowConfigPath), 'utf8')))
    const classify = createClaimClassifier(process.env.OPENROUTER_JEV_KEY ?? '')
    mkdirSync(resolve(dataDirectory), { recursive: true })
    const logPath = resolve(dataDirectory, 'jev-shadow.jsonl')
    shadowAudit = { items, classify,
      write: async record => { await appendFile(logPath, JSON.stringify(record) + '\n', 'utf8') },
      onError: message => { console.error(message) } }
    process.stdout.write(`Jev 影子审计已启用：已发布的对白和叙述将发送到 OpenRouter。日志：${logPath}\n`)
  }
  const runtime = await FrozenWorldPlaytestRuntime.create({
    dataDirectory, provider, packPath,
    ...(shadowAudit === undefined ? {} : { shadowAudit }),
    ...(model === undefined ? {} : { model }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(endpoint === undefined ? {} : { utilityEndpoint: endpoint }),
  })
  const token = randomBytes(32).toString('hex')
  const server = createPlaytestServer(runtime, token)
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    if (server.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => error === undefined ? resolveClose() : rejectClose(error))
      })
    }
    await runtime.close()
  }
  process.once('SIGINT', () => { void close().then(() => { process.exitCode = 0 }) })
  process.once('SIGTERM', () => { void close().then(() => { process.exitCode = 0 }) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  process.stdout.write(`\n本机试玩页已启动：\nhttp://127.0.0.1:${port}/#token=${token}\n\n`)
  process.stdout.write(`世界数据：${dataDirectory}\nProvider：${provider}\n模型：${model?.trim() || (provider === 'local' ? 'gemini-3.7-flash' : provider === 'deepseek' ? 'deepseek-flash' : 'qwen3:4b')}\n按 Ctrl+C 安全关闭。\n`)
  if (packPath !== undefined) process.stdout.write(`World Pack：${packPath}\n`)
}

try {
  await main()
} catch (error: unknown) {
  console.error('本机试玩页启动失败：', error instanceof Error ? error.message : '未知错误')
  process.exitCode = 1
}
