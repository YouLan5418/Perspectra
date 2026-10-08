import { isTauri } from '@tauri-apps/api/core'
import { coreRequest, openGame } from '../services/desktop.ts'
import type { CoreSnapshot, LocalModel, RolePreset, PresetChoice } from '../core-types.ts'
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { packages as fixtures, modelProfiles, createMockInstance, createFreshInstance } from '../mock.ts'
import { availableModel, historyTo } from '../domain.ts'
import type { CoreStatus, ProviderSettings, GamePackage } from '../types.ts'

export const useLauncherStore = defineStore('launcher', () => {
  const packages = ref<GamePackage[]>(isTauri() ? [] : [...fixtures])
  const instances = ref<import('../types.ts').GameInstance[]>(isTauri() ? [] : [createMockInstance(), createFreshInstance('quiet-town', '0.8.2', '新的旅程'), createFreshInstance('last-light', '0.3.0', '第一次游玩')])
  const profiles = ref([...modelProfiles])
  const selectedPackageId = ref('snow-inn')
  const selectedInstanceId = ref(instances.value[0]?.id ?? '')
  const core = ref<CoreStatus>({ state: 'idle', mode: isTauri() ? 'real' : 'mock' })
  const providers = ref<ProviderSettings[]>([{ id: 'local', label: '本地 / OpenAI 兼容接口', endpoint: '', apiKey: '' }])
  const globalDefaultModelId = ref<string | null>('flash')
  const dataDirectory = ref('')
  const largeText = ref(false)
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
  async function newInstance(name: string) { if (real) { if (await action('create', { packageId: selectedPackageId.value, name })) { selectedInstanceId.value = instances.value.at(-1)?.id ?? ''; notice.value = '已创建独立实例。' }; return }
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
  const defaults = ref<LocalModel>({ model: 'gemini-3.7-flash', endpoint: 'http://127.0.0.1:8046/v1/chat/completions' })
  const realInstances = ref<CoreSnapshot['instances']>([])
  const currentRealModel = computed(() => realInstances.value.find(i => i.id === selectedInstanceId.value)?.model ?? defaults.value)
  const presets=ref<CoreSnapshot['presets']>({library:[],characters:{},global:{},instances:{},recommended:{}})
  const presetCharacters=computed(()=>presets.value.characters[selectedPackageId.value]??[])
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
  function applySnapshot(snapshot: CoreSnapshot) {
    presets.value=snapshot.presets??{library:[],characters:{},global:{},instances:{},recommended:{}}
    frontends.value=snapshot.frontends
    realInstances.value = snapshot.instances
    defaults.value = snapshot.defaults
    largeText.value = snapshot.preferences?.largeText ?? false
    dataDirectory.value = snapshot.dataDirectory
    packages.value = snapshot.packs.map(p => ({ id: p.id, version: p.version, title: p.title, subtitle: '本地世界包', description: '由真实 Core 校验与运行。进度保存在独立实例中。',
      genre: '互动故事', artwork: 'inn', recommendation: { capability: 'balanced', contextTokens: 0, toolCalling: true }, validation: { status: 'ready', issues: [], simulated: false } }))
    profiles.value = snapshot.instances.map(i => ({ id: i.id, label: i.model.model, model: i.model.model, providerId: 'local', capability: 'balanced', contextTokens: 0, toolCalling: true }))
    instances.value = snapshot.instances.map(i => ({ ...i, model: { defaultModelId: i.id, overridesEnabled: false, groups: {}, characters: {} }, currentStorylineId: i.currentStorylineId ?? 'main',
      storylines: i.storylines ?? [{ id: 'main', name: '主故事线', parentStorylineId: null, parentNodeId: null, currentNodeId: 'head', source: { kind: 'original', label: '本地实例', storylineId: null, nodeId: null, turn: 0 } }],
      nodes: i.nodes ?? [{ id: 'head', parentNodeId: null, title: i.lastPlayedAt ? '已保存的世界进度' : '新的旅程', summary: '', turn: 0, createdAt: '' }], localSettings: { textSize: 'standard' } }))
    core.value = snapshot.core
    if (!packages.value.some(p => p.id === selectedPackageId.value)) selectedPackageId.value = packages.value[0]?.id ?? ''
    if (!instances.value.some(i => i.id === selectedInstanceId.value && i.packageId === selectedPackageId.value)) selectedInstanceId.value = instances.value.find(i => i.packageId === selectedPackageId.value)?.id ?? ''
  }
  async function action(operation: string, data: Record<string, unknown> = {}): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try { applySnapshot(await coreRequest(operation, data)); return true }
    catch (error) { notice.value = typeof error === 'string' ? error : '本机操作失败，请重试。'; return false }
    finally { busy.value = false }
  }
  async function initialize() {
    if (!real) return
    if (await action('snapshot')) initialized.value = true
  }
  async function loadRealPackage(path: string) {
    if (!await action('load', { path })) return false
    selectedPackageId.value = packages.value.at(-1)?.id ?? ''
    selectedInstanceId.value = instances.value.find(i => i.packageId === selectedPackageId.value)?.id ?? ''
    if (!selectedInstanceId.value) await newInstance('第一次游玩')
    notice.value = '世界包已校验；实例数据将写入独立目录。'
    return true
  }
  async function saveSettings(model: LocalModel, apiKey: string, nextLargeText = largeText.value) {
    if (!await action('settings', { model, largeText: nextLargeText })) return false
    providers.value = [{ id: 'local', label: '模型接口', protocol: model.protocol ?? 'openai', endpoint: model.endpoint, apiKey }]
    notice.value = '默认模型已保存；API Key 仅在本次会话中保留。'
    return true
  }
  async function configureModel(model: LocalModel) {
    if (!await action('configure', { instanceId: selectedInstanceId.value, model })) return false
    notice.value = '实例模型配置已保存。'
    return true
  }
  async function startGame() {
    if (!real) { startMock(); return }
    const provider = providers.value[0]
    if (provider?.apiKey && (provider.endpoint !== currentRealModel.value.endpoint || (provider.protocol ?? 'openai') !== (currentRealModel.value.protocol ?? 'openai'))) {
      notice.value = '实例接口与当前密钥绑定的地址不同；请在设置填写该接口的密钥，或清空密钥后启动。'
      return
    }
    notice.value='正在启动故事线；新分叉会重新整理角色记忆，可能需要等待数分钟。'
    if (!await action('start', { instanceId: selectedInstanceId.value, apiKey: providers.value[0]?.apiKey ?? '' })) return
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
    notice.value='新故事线已创建；首次开始会重新整理角色记忆，请等待。原线保留。'
    return true
  }
  async function saveStoryNode(title: string): Promise<boolean> {
    if (!real) return false
    notice.value='正在保存完整节点，请等待。'
    if (!await action('story-save',{instanceId:selectedInstanceId.value,title})) return false
    notice.value='已保存完整节点，可结束游戏后从这里分叉。'
    return true
  }
  async function exportStory(nodeId: string, path: string): Promise<boolean> {
    if (!real) return false
    if (!await action('story-export',{instanceId:selectedInstanceId.value,nodeId,path})) return false
    notice.value='完整节点已导出。接收者需要相同游戏包，并使用自己的模型继续。'
    return true
  }
  async function importStory(path: string, name: string): Promise<boolean> {
    if (!real) return false
    const previous=new Set(instances.value.map(instance=>instance.id))
    if (!await action('story-import',{packageId:selectedPackageId.value,path,name})) return false
    selectedInstanceId.value=instances.value.find(instance=>!previous.has(instance.id))?.id??selectedInstanceId.value
    notice.value='已导入为独立实例；首次开始需要等待角色记忆重建。已有实例保留。'
    return true
  }
  async function refresh() {
    if (real && initialized.value && !busy.value) {
      try { applySnapshot(await coreRequest('snapshot')) } catch { notice.value = 'Core 连接已关闭，请重启 Launcher。' }
    }
  }

  return { exportStory,importStory,selectStoryline,forkStory,saveStoryNode,savePresetDrafts,libraryAction,presetCharacters,presets,effectivePreset,inspectPreset,saveGlobalPreset,saveInstancePreset,currentFrontend,inspectFrontend,grantFrontend,revokeFrontend,real, busy, initialized, defaults, currentRealModel, initialize, refresh, loadRealPackage, saveSettings, configureModel, startGame, stopGame, reopenGame, packages, instances, profiles, providers, globalDefaultModelId, dataDirectory, largeText, notice,
    selectedPackageId, selectedInstanceId, core, selectedPackage, currentInstance, currentStoryline,
    currentNode, currentModel, currentHistory, gameInstances, selectPackage, newInstance, loadMockPackage,
    forkAt, importMockStory, startMock, stopMock }
})
