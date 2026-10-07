import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PLAYTEST_TUNING, parsePlaytestTuning, type PlaytestTuning } from '../tests/experiments/playtest-tuning.ts'

interface PackInfo { readonly path: string; readonly id: string; readonly title: string }
interface SaveInfo { readonly id: string; readonly name: string; readonly packPath: string; readonly createdAt: string }
interface ModelChoice { readonly provider: 'local' | 'ollama' | 'deepseek'; readonly model: string; readonly endpoint: string }
interface LaunchRequest extends ModelChoice { readonly packPath: string; readonly saveId?: string; readonly saveName?: string; readonly tuning: PlaytestTuning }
interface Settings { readonly packs: readonly string[]; readonly saves: readonly SaveInfo[]; readonly model: ModelChoice; readonly tuning?: PlaytestTuning }
interface BackendReady { readonly type: 'ready'; readonly port: number; readonly token: string }

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const smoke = process.env.HCW_DESKTOP_SMOKE === '1'
if (smoke) app.setPath('userData', join(repository, '.tmp', 'desktop-smoke-user'))
const nodeExecutable = app.isPackaged ? process.execPath : (process.env.HCW_DESKTOP_NODE?.trim() || 'node')
const runFile = promisify(execFile)
const defaultModel: ModelChoice = { provider: 'local', model: 'gemini-3.7-flash', endpoint: 'http://127.0.0.1:8045/v1/chat/completions' }
const featuredPack = join(repository, 'examples', 'world-packs', 'ai-girls-awaken-v10')
let window: BrowserWindow
let backend: ChildProcess | undefined
let activeUrl: string | undefined
let lastError = ''
let stopping: Promise<void> | undefined

function settingsPath(): string { return join(app.getPath('userData'), 'launcher.json') }
function savesRoot(): string { return join(app.getPath('userData'), 'saves') }

async function settings(): Promise<Settings> {
  try {
    const value = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<Settings>
    if (!Array.isArray(value.packs) || !Array.isArray(value.saves) || !value.model) throw new Error('invalid settings')
    return value as Settings
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { packs: [featuredPack], saves: [], model: defaultModel, tuning: DEFAULT_PLAYTEST_TUNING }
    }
    throw new Error('启动器配置损坏，请检查 launcher.json。', { cause: error })
  }
}

async function saveSettings(value: Settings): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  const temporary = `${settingsPath()}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temporary, settingsPath())
}

function packInfo(packPath: string): PackInfo {
  const path = resolve(packPath)
  const source = JSON.parse(readFileSync(join(path, 'worldpack.source.json'), 'utf8')) as {
    sourceSchemaVersion?: string; packId?: string; worldFile?: string
  }
  if (source.sourceSchemaVersion !== 'worldpack-source/v5' || !source.packId || !source.worldFile) {
    throw new Error('请选择有效的 worldpack-source/v5 世界包目录。')
  }
  const world = JSON.parse(readFileSync(join(path, source.worldFile), 'utf8')) as { title?: string }
  return { path, id: source.packId, title: world.title || source.packId }
}

function visiblePacks(paths: readonly string[]): PackInfo[] {
  return paths.flatMap(path => { try { return [packInfo(path)] } catch { return [] } })
}

function requireLauncher(event: Electron.IpcMainInvokeEvent): void {
  if (event.sender !== window.webContents) throw new Error('启动器操作仅在启动页可用。')
}

function modelChoice(value: LaunchRequest): ModelChoice {
  if (!['local', 'ollama', 'deepseek'].includes(value.provider)) throw new Error('模型服务类型无效。')
  const model = value.model?.trim()
  if (!model || model.length > 120) throw new Error('模型名称无效。')
  const endpoint = value.endpoint?.trim() || ''
  if (value.provider !== 'deepseek') {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型地址必须是 HTTP 或 HTTPS。')
  }
  return { provider: value.provider, model, endpoint }
}

async function preflight(packPath: string, dataDirectory: string): Promise<void> {
  const script = app.isPackaged
    ? join(repository, 'dist', 'backend', 'save-preflight.mjs')
    : join(repository, 'desktop', 'save-preflight-entry.ts')
  const args = app.isPackaged ? [script, packPath, dataDirectory]
    : ['--import', 'tsx', script, packPath, dataDirectory]
  try {
    await runFile(nodeExecutable, args, {
      cwd: repository, windowsHide: true, timeout: 60_000, maxBuffer: 128 * 1024,
      env: app.isPackaged ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
    })
  } catch (error: unknown) {
    const detail = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.trim().split('\n').at(-1) : undefined
    throw new Error(detail || '世界包或存档预检失败。')
  }
}

function launchBackend(packPath: string, dataDirectory: string, model: ModelChoice, tuning: PlaytestTuning): Promise<BackendReady> {
  if (backend) throw new Error('已有游戏正在运行。')
  const entry = app.isPackaged
    ? join(repository, 'dist', 'backend', 'playtest.mjs')
    : join(repository, 'tests', 'experiments', 'playtest-web-entry.ts')
  const arguments_ = [...(app.isPackaged ? [] : ['--import', 'tsx']), entry,
    '--pack', packPath, '--data-dir', dataDirectory, '--tuning', JSON.stringify(tuning)]
  if (model.provider === 'ollama') arguments_.push('--ollama')
  if (model.provider === 'deepseek') arguments_.push('--deepseek')
  const env: NodeJS.ProcessEnv = { ...process.env, ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
  if (model.provider === 'local') { env.HCW_LOCAL_MODEL = model.model; env.HCW_LOCAL_ENDPOINT = model.endpoint }
  if (model.provider === 'ollama') { env.HCW_OLLAMA_MODEL = model.model; env.HCW_OLLAMA_ENDPOINT = model.endpoint }
  if (model.provider === 'deepseek') env.HCW_DEEPSEEK_MODEL = model.model
  const child = spawn(nodeExecutable, arguments_, {
    cwd: repository, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  backend = child
  child.stdout?.resume()
  child.stderr?.resume()
  child.once('exit', (code, signal) => {
    if (backend !== child) return
    backend = undefined
    activeUrl = undefined
    if (!stopping && !smoke) lastError = `游戏进程已退出（${signal ?? code ?? '未知原因'}）。`
  })
  return new Promise<BackendReady>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => { child.kill(); finish(new Error('游戏启动超时。')) }, 60_000)
    const finish = (error?: Error, ready?: BackendReady) => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) rejectReady(error)
      else resolveReady(ready!)
    }
    const onMessage = (value: unknown) => {
      if (value && typeof value === 'object' && 'type' in value) {
        if (value.type === 'startup-error') {
          finish(new Error('message' in value && typeof value.message === 'string' ? value.message : '游戏启动失败。'))
        } else if (value.type === 'ready' && 'port' in value && 'token' in value
          && typeof value.port === 'number' && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
          && typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token)) {
          finish(undefined, value as BackendReady)
        }
      }
    }
    const onError = (error: Error) => finish(error)
    const onExit = () => finish(new Error('游戏进程在就绪前退出。'))
    child.on('message', onMessage)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function stopBackend(): Promise<void> {
  if (stopping) return stopping
  const child = backend
  if (!child) return
  stopping = new Promise<void>(resolveStop => {
    if (child.exitCode !== null || child.signalCode !== null) { resolveStop(); return }
    const timer = setTimeout(() => { child.kill(); resolveStop() }, 10_000)
    child.once('exit', () => { clearTimeout(timer); resolveStop() })
    child.send?.({ type: 'shutdown' })
  }).finally(() => { if (backend === child) backend = undefined; activeUrl = undefined; stopping = undefined })
  return stopping
}

async function openGame(): Promise<void> {
  if (!backend || !activeUrl) throw new Error('游戏尚未启动。')
  await shell.openExternal(activeUrl)
}

async function startGame(request: LaunchRequest): Promise<void> {
  const current = await settings()
  const pack = packInfo(request.packPath)
  const model = modelChoice(request)
  const tuning = parsePlaytestTuning(request.tuning)
  const save = request.saveId ? current.saves.find(item => item.id === request.saveId) : undefined
  if (request.saveId && !save) throw new Error('所选存档不存在。')
  const id = save?.id ?? randomUUID()
  const dataDirectory = join(savesRoot(), id)
  if (!save) await mkdir(dataDirectory, { recursive: false })
  await preflight(pack.path, dataDirectory)
  const ready = await launchBackend(pack.path, dataDirectory, model, tuning)
  const updated: Settings = {
    packs: [pack.path, ...current.packs.filter(path => path !== pack.path)],
    saves: save ? current.saves.map(item => item.id === save.id ? { ...item, packPath: pack.path } : item) : [...current.saves, {
      id, name: request.saveName?.trim().slice(0, 80) || pack.title,
      packPath: pack.path, createdAt: new Date().toISOString(),
    }],
    model, tuning,
  }
  try {
    await saveSettings(updated)
    lastError = ''
    activeUrl = `http://127.0.0.1:${ready.port}/#token=${ready.token}`
  } catch (error) {
    await stopBackend()
    throw error
  }
  if (!smoke) {
    try { await openGame() }
    catch (error: unknown) {
      lastError = `游戏已启动，但未能打开默认浏览器：${error instanceof Error ? error.message : '未知错误'}`
    }
  }
}

async function main(): Promise<void> {
  await mkdir(savesRoot(), { recursive: true })
  window = new BrowserWindow({
    width: 1080, height: 780, minWidth: 780, minHeight: 560, show: !smoke,
    backgroundColor: '#10151d', autoHideMenuBar: true,
    webPreferences: {
      preload: join(repository, 'dist', 'desktop', 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.on('close', event => {
    if (backend) {
      event.preventDefault()
      void stopBackend().then(() => window.destroy())
    }
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '游戏', submenu: [
    { label: '在浏览器中打开', click: () => { void openGame().then(() => { lastError = '' }).catch(error => { lastError = error instanceof Error ? error.message : '浏览器打开失败。' }) } },
    { label: '停止游戏', click: () => { void stopBackend() } },
    { role: 'quit', label: '退出' },
  ] }]))
  ipcMain.handle('desktop:state', async event => {
    requireLauncher(event)
    const current = await settings()
    return { packs: visiblePacks([featuredPack, ...current.packs.filter(path => path !== featuredPack)]), saves: current.saves, model: current.model, tuning: current.tuning ?? DEFAULT_PLAYTEST_TUNING, error: lastError, running: backend !== undefined && activeUrl !== undefined }
  })
  ipcMain.handle('desktop:choose-pack', async event => {
    requireLauncher(event)
    const chosen = await dialog.showOpenDialog(window, {
      title: '选择 v5 世界包目录', defaultPath: join(repository, 'examples', 'world-packs'),
      properties: ['openDirectory'],
    })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    return packInfo(chosen.filePaths[0])
  })
  ipcMain.handle('desktop:start', async (event, value: LaunchRequest) => {
    requireLauncher(event)
    try { await startGame(value) }
    catch (error: unknown) {
      lastError = error instanceof Error ? error.message : '游戏启动失败。'
      throw error
    }
  })
  ipcMain.handle('desktop:open', async event => {
    requireLauncher(event)
    try { await openGame(); lastError = '' }
    catch (error: unknown) { lastError = error instanceof Error ? error.message : '浏览器打开失败。'; throw error }
  })
  ipcMain.handle('desktop:stop', async event => { requireLauncher(event); await stopBackend(); lastError = '' })
  await window.loadFile(join(repository, 'desktop', 'index.html'))
  if (smoke) {
    await writeFile(join(app.getPath('userData'), 'smoke-stage.txt'), 'launcher loaded')
    const launcher = await window.webContents.executeJavaScript(
      'window.desktopAPI.state().then(value => ({ ready: !!document.getElementById("pack"), featured: value.packs.some(pack => pack.id === "pack:ai-girls-awaken"), saves: value.saves.length }))',
    ) as { ready: boolean; featured: boolean; saves: number }
    await startGame({
      packPath: process.env.HCW_DESKTOP_SMOKE_PACK ? resolve(process.env.HCW_DESKTOP_SMOKE_PACK) : featuredPack,
      provider: 'ollama', model: 'qwen3:4b', endpoint: 'http://127.0.0.1:11434/api/chat',
      saveName: '桌面冒烟', tuning: DEFAULT_PLAYTEST_TUNING,
    })
    await writeFile(join(app.getPath('userData'), 'smoke-stage.txt'), 'game started')
    const gameUrl = new URL(activeUrl!)
    const page = await (await fetch(gameUrl.origin)).text()
    const response = await fetch(`${gameUrl.origin}/api/state`, {
      headers: { 'x-playtest-token': gameUrl.hash.slice('#token='.length) },
    })
    if (!response.ok) throw new Error('游戏服务没有返回玩家状态。')
    const state = await response.json() as {
      world: { title: string }
      availableActions?: readonly { actionType: string; destinations?: readonly unknown[]; interactions?: readonly unknown[] }[]
    }
    const game = {
      title: state.world.title,
      choices: (state.availableActions ?? []).reduce((count, action) =>
        count + (action.destinations?.length ?? 0) + (action.interactions?.length ?? 0), 0),
      browserSeparate: await window.webContents.executeJavaScript('document.title === "Cordis World 启动器"') as boolean,
      customPage: page.includes('CORDIS WORLD · AI GIRLS'),
    }
    const launcherRunning = await window.webContents.executeJavaScript('window.desktopAPI.state().then(value => value.running)') as boolean
    await window.webContents.executeJavaScript('window.desktopAPI.stop()')
    const stopped = await window.webContents.executeJavaScript('window.desktopAPI.state().then(value => !value.running)') as boolean
    const result = { launcher, game: { ...game, launcherRunning, stopped } }
    await writeFile(join(app.getPath('userData'), 'smoke-result.json'), JSON.stringify(result))
    process.stdout.write(JSON.stringify({ desktopSmoke: result }) + '\n')
    window.destroy()
    app.quit()
  }
}

app.whenReady().then(main).catch(error => {
  if (smoke) {
    void writeFile(join(app.getPath('userData'), 'smoke-error.txt'), error instanceof Error ? error.stack ?? error.message : String(error))
      .finally(() => app.quit())
    return
  }
  dialog.showErrorBox('启动器启动失败', error instanceof Error ? error.message : '未知错误')
  app.quit()
})
app.on('window-all-closed', () => app.quit())
