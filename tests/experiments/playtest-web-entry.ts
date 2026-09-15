import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { parsePlaytestLaunchArguments } from './playtest-launch.ts'
import { FrozenWorldPlaytestRuntime, isFrozenPackDirectory } from './playtest-frozen-runtime.ts'
import { createPlaytestServer } from './playtest-server.ts'
import { defaultPlaytestDirectory, WorldPlaytestRuntime } from './playtest-runtime.ts'

async function main(): Promise<void> {
  const launch = parsePlaytestLaunchArguments(process.argv.slice(2))
  const provider = launch.provider
  const packPath = launch.packPath ?? (process.env.HCW_PLAYTEST_PACK?.trim() || undefined)
  const dataDirectory = launch.dataDirectory
    ?? (process.env.HCW_PLAYTEST_DATA_DIRECTORY?.trim() || defaultPlaytestDirectory())
  const endpoint = process.env.HCW_OLLAMA_ENDPOINT
  const utilityModel = process.env.HCW_UTILITY_MODEL
  const model = provider === 'deepseek' ? (process.env.HCW_DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash') : process.env.HCW_OLLAMA_MODEL
  const apiKey = provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : undefined
  // A v5 Pack is the frozen path: the same page, driven by the protocol production offers that world.
  // Anything else keeps the older line, whose own renderer and utility interpreter are untouched.
  const frozen = packPath !== undefined && isFrozenPackDirectory(packPath)
  const runtime = frozen ? await FrozenWorldPlaytestRuntime.create({
    dataDirectory, provider, packPath,
    ...(model === undefined ? {} : { model }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(endpoint === undefined ? {} : { utilityEndpoint: endpoint }),
  }) : await WorldPlaytestRuntime.create({
    dataDirectory,
    provider,
    ...(launch.interactionsPath === undefined ? {} : { interactionsPath: launch.interactionsPath }),
    ...(launch.actionGroups === undefined ? {} : { actionGroups: launch.actionGroups }),
    ...(launch.recallTokenizer === undefined ? {} : { recallTokenizer: launch.recallTokenizer }),
    ...(launch.recallDictionary === undefined ? {} : { recallDictionary: launch.recallDictionary }),
    ...(launch.leanPrompt === undefined ? {} : { promptMode: launch.leanPrompt ? 'lean' as const : 'compact' as const }),
    ...(packPath === undefined ? {} : { packPath }),
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
  if (packPath !== undefined) process.stdout.write(`World Pack：${packPath}\n`)
}

try {
  await main()
} catch (error: unknown) {
  console.error('本机试玩页启动失败：', error instanceof Error ? error.message : '未知错误')
  process.exitCode = 1
}
