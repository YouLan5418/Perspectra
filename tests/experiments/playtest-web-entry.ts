import { thinkingLevel } from '../../packages/provider-chat/src/thinking.ts'
import { readingPreferences } from '../../desktop/play-settings.ts'
import { providerProtocol } from '../../packages/provider-chat/src/protocol.ts'
import { ModelPresets, packPreset } from '../../desktop/model-presets.ts'
import { rolePreset, rolePresetMapping } from '../../packages/provider-chat/src/preset.ts'
import { createTrustedFrontendServer, type FrontendPolicy } from './playtest-frontend-assets.ts'
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
import { PlaytestBusyError, createPlaytestServer } from './playtest-server.ts'
import { loadPackWeb } from './playtest-pack-web.ts'
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
  const packWeb = await loadPackWeb(packPath)
  const recommended = await packPreset(packPath)
  const settings = process.env.PERSPECTRA_PRESET_ROOT ? new ModelPresets(process.env.PERSPECTRA_PRESET_ROOT) : undefined
  if (settings) await settings.load()
  const instanceId = process.env.PERSPECTRA_PRESET_INSTANCE ?? ''
  if (settings && !/^[a-f0-9-]{36}$/.test(instanceId)) throw new Error('启动预设的实例标识无效。')
  const {mode: _mode, override: _override, ...mapping} = settings?.instances[instanceId] ?? { mode: 'auto', override: {} }
  const runtime = await FrozenWorldPlaytestRuntime.create({
    dataDirectory, provider, packPath, ...(process.env.HCW_THINKING_LEVEL === undefined ? {} : {thinkingLevel:thinkingLevel(process.env.HCW_THINKING_LEVEL)}), protocol: providerProtocol(process.env.HCW_MODEL_PROTOCOL),
    storyNodes: !!process.send,
    ...(launch.playSettings===undefined?{}:{playSettings:launch.playSettings}),
    ...(process.env.PERSPECTRA_READING===undefined?{}:{reading:readingPreferences(JSON.parse(process.env.PERSPECTRA_READING))}),
    ...(process.env.PERSPECTRA_STORY_PARENT_NODE ? {storyParentNodeId:process.env.PERSPECTRA_STORY_PARENT_NODE} : {}),
    preset:settings?settings.effective(instanceId,recommended):process.env.PERSPECTRA_ROLE_PRESET===undefined?recommended:rolePreset(JSON.parse(process.env.PERSPECTRA_ROLE_PRESET)),
    presetMapping:settings?rolePresetMapping(mapping):rolePresetMapping(JSON.parse(process.env.PERSPECTRA_ROLE_MAPPING??'{}')),
    ...(launch.memoryCore ? { memoryCore: true } : {}),
    ...(launch.tuning === undefined ? {} : { tuning: launch.tuning }),
    ...(shadowAudit === undefined ? {} : { shadowAudit }),
    ...(model === undefined ? {} : { model }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(endpoint === undefined ? {} : { utilityEndpoint: endpoint }),
  })
  const token = randomBytes(32).toString('hex')
  const policy:FrontendPolicy={mode:'sandbox',origin:'',revision:0}
  const approved=process.env.PERSPECTRA_FRONTEND_APPROVED_SHA256
  const trustedAssets=approved&&packWeb?.digest===approved&&process.send ? createTrustedFrontendServer(packWeb,policy,()=>hostOrigin) : undefined
  let hostOrigin=''
  const server = createPlaytestServer(runtime, token, packWeb, policy)
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    const closingRuntime = runtime.close()
    if (server.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => error === undefined ? resolveClose() : rejectClose(error))
        server.closeAllConnections()
      })
    }
    if(trustedAssets?.listening){trustedAssets.closeAllConnections();await new Promise<void>(done=>trustedAssets.close(()=>done()))}
    await closingRuntime
  }
  process.once('SIGINT', () => { void close().then(() => { process.exitCode = 0 }) })
  process.once('SIGTERM', () => { void close().then(() => { process.exitCode = 0 }) })
  process.on('message', message => {
    if (message !== null && typeof message === 'object' && 'type' in message && message.type === 'story-save'
      && 'requestId' in message && typeof message.requestId === 'string' && 'title' in message && typeof message.title === 'string') {
      const requestId = message.requestId
      void runtime.saveNode(message.title).then(node => process.send?.({type:'story-saved', requestId, node}))
        .catch(error => process.send?.({type:'story-save-failed', requestId, message:error instanceof PlaytestBusyError ? error.message : '节点保存失败，原故事线保留。'}))
    }
    if(message!==null&&typeof message==='object'&&'type' in message&&message.type==='frontend-revoke'){
      policy.mode='sandbox';policy.revision++
      process.send?.({type:'frontend-revoked'})
    }

    if (message !== null && typeof message === 'object' && 'type' in message && message.type === 'shutdown') {
      void close().then(() => { process.exitCode = 0; process.disconnect?.() }).catch(error => {
        console.error('本机试玩页关闭失败：', error instanceof Error ? error.message : '未知错误')
        process.exitCode = 1
      })
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  hostOrigin='http://127.0.0.1:'+port
  if(trustedAssets){
    trustedAssets.listen(0,'127.0.0.1');await once(trustedAssets,'listening')
    policy.origin='http://127.0.0.1:'+(trustedAssets.address() as AddressInfo).port
    policy.mode='trusted'
  }
  process.send?.({ type: 'ready', port, token, frontendMode:policy.mode })
  process.stdout.write(`\n本机试玩页已启动：\nhttp://127.0.0.1:${port}/#token=${token}\n\n`)
  process.stdout.write(`世界数据：${dataDirectory}\nProvider：${provider}\n模型：${model?.trim() || (provider === 'local' ? 'gemini-3.7-flash' : provider === 'deepseek' ? 'deepseek-flash' : 'qwen3:4b')}\n按 Ctrl+C 安全关闭。\n`)
  if (launch.memoryCore) process.stdout.write('实验 Core 记忆已开启；可在宿主页启动或取消后台整理，整理期间可以继续游玩。未整理时长期交付为空。\n')
  if (packPath !== undefined) process.stdout.write(`World Pack：${packPath}\n`)
}

try {
  await main()
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : '未知错误'
  process.send?.({ type: 'startup-error', message }, () => process.disconnect?.())
  console.error('本机试玩页启动失败：', message)
  process.exitCode = 1
}
