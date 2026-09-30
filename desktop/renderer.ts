interface PackInfo { readonly path: string; readonly id: string; readonly title: string }
interface SaveInfo { readonly id: string; readonly name: string; readonly packPath: string; readonly createdAt: string }
interface ModelChoice { readonly provider: 'local' | 'ollama' | 'deepseek'; readonly model: string; readonly endpoint: string }
import type { PlaytestTuning } from '../tests/experiments/playtest-tuning.ts'
interface LaunchRequest extends ModelChoice { readonly packPath: string; readonly saveId?: string; readonly saveName?: string; readonly tuning: PlaytestTuning }
interface LauncherState { readonly packs: readonly PackInfo[]; readonly saves: readonly SaveInfo[]; readonly model: ModelChoice; readonly tuning: PlaytestTuning; readonly error: string; readonly running: boolean }

declare global {
  interface Window {
    desktopAPI: {
      state(): Promise<LauncherState>
      choosePack(): Promise<PackInfo | null>
      start(request: LaunchRequest): Promise<void>
      open(): Promise<void>
      stop(): Promise<void>
    }
  }
}

const element = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing launcher element: ${id}`)
  return node as T
}
const packSelect = element<HTMLSelectElement>('pack')
const saveSelect = element<HTMLSelectElement>('save')
const providerSelect = element<HTMLSelectElement>('provider')
const modelInput = element<HTMLInputElement>('model')
const endpointInput = element<HTMLInputElement>('endpoint')
const nameInput = element<HTMLInputElement>('save-name')
const tuningInputs = {
  maximumWaves: element<HTMLInputElement>('maximum-waves'),
  maximumNpcCalls: element<HTMLInputElement>('maximum-npc-calls'),
  maximumCallsPerCharacter: element<HTMLInputElement>('maximum-calls-per-character'),
  reactionDeadlineSeconds: element<HTMLInputElement>('reaction-deadline-seconds'),
  recentObservations: element<HTMLInputElement>('recent-observations'),
  recentSelfObservations: element<HTMLInputElement>('recent-self-observations'),
} as const
function readTuning(): PlaytestTuning {
  for (const input of Object.values(tuningInputs)) {
    if (input.value.trim() === '' || !input.checkValidity()) throw new Error('请填写有效的运行参数。')
  }
  return {
    maximumWaves: Number(tuningInputs.maximumWaves.value),
    maximumNpcCalls: Number(tuningInputs.maximumNpcCalls.value),
    maximumCallsPerCharacter: Number(tuningInputs.maximumCallsPerCharacter.value),
    reactionDeadlineSeconds: Number(tuningInputs.reactionDeadlineSeconds.value),
    recentObservations: Number(tuningInputs.recentObservations.value),
    recentSelfObservations: Number(tuningInputs.recentSelfObservations.value),
  }
}
const status = element<HTMLSpanElement>('status')
const packPath = element<HTMLParagraphElement>('pack-path')
const startButton = element<HTMLButtonElement>('start')
const chooseButton = element<HTMLButtonElement>('choose-pack')
const openButton = element<HTMLButtonElement>('open-game')
const stopButton = element<HTMLButtonElement>('stop-game')
let packs: PackInfo[] = []
let saves: readonly SaveInfo[] = []
let running = false
let changing = false
const defaults: Record<ModelChoice['provider'], Pick<ModelChoice, 'model' | 'endpoint'>> = {
  local: { model: 'gemini-3.7-flash', endpoint: 'http://127.0.0.1:8045/v1/chat/completions' },
  ollama: { model: 'qwen3:4b', endpoint: 'http://127.0.0.1:11434/api/chat' },
  deepseek: { model: 'deepseek-flash', endpoint: '' },
}

function option(value: string, label: string): HTMLOptionElement {
  const entry = document.createElement('option')
  entry.value = value
  entry.textContent = label
  return entry
}
function showStatus(message: string, error = false): void {
  status.textContent = message
  status.classList.toggle('error', error)
}
function renderSaves(): void {
  const previous = saveSelect.value
  saveSelect.replaceChildren(option('', '新建存档'))
  for (const save of saves) {
    saveSelect.append(option(save.id, `${save.name} · ${save.packPath.split(/[\\/]/).at(-1)} · ${new Date(save.createdAt).toLocaleDateString()}`))
  }
  if ([...saveSelect.options].some(item => item.value === previous)) saveSelect.value = previous
  nameInput.disabled = saveSelect.value !== ''
}
function renderSession(state: LauncherState): void {
  running = state.running
  startButton.disabled = !packSelect.value || running || changing
  openButton.hidden = !running
  stopButton.hidden = !running
  if (!changing) showStatus(state.error || (running ? '游戏运行中，网页已交给默认浏览器。' : '可以启动游戏。'), !!state.error)
}
function renderPacks(selected?: string): void {
  packSelect.replaceChildren()
  if (packs.length === 0) packSelect.append(option('', '请先选择世界包目录'))
  else for (const pack of packs) packSelect.append(option(pack.path, `${pack.title} (${pack.id})`))
  if (selected) packSelect.value = selected
  packPath.textContent = packSelect.value || '选择 worldpack-source/v5 源目录。'
  renderSaves()
  startButton.disabled = !packSelect.value || running
}

packSelect.addEventListener('change', () => renderPacks(packSelect.value))
saveSelect.addEventListener('change', () => { nameInput.disabled = saveSelect.value !== '' })
providerSelect.addEventListener('change', () => {
  const provider = providerSelect.value as ModelChoice['provider']
  modelInput.value = defaults[provider].model
  endpointInput.value = defaults[provider].endpoint
  endpointInput.disabled = provider === 'deepseek'
})
chooseButton.addEventListener('click', async () => {
  try {
    const chosen = await window.desktopAPI.choosePack()
    if (!chosen) return
    packs = [chosen, ...packs.filter(item => item.path !== chosen.path)]
    renderPacks(chosen.path)
    showStatus('')
  } catch (error: unknown) {
    showStatus(error instanceof Error ? error.message : '世界包选择失败。', true)
  }
})
startButton.addEventListener('click', async () => {
  const packPath = packSelect.value
  if (!packPath) return
  changing = true
  startButton.disabled = true
  showStatus('正在检查世界包和存档，然后打开默认浏览器……')
  try {
    await window.desktopAPI.start({
      packPath, provider: providerSelect.value as ModelChoice['provider'],
      model: modelInput.value, endpoint: endpointInput.value, tuning: readTuning(),
      ...(saveSelect.value ? { saveId: saveSelect.value } : { saveName: nameInput.value }),
    })
    saves = (await window.desktopAPI.state()).saves
    renderSaves()
  } catch (error: unknown) {
    showStatus(error instanceof Error ? error.message : '游戏启动失败。', true)
  } finally {
    changing = false
    try { renderSession(await window.desktopAPI.state()) }
    catch (error: unknown) { showStatus(error instanceof Error ? error.message : '启动器状态读取失败。', true) }
  }
})
openButton.addEventListener('click', async () => {
  try { await window.desktopAPI.open(); showStatus('已请求默认浏览器打开游戏。') }
  catch (error: unknown) { showStatus(error instanceof Error ? error.message : '浏览器打开失败。', true) }
})
stopButton.addEventListener('click', async () => {
  changing = true
  showStatus('正在停止游戏……')
  try { await window.desktopAPI.stop() }
  catch (error: unknown) { showStatus(error instanceof Error ? error.message : '停止游戏失败。', true) }
  finally {
    changing = false
    try { renderSession(await window.desktopAPI.state()) }
    catch (error: unknown) { showStatus(error instanceof Error ? error.message : '启动器状态读取失败。', true) }
  }
})

void window.desktopAPI.state().then(state => {
  packs = [...state.packs]
  saves = state.saves
  renderPacks()
  providerSelect.value = state.model.provider
  modelInput.value = state.model.model
  endpointInput.value = state.model.endpoint
  endpointInput.disabled = state.model.provider === 'deepseek'
  for (const key of Object.keys(tuningInputs) as (keyof PlaytestTuning)[]) tuningInputs[key].value = String(state.tuning[key])
  renderSession(state)
}).catch(error => showStatus(error instanceof Error ? error.message : '启动器配置读取失败。', true))
setInterval(() => { if (!changing) void window.desktopAPI.state().then(renderSession).catch(() => {}) }, 1500)

export {}
