import { DEFAULT_PLAY_SETTINGS, DEFAULT_READING, DEFAULT_AUDIO, DEFAULT_PALETTE, type PlaySettings, type ReadingPreferences, type AudioPreferences, type Palette } from '../../../../desktop/play-settings.ts'
import { isTauri } from '@tauri-apps/api/core'
import { coreRequest, openGame, openCreator as openCreatorPage, packCover, listConnectionModels, setConnectionKey, connectionKeyStatus } from '../services/desktop.ts'
import type { CoreSnapshot, RolePreset, PresetChoice, ModelConnection, InstanceModels } from '../core-types.ts'
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { packages as fixtures, modelProfiles, createMockInstance, createFreshInstance, mockCharacters } from '../mock.ts'
import { availableModel, historyTo } from '../domain.ts'
import type { CoreStatus, GamePackage } from '../types.ts'

export const useLauncherStore = defineStore('launcher', () => {
  const packages = ref<GamePackage[]>(isTauri() ? [] : [...fixtures])
  const instances = ref<import('../types.ts').GameInstance[]>(isTauri() ? [] : [createMockInstance(), createFreshInstance('quiet-town', '0.8.2', '新的旅程'), createFreshInstance('last-light', '0.3.0', '第一次游玩')])
  const profiles = ref([...modelProfiles])
  const selectedPackageId = ref('snow-inn')
  const selectedInstanceId = ref(instances.value[0]?.id ?? '')
  const core = ref<CoreStatus>({ state: 'idle', mode: isTauri() ? 'real' : 'mock' })
  const connections = ref<ModelConnection[]>([])
  /** Which connections have a key in the OS credential store; the keys themselves never reach the page. */
  const storedKeys = ref(new Set<string>())
  const mockKeys = new Map<string, string>()
  const modelLists = ref<Record<string, { models: string[]; error?: string; loading: boolean }>>({})
  const lastModels = ref<InstanceModels | undefined>()
  const globalDefaultModelId = ref<string | null>('flash')
  const dataDirectory = ref('')
  const largeText = ref(false)
  const reading = ref({...DEFAULT_READING})
  const audio = ref({...DEFAULT_AUDIO})
  const packagePlaySettings = ref<Record<string,PlaySettings>>({})
  const currentPlaySettings = computed(()=>packagePlaySettings.value[selectedPackageId.value]??DEFAULT_PLAY_SETTINGS)
  const theme = ref<'system' | 'light' | 'dark'>('system')
  const palette = ref<Palette>(DEFAULT_PALETTE)
  const notice = ref('')
  const selectedPackage = computed(() => packages.value.find(pack => pack.id === selectedPackageId.value))
  const currentInstance = computed(() => instances.value.find(instance => instance.id === selectedInstanceId.value))
  const currentStoryline = computed(() => currentInstance.value?.storylines.find(line => line.id === currentInstance.value?.currentStorylineId))
  const currentNode = computed(() => currentInstance.value?.nodes.find(node => node.id === currentStoryline.value?.currentNodeId))
  const currentModel = computed(() => availableModel(currentInstance.value?.model.defaultModelId ?? null, profiles.value))
  const currentHistory = computed(() => currentInstance.value && currentStoryline.value?.currentNodeId ? historyTo(currentInstance.value.nodes, currentStoryline.value.currentNodeId) : [])
  const gameInstances = computed(() => instances.value.filter(instance => instance.packageId === selectedPackageId.value))
  function selectPackage(id: string) { if (core.value.state === 'running' || busy.value) return
    selectedPackageId.value = id
    selectedInstanceId.value = instances.value.find(instance => instance.packageId === id)?.id ?? ''
  }
  async function newInstance(name: string) { if (real) {
      let models: InstanceModels | undefined
      const first = connections.value[0]
      // Same rule as Core: a remembered choice only counts while its connection still exists.
      const remembered = lastModels.value && connections.value.some(c => c.id === lastModels.value!.decision.connectionId) && (!lastModels.value.memory || connections.value.some(c => c.id === lastModels.value!.memory!.connectionId))
      if (!remembered && first) {
        await refreshModels(first.id)
        const model = modelLists.value[first.id]?.models[0]
        if (model) models = { decision: { connectionId: first.id, model } }
      }
      if (await action('create', { packageId: selectedPackageId.value, name, ...(models ? { models } : {}) })) {
        selectedInstanceId.value = instances.value.at(-1)?.id ?? ''
        notice.value = connections.value.length ? '已创建独立实例。' : '已创建独立实例；请先在模型设置添加连接，再到模型配置选择模型。'
      }
      return }
    const pack = selectedPackage.value
    if (!pack) return
    const instance = createFreshInstance(pack.id, pack.version, name)
    instance.model.defaultModelId = globalDefaultModelId.value
    instances.value.push(instance)
    selectedInstanceId.value = instance.id
  }
  function loadMockPackage(pack: GamePackage) {
    if (!packages.value.some(existing => existing.id === pack.id)) packages.value.push(pack)
    if (!instances.value.some(instance => instance.packageId === pack.id)) {
      const instance = createFreshInstance(pack.id, pack.version, '第一次游玩')
      instance.model.defaultModelId = globalDefaultModelId.value
      instances.value.push(instance)
    }
    selectPackage(pack.id)
    notice.value = '已载入示例游戏包；本阶段未读取或校验实际包内容。'
  }
  function forkAt(nodeId: string, name: string) {
    const instance = currentInstance.value
    const parent = currentStoryline.value
    const node = currentHistory.value.find(node => node.id === nodeId)
    if (!instance || !parent || !node) throw new Error('请选择当前故事历史中的节点。')
    const id = crypto.randomUUID()
    instance.storylines.push({
      id, name, parentStorylineId: parent.id, parentNodeId: node.id, currentNodeId: node.id,
      source: { kind: 'local', label: parent.name, storylineId: parent.id, nodeId: node.id, turn: node.turn },
    })
    instance.currentStorylineId = id
    notice.value = '已创建新故事线，原故事与后续历史完整保留。'
  }
  function importMockStory() {
    const pack = selectedPackage.value
    if (!pack) return
    const instance = createMockInstance(pack.id, pack.version, '从朋友的故事继续')
    instance.model = { defaultModelId: globalDefaultModelId.value, overridesEnabled: false, groups: {}, characters: {} }
    instance.storylines[0]!.source = { kind: 'shared', label: '示例玩家的故事线', storylineId: 'shared-main', nodeId: 'shared-173', turn: 173 }
    instance.storylines[0]!.currentNodeId = instance.nodes[2]!.id
    instances.value.push(instance)
    selectedInstanceId.value = instance.id
    notice.value = '已创建独立的示例导入实例，可查看历史并从过去的节点开始。'
  }
  function startMock() {
    if (selectedPackage.value?.validation.status === 'blocked' || !currentModel.value || !currentInstance.value || !currentStoryline.value) return
    currentInstance.value.lastPlayedAt = new Date().toISOString()
    core.value = { state: 'running', mode: 'mock', instanceId: currentInstance.value.id, storylineId: currentStoryline.value.id }
    notice.value = '模拟启动完成。真实 Core 和游戏前端尚未接入。'
  }
  function stopMock() { core.value = { state: 'idle', mode: isTauri() ? 'real' : 'mock' }; notice.value = '模拟会话已结束。' }

  const real = isTauri()
  const busy = ref(false)
  const initialized = ref(!real)
  const realInstances = ref<CoreSnapshot['instances']>([])
  const currentRealInstance = computed(() => realInstances.value.find(i => i.id === selectedInstanceId.value))
  // Mock mode keeps choices in memory so the dialog's save and summary can be checked without Core.
  const mockModels = ref<Record<string, InstanceModels>>({})
  const currentModels = computed(() => real ? currentRealInstance.value?.models : mockModels.value[selectedInstanceId.value])
  const connectionName = (id: string) => connections.value.find(c => c.id === id)?.name
  const presets=ref<CoreSnapshot['presets']>({library:[],characters:{},global:{},instances:{},recommended:{}})
  const presetCharacters=computed(()=>presets.value.characters[selectedPackageId.value]??(real?[]:mockCharacters))
  const effectivePreset=computed(()=>{const choice=presets.value.instances[selectedInstanceId.value];return choice?.mode==='custom'?choice.override:choice?.mode==='global'?presets.value.global:{...presets.value.global,...presets.value.recommended[selectedPackageId.value]}})
  async function inspectPreset(){return action('preset-inspect')}
  async function saveGlobalPreset(preset:RolePreset){return action('preset-global',{preset})}
  async function saveInstancePreset(choice:PresetChoice){return action('preset-instance',{instanceId:selectedInstanceId.value,choice})}
  async function savePresetDrafts(global:RolePreset,choice:PresetChoice){return action('preset-save',{instanceId:selectedInstanceId.value,global,choice})}
  async function libraryAction(operation:string,data:Record<string,unknown>){return action(operation,data)}
  const frontends=ref<CoreSnapshot['frontends']>({})
  const currentFrontend=computed(()=>frontends.value[selectedInstanceId.value])
  async function inspectFrontend(){return action('frontend-inspect',{instanceId:selectedInstanceId.value})}
  async function grantFrontend(expectedDigest:string,confirmed:boolean){
    if(!await action('frontend-grant',{instanceId:selectedInstanceId.value,expectedDigest,confirmed}))return false
    notice.value='已授权此实例的当前前端；内容变化后需重新确认。';return true
  }
  async function revokeFrontend(){
    if(!await action('frontend-revoke',{instanceId:selectedInstanceId.value}))return false
    notice.value='前端授权已撤销，恢复沙箱；运行中的页面将切换官方默认模板。';return true
  }
  const artworks = ['inn', 'town', 'sea'] as const
  /** 封面只在首次出现时单独读取一次，避免随 2.5 秒快照轮询反复传输图片。 */
  const covers = ref<Record<string, string>>({})
  async function loadCover(id: string) {
    covers.value[id] = ''
    try { const url = await packCover(id); if (url) { covers.value[id] = url; packages.value = packages.value.map(p => p.id === id ? { ...p, cover: url } : p) } }
    catch { /* 封面只是展示资源；读取失败时保留排版封面。 */ }
  }
  function applySnapshot(snapshot: CoreSnapshot) {
    presets.value=snapshot.presets??{library:[],characters:{},global:{},instances:{},recommended:{}}
    frontends.value=snapshot.frontends
    realInstances.value = snapshot.instances
    connections.value = snapshot.connections ?? []
    lastModels.value = snapshot.lastModels
    largeText.value = snapshot.preferences?.largeText ?? false
    theme.value = snapshot.preferences?.theme ?? 'system'
    palette.value = snapshot.preferences?.palette ?? DEFAULT_PALETTE
    reading.value = snapshot.preferences?.reading ?? {...DEFAULT_READING}
    audio.value = snapshot.preferences?.audio ?? {...DEFAULT_AUDIO}
    packagePlaySettings.value = snapshot.playSettings??{}
    dataDirectory.value = snapshot.dataDirectory
    for (const [id, detail] of Object.entries(snapshot.packDetails ?? {})) if (!detail.hasCover) delete covers.value[id]
    packages.value = snapshot.packs.map((p, index) => {
      const detail = snapshot.packDetails?.[p.id]
      return { id: p.id, version: p.version, title: p.title, subtitle: '', description: detail?.description ?? '',
        genre: '', artwork: artworks[index % artworks.length]!, ...(covers.value[p.id] ? { cover: covers.value[p.id] } : {}), recommendation: { capability: 'balanced', contextTokens: 0, toolCalling: true },
        validation: { status: detail?.error ? 'blocked' : 'ready', issues: detail?.error ? [detail.error] : [], simulated: false } }
    })
    profiles.value = snapshot.instances.flatMap(i => i.models ? [{ id: i.id, label: i.models.decision.model, model: i.models.decision.model, providerId: i.models.decision.connectionId, capability: 'balanced' as const, contextTokens: 0, toolCalling: true }] : [])
    instances.value = snapshot.instances.map(i => ({ ...i, model: { defaultModelId: i.id, overridesEnabled: false, groups: {}, characters: {} }, currentStorylineId: i.currentStorylineId ?? 'main',
      storylines: i.storylines ?? [{ id: 'main', name: '主故事线', parentStorylineId: null, parentNodeId: null, currentNodeId: 'head', source: { kind: 'original', label: '本地实例', storylineId: null, nodeId: null, turn: 0 } }],
      nodes: i.nodes ?? [{ id: 'head', parentNodeId: null, title: i.lastPlayedAt ? '已保存的世界进度' : '新的旅程', summary: '', turn: 0, createdAt: '' }], localSettings: { textSize: 'standard' } }))
    core.value = snapshot.core
    for (const [id, detail] of Object.entries(snapshot.packDetails ?? {})) if (detail.hasCover && !(id in covers.value)) void loadCover(id)
    if (!packages.value.some(p => p.id === selectedPackageId.value)) selectedPackageId.value = packages.value[0]?.id ?? ''
    if (!instances.value.some(i => i.id === selectedInstanceId.value && i.packageId === selectedPackageId.value)) selectedInstanceId.value = instances.value.find(i => i.packageId === selectedPackageId.value)?.id ?? ''
  }
  async function action(operation: string, data: Record<string, unknown> = {}): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try { applySnapshot(await coreRequest(operation, data)); return true }
    catch (error) { notice.value = typeof error === 'string' ? error : error instanceof Error ? error.message : '本机操作失败，请重试。'; return false }
    finally { busy.value = false }
  }
  async function initialize() {
    if (!real) return
    if (await action('snapshot')) { initialized.value = true; await refreshKeyStatus() }
  }
  async function refreshKeyStatus() {
    try { storedKeys.value = new Set(await connectionKeyStatus(connections.value.map(c => c.id))) }
    catch { /* Status is a hint only; starting still reads the store directly. */ }
  }
  async function saveConnection(connection: ModelConnection, apiKey?: string): Promise<boolean> {
    const previous = connections.value.find(c => c.id === connection.id)
    const origin = (endpoint: string) => { try { return new URL(endpoint).origin } catch { return endpoint } }
    const moved = previous !== undefined && origin(previous.endpoint) !== origin(connection.endpoint)
    if (real) { if (!await action('connection-save', { connection })) return false }
    else connections.value = connections.value.some(c => c.id === connection.id) ? connections.value.map(c => c.id === connection.id ? connection : c) : [...connections.value, connection]
    delete modelLists.value[connection.id]
    // A key never follows its connection to another host (the desktop shell enforces this too).
    if (moved && apiKey === undefined) apiKey = ''
    if (apiKey !== undefined) {
      try { if (real) await setConnectionKey(connection.id, apiKey); else if (apiKey) mockKeys.set(connection.id, apiKey); else mockKeys.delete(connection.id) }
      catch (error) { notice.value = typeof error === 'string' ? error : '连接已保存，但 API Key 保存失败。'; return false }
      const next = new Set(storedKeys.value)
      if (apiKey) next.add(connection.id); else next.delete(connection.id)
      storedKeys.value = next
    }
    notice.value = '模型连接已保存。'
    return true
  }
  async function removeConnection(id: string): Promise<boolean> {
    if (real) { if (!await action('connection-remove', { connectionId: id })) return false }
    else { connections.value = connections.value.filter(c => c.id !== id); mockKeys.delete(id) }
    const next = new Set(storedKeys.value); next.delete(id); storedKeys.value = next
    delete modelLists.value[id]
    notice.value = '模型连接已删除。'
    return true
  }
  async function refreshModels(id: string): Promise<void> {
    modelLists.value[id] = { models: modelLists.value[id]?.models ?? [], loading: true }
    try { modelLists.value[id] = { models: real ? await listConnectionModels(id) : ['mock-flash', 'mock-pro'], loading: false } }
    catch (error) { modelLists.value[id] = { models: [], loading: false, error: typeof error === 'string' ? error : error instanceof Error ? error.message : '模型列表获取失败。' } }
  }
  async function configureModels(models: InstanceModels): Promise<boolean> {
    if (!real) mockModels.value = { ...mockModels.value, [selectedInstanceId.value]: models }
    else if (!await action('configure', { instanceId: selectedInstanceId.value, models })) return false
    notice.value = '实例模型配置已保存。'
    return true
  }
  async function loadRealPackage(path: string) {
    if (!await action('load', { path })) return false
    selectedPackageId.value = packages.value.at(-1)?.id ?? ''
    selectedInstanceId.value = instances.value.find(i => i.packageId === selectedPackageId.value)?.id ?? ''
    if (!selectedInstanceId.value) await newInstance('第一次游玩')
    notice.value = '世界包已校验；实例数据将写入独立目录。'
    return true
  }
  async function savePreferences(nextTheme: 'system' | 'light' | 'dark', nextLargeText: boolean, nextReading?: ReadingPreferences, nextAudio?: AudioPreferences, nextPalette: Palette = palette.value) {
    if (real && !await action('preferences', { theme: nextTheme, largeText: nextLargeText, palette: nextPalette, ...(nextReading===undefined?{}:{reading:nextReading}), ...(nextAudio===undefined?{}:{audio:nextAudio}) })) return false
    theme.value = nextTheme; largeText.value = nextLargeText; palette.value = nextPalette
    if(nextReading)reading.value={...nextReading}
    if(nextAudio)audio.value={...nextAudio}
    notice.value = '设置已保存；阅读和音频偏好将在下次启动游戏时提供给前端。'
    return true
  }
  async function savePlaySettings(settings:PlaySettings){
    if(real){if(!await action('play-settings',{packageId:selectedPackageId.value,settings}))return false}
    else packagePlaySettings.value={...packagePlaySettings.value,[selectedPackageId.value]:settings}
    notice.value='游玩参数已保存，将作用于此包各实例的下一次启动。'
    return true
  }
  async function startGame() {
    if (!real) { startMock(); return }
    notice.value='正在启动故事线，恢复角色记忆与已提交进度。'
    if (!await action('start', { instanceId: selectedInstanceId.value })) return
    await reopenGame()
  }
  async function reopenGame() {
    try { await openGame(); notice.value = '游戏已在系统浏览器打开，Core 记忆已开启。' }
    catch { notice.value = 'Core 已启动，浏览器打开失败；可点击重新打开。' }
  }
  async function stopGame() {
    if (!real) { stopMock(); return }
    if (await action('stop')) notice.value = '游戏已结束；已提交进度保留，可继续游玩。'
  }
  async function selectStoryline(id: string): Promise<boolean> {
    if (!real) { if (currentInstance.value) currentInstance.value.currentStorylineId=id; return true }
    return action('story-select',{instanceId:selectedInstanceId.value,storylineId:id})
  }
  async function forkStory(nodeId: string, name: string): Promise<boolean> {
    if (!real) { forkAt(nodeId,name); return true }
    if (!await action('story-fork',{instanceId:selectedInstanceId.value,nodeId,name})) return false
    notice.value='新故事线已创建；首次开始恢复节点当时的角色记忆。原线保留。'
    return true
  }
  async function openCreator() {
    if (!real) { notice.value = '浏览器预览没有运行中的游戏；可用 creator:dev 查看创作者页面样例。'; return }
    try { await openCreatorPage(); notice.value = '创作者页面已在系统浏览器打开。' }
    catch (error) { notice.value = error instanceof Error ? error.message : '创作者页面打开失败。' }
  }
  async function exportStory(nodeId: string, path: string): Promise<boolean> {
    if (!real) return false
    if (!await action('story-export',{instanceId:selectedInstanceId.value,nodeId,path})) return false
    notice.value='完整节点已导出。接收者需要相同游戏包，并使用自己的模型继续。'
    return true
  }
  async function exportCurrentStory(title: string, path: string): Promise<boolean> {
    if (!real || busy.value) return false
    const instanceId = selectedInstanceId.value
    if (core.value.state !== 'running' || core.value.instanceId !== instanceId) {
      notice.value = '请先启动当前实例，再保存当前进度并导出；也可直接导出已保存节点。'
      return false
    }
    const previousNodes = new Set(currentInstance.value?.nodes.map(node => node.id))
    busy.value = true
    let saved = false
    try {
      notice.value = '正在保存当前完整节点，请等待。'
      applySnapshot(await coreRequest('story-save', { instanceId, title }))
      saved = true
      const nodeId = currentNode.value?.id
      if (currentInstance.value?.id !== instanceId || !nodeId || previousNodes.has(nodeId)) {
        throw new Error('未找到新保存的完整节点，请查看节点列表后重试。')
      }
      notice.value = '完整节点已保存，正在导出。'
      applySnapshot(await coreRequest('story-export', { instanceId, nodeId, path }))
      notice.value = '当前进度已保存并导出，可以继续游玩。接收者需要相同游戏包。'
      return true
    } catch (error) {
      const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '本机操作失败，请重试。'
      notice.value = saved ? '完整节点已保存，导出失败：' + message + ' 可从已保存节点重试。' : message
      return false
    } finally { busy.value = false }
  }
  async function importStory(path: string, name: string): Promise<boolean> {
    if (!real) return false
    const previous=new Set(instances.value.map(instance=>instance.id))
    if (!await action('story-import',{packageId:selectedPackageId.value,path,name})) return false
    selectedInstanceId.value=instances.value.find(instance=>!previous.has(instance.id))?.id??selectedInstanceId.value
    notice.value='已导入为独立实例；首次开始恢复存档中的角色记忆。已有实例保留。'
    return true
  }
  async function refresh() {
    if (real && initialized.value && !busy.value) {
      try { const snapshot = await coreRequest('snapshot'); if (!busy.value) applySnapshot(snapshot) }
      catch { notice.value = 'Core 连接已关闭，请重启 Launcher。' }
    }
  }

  return { exportStory,exportCurrentStory,importStory,selectStoryline,forkStory,openCreator,savePresetDrafts,libraryAction,presetCharacters,presets,effectivePreset,inspectPreset,saveGlobalPreset,saveInstancePreset,currentFrontend,inspectFrontend,grantFrontend,revokeFrontend,real, busy, initialized, realInstances, currentRealInstance, currentModels, connectionName, connections, storedKeys, modelLists, lastModels, saveConnection, removeConnection, refreshModels, configureModels, initialize, refresh, loadRealPackage, startGame, stopGame, reopenGame, packages, instances, profiles, globalDefaultModelId, dataDirectory, largeText, theme, palette, reading, audio, currentPlaySettings, savePlaySettings, savePreferences, notice,
    selectedPackageId, selectedInstanceId, core, selectedPackage, currentInstance, currentStoryline,
    currentNode, currentModel, currentHistory, gameInstances, selectPackage, newInstance, loadMockPackage,
    forkAt, importMockStory, startMock, stopMock }
})
