import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createPlaytestServer } from './playtest-server.ts'
import { defaultPlaytestDirectory, WorldPlaytestRuntime } from './playtest-runtime.ts'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--deepseek')) {
    throw new Error('unsupported playtest argument')
  }
  const provider = args[0] === '--deepseek' ? 'deepseek' : 'ollama'
  const dataDirectory = defaultPlaytestDirectory()
  const endpoint = process.env.HCW_OLLAMA_ENDPOINT
  const utilityModel = process.env.HCW_UTILITY_MODEL
  const model = provider === 'deepseek' ? 'deepseek-v4-flash' : process.env.HCW_OLLAMA_MODEL
  const apiKey = provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : undefined
  const runtime = await WorldPlaytestRuntime.create({
    dataDirectory,
    provider,
    ...(provider === 'ollama' && endpoint !== undefined ? { endpoint } : {}),
    ...(endpoint === undefined ? {} : { utilityEndpoint: endpoint }),
    ...(utilityModel === undefined ? {} : { utilityModel }),
    ...(model === undefined ? {} : { model }),
    ...(apiKey === undefined ? {} : { apiKey }),
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
  process.stdout.write(`世界数据：${dataDirectory}\nProvider：${provider}\n模型：${model?.trim() || 'qwen3.5:4b'}\n按 Ctrl+C 安全关闭。\n`)
}

try {
  await main()
} catch (error: unknown) {
  console.error('本机试玩页启动失败：', error instanceof Error ? error.message : '未知错误')
  process.exitCode = 1
}
