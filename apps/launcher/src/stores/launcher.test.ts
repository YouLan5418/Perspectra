import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
const bridge = vi.hoisted(() => ({ request: vi.fn(), open: vi.fn(), creator: vi.fn(), list: vi.fn(), setKey: vi.fn(), keyStatus: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('../services/desktop.ts', () => ({ coreRequest: bridge.request, openGame: bridge.open, openCreator: bridge.creator, listConnectionModels: bridge.list, setConnectionKey: bridge.setKey, connectionKeyStatus: bridge.keyStatus }))
import { useLauncherStore } from './launcher.ts'
const endpoint = 'http://127.0.0.1:8046/v1/chat/completions'
const connectionId = '6f1c2a4e-1d0b-4c39-9a51-0d6c1b7e2f10'
const connection = { id: connectionId, name: '本地', protocol: 'openai' as const, endpoint }
const snapshot = () => ({
  packs: [{ id: 'pack:real', version: '1.0.0', title: '真实包', path: 'local', hash: 'hash' }],
  instances: [{ id: 'instance-1', packageId: 'pack:real', packageVersion: '1.0.0', packHash: 'hash', name: '实例', lastPlayedAt: null, needsModel: false, brokenConnection: false, models: { decision: { connectionId, model: 'actual-model' } } }],
  frontends: {}, connections: [connection],
  dataDirectory: 'private-data', core: { state: 'idle', mode: 'real' },
})
beforeEach(() => {
  setActivePinia(createPinia()); for (const mock of Object.values(bridge)) mock.mockReset()
  bridge.request.mockImplementation(async () => snapshot()); bridge.keyStatus.mockResolvedValue([])
})
it('native initialization starts empty and uses Core metadata rather than fixtures', async () => {
  const store = useLauncherStore()
  expect(store.packages).toEqual([])
  expect(store.instances).toEqual([])
  await store.initialize()
  expect(store.selectedPackage?.id).toBe('pack:real')
  expect(store.currentModel?.model).toBe('actual-model')
  expect(store.currentInstance?.nodes[0]?.turn).toBe(0)
  expect(store.core.mode).toBe('real')
})
it('starts a game without sending any key from the page', async () => {
  const store = useLauncherStore()
  await store.initialize()
  await store.startGame()
  expect(bridge.request).toHaveBeenCalledWith('start', { instanceId: 'instance-1' })
})

it('keeps unavailable packages visible and blocks them without blocking other games', async () => {
  const original = snapshot()
  const error = '世界包无法读取或校验；请恢复包文件后重新载入。'
  bridge.request.mockResolvedValue({ ...original,
    packs: [...original.packs, { ...original.packs[0], id: 'pack:healthy' }],
    packDetails: { 'pack:real': { description: '', hasCover: false, error } },
  })
  const store = useLauncherStore(); await store.initialize()
  expect(store.initialized).toBe(true)
  expect(store.selectedPackage?.validation).toEqual({ status: 'blocked', issues: [error], simulated: false })
  expect(store.packages.find(pack => pack.id === 'pack:healthy')?.validation.status).toBe('ready')
  expect(store.currentInstance?.id).toBe('instance-1')
  bridge.request.mockResolvedValue(original)
  await store.refresh()
  expect(store.selectedPackage?.validation.status).toBe('ready')
})

it('saves the connection before its key and remembers that a key is stored', async () => {
  const store = useLauncherStore(); await store.initialize()
  expect(await store.saveConnection(connection, 'K')).toBe(true)
  expect(bridge.request).toHaveBeenCalledWith('connection-save', { connection })
  expect(bridge.setKey).toHaveBeenCalledWith(connectionId, 'K')
  expect(bridge.request.mock.invocationCallOrder.at(-1)!).toBeLessThan(bridge.setKey.mock.invocationCallOrder[0]!)
  expect(store.storedKeys.has(connectionId)).toBe(true)
  await store.saveConnection(connection)
  expect(bridge.setKey).toHaveBeenCalledTimes(1)
})

it('forgets the stored key when a connection moves to another host', async () => {
  bridge.keyStatus.mockResolvedValue([connectionId])
  const store = useLauncherStore(); await store.initialize()
  expect(store.storedKeys.has(connectionId)).toBe(true)
  await store.saveConnection({ ...connection, endpoint: 'http://127.0.0.1:8046/v2/chat/completions' })
  expect(store.storedKeys.has(connectionId)).toBe(true)
  await store.saveConnection({ ...connection, endpoint: 'https://gateway.example/v1/chat/completions' })
  expect(store.storedKeys.has(connectionId)).toBe(false)
})

it('keeps a readable error when a model list cannot be fetched', async () => {
  const store = useLauncherStore(); await store.initialize()
  bridge.list.mockRejectedValueOnce('此接口不提供模型列表；可直接输入模型标识。')
  await store.refreshModels(connectionId)
  expect(store.modelLists[connectionId]).toEqual({ models: [], loading: false, error: expect.stringContaining('不提供模型列表') })
  bridge.list.mockResolvedValueOnce(['a', 'b'])
  await store.refreshModels(connectionId)
  expect(store.modelLists[connectionId]).toEqual({ models: ['a', 'b'], loading: false })
})

it('proposes the first listed model for a new instance when nothing was chosen before', async () => {
  const store = useLauncherStore(); await store.initialize()
  bridge.list.mockResolvedValueOnce(['m1', 'm2'])
  await store.newInstance('新实例')
  expect(bridge.request).toHaveBeenCalledWith('create', { packageId: 'pack:real', name: '新实例', models: { decision: { connectionId, model: 'm1' } } })
  bridge.request.mockImplementation(async () => ({ ...snapshot(), connections: [] }))
  await store.refresh()
  await store.newInstance('无连接')
  expect(bridge.request).toHaveBeenLastCalledWith('create', { packageId: 'pack:real', name: '无连接' })
  bridge.request.mockImplementation(async () => ({ ...snapshot(), lastModels: { decision: { connectionId, model: 'kept' } } }))
  await store.refresh(); bridge.list.mockClear()
  await store.newInstance('沿用')
  expect(bridge.list).not.toHaveBeenCalled()
  expect(bridge.request).toHaveBeenLastCalledWith('create', { packageId: 'pack:real', name: '沿用' })
  bridge.request.mockImplementation(async () => ({ ...snapshot(), lastModels: { decision: { connectionId: '00000000-0000-4000-8000-000000000000', model: 'deleted' } } }))
  await store.refresh(); bridge.list.mockResolvedValueOnce(['m1'])
  await store.newInstance('连接已删')
  expect(bridge.request).toHaveBeenLastCalledWith('create', { packageId: 'pack:real', name: '连接已删', models: { decision: { connectionId, model: 'm1' } } })
})

it('forwards only an explicitly confirmed digest and scopes revoke to the selected instance', async () => {
  const store=useLauncherStore()
  await store.initialize()
  await store.inspectFrontend()
  expect(bridge.request).toHaveBeenCalledWith('frontend-inspect',{instanceId:'instance-1'})
  await store.grantFrontend('digest',true)
  expect(bridge.request).toHaveBeenCalledWith('frontend-grant',{instanceId:'instance-1',expectedDigest:'digest',confirmed:true})
  await store.revokeFrontend()
  expect(bridge.request).toHaveBeenCalledWith('frontend-revoke',{instanceId:'instance-1'})
})

it('uses real saved nodes and persists storyline operations through Core instead of changing a mock pointer', async()=>{
  const original=snapshot()
  const nodes=[
    {id:'node-root',parentNodeId:null,turn:1,title:'原始节点',summary:'',createdAt:'2026-10-07T00:00:00Z'},
    {id:'node-main-future',parentNodeId:'node-root',turn:2,title:'原线未来',summary:'',createdAt:'2026-10-07T00:01:00Z'},
    {id:'node-child',parentNodeId:'node-root',turn:2,title:'另一种选择',summary:'',createdAt:'2026-10-07T00:02:00Z'},
  ]
  const lines=[
    {id:'main',name:'主故事线',parentStorylineId:null,parentNodeId:null,currentNodeId:'node-main-future',source:{kind:'original',label:'本地实例',storylineId:null,nodeId:null,turn:0}},
    {id:'child',name:'另一种未来',parentStorylineId:'main',parentNodeId:'node-root',currentNodeId:'node-child',source:{kind:'local',label:'主故事线',storylineId:'main',nodeId:'node-root',turn:1}},
  ]
  let current='child'
  bridge.request.mockImplementation(async(operation,data)=>{
    if(operation==='story-select')current=data.storylineId
    return {...original,instances:[{...original.instances[0]!,currentStorylineId:current,storylines:lines,nodes}]}
  })
  const store=useLauncherStore()
  await store.initialize()
  expect(store.currentStoryline?.id).toBe('child')
  expect(store.currentHistory.map(n=>n.id)).toEqual(['node-root','node-child'])
  await store.selectStoryline('main')
  expect(bridge.request).toHaveBeenCalledWith('story-select',{instanceId:'instance-1',storylineId:'main'})
  expect(store.currentHistory.map(n=>n.id)).toEqual(['node-root','node-main-future'])
  await store.forkStory('node-root','新线')
  expect(bridge.request).toHaveBeenCalledWith('story-fork',{instanceId:'instance-1',nodeId:'node-root',name:'新线'})
  // Saving progress moved to the game page toolbar; the launcher only switches, forks, imports and exports.
  expect('saveStoryNode' in store).toBe(false)
})

it('opens the creator page through the desktop shell and reports failures',async()=>{
  const store=useLauncherStore();await store.initialize()
  await store.openCreator()
  expect(bridge.creator).toHaveBeenCalledOnce()
  bridge.creator.mockRejectedValueOnce(new Error('游戏尚未启动。'))
  await store.openCreator()
  expect(store.notice).toBe('游戏尚未启动。')
})

it('exports the selected node and selects a newly imported independent instance',async()=>{
  const store=useLauncherStore();await store.initialize()
  const data=snapshot()
  bridge.request.mockImplementation(async(operation)=>operation==='story-import'
    ?{...data,instances:[...data.instances,{...data.instances[0]!,id:'imported-instance',name:'导入'}]}:data)
  await store.exportStory('saved-node','C:/share.perspectra-story')
  expect(bridge.request).toHaveBeenCalledWith('story-export',{instanceId:'instance-1',nodeId:'saved-node',path:'C:/share.perspectra-story'})
  await store.importStory('C:/share.perspectra-story','导入')
  expect(bridge.request).toHaveBeenCalledWith('story-import',{packageId:'pack:real',path:'C:/share.perspectra-story',name:'导入'})
  expect(store.selectedInstanceId).toBe('imported-instance')
  expect(store.instances).toHaveLength(2)
})

it('applies appearance without changing the running instance', async () => {
 const store=useLauncherStore(); await store.initialize()
 store.core={state:'running',mode:'real',instanceId:'instance-1'}
 bridge.request.mockResolvedValue({...snapshot(),preferences:{theme:'dark',largeText:true},core:{state:'running',mode:'real',instanceId:'instance-1'}})
 expect(await store.savePreferences('dark',true)).toBe(true)
 expect(bridge.request).toHaveBeenLastCalledWith('preferences',{theme:'dark',largeText:true,palette:'sakura'})
 expect(store.theme).toBe('dark'); expect(store.largeText).toBe(true)
 bridge.request.mockResolvedValue({...snapshot(),preferences:{theme:'dark',largeText:true,palette:'moon'},core:{state:'running',mode:'real',instanceId:'instance-1'}})
 expect(await store.savePreferences('dark',true,undefined,undefined,'moon')).toBe(true)
 expect(bridge.request).toHaveBeenLastCalledWith('preferences',{theme:'dark',largeText:true,palette:'moon'})
 expect(store.palette).toBe('moon')
 expect(store.core.state).toBe('running')
})

it('saves play settings for the selected package and restores global reading preferences',async()=>{
 const {playSettings}=await import('../../../../desktop/play-settings.ts')
 const store=useLauncherStore();await store.initialize()
 const settings=playSettings({maximumWaves:5})
 bridge.request.mockResolvedValue({...snapshot(),playSettings:{'pack:real':settings},preferences:{largeText:false,reading:{fontSize:22,lineHeight:2,autoFollow:false}}})
 expect(await store.savePlaySettings(settings)).toBe(true)
 expect(bridge.request).toHaveBeenLastCalledWith('play-settings',{packageId:'pack:real',settings})
 expect(store.currentPlaySettings.maximumWaves).toBe(5)
 expect(store.reading.autoFollow).toBe(false)
 expect(store.currentModel?.model).toBe('actual-model')
})

it('restores and saves audio preferences through the existing preferences operation',async()=>{
 const store=useLauncherStore();await store.initialize()
 expect(store.audio).toEqual({volume:80,muted:false,voiceEnabled:false})
 const audio={volume:35,muted:true,voiceEnabled:true}
 bridge.request.mockResolvedValue({...snapshot(),preferences:{theme:'dark',largeText:false,audio}})
 await store.refresh()
 expect(store.audio).toEqual(audio)
 expect(await store.savePreferences('dark',false,undefined,{...audio,volume:60})).toBe(true)
 expect(bridge.request).toHaveBeenLastCalledWith('preferences',{theme:'dark',largeText:false,palette:'sakura',audio:{...audio,volume:60}})
 expect(store.audio.volume).toBe(60)
 bridge.request.mockRejectedValueOnce(new Error('保存失败'))
 expect(await store.savePreferences('dark',false,undefined,{...audio,volume:10})).toBe(false)
 expect(store.audio.volume).toBe(60)
})

it('summarizes the home stage: model, overrides, front-end mode and why play is blocked',async()=>{
  const data=snapshot()
  bridge.request.mockImplementation(async()=>({...data,
    instances:[{...data.instances[0]!,models:{...data.instances[0]!.models,characters:{'char:a':{decision:{connectionId,model:'other'}}}}}],
    frontends:{'instance-1':{kind:'custom',mode:'sandbox',digest:'d',capabilities:[]}}}))
  const store=useLauncherStore();await store.initialize()
  expect(store.stageSummary).toMatchObject({title:'真实包',storyline:'主故事线',model:'actual-model · 另有 1 个角色单独配置',frontend:'sandbox',blockedReason:''})
  expect(store.running).toBe(false)
  bridge.request.mockImplementation(async()=>({...data,instances:[{...data.instances[0]!,models:undefined}],
    frontends:{'instance-1':{kind:'default',mode:'sandbox',digest:'d',capabilities:[]}}}))
  await store.refresh()
  expect(store.stageSummary.blockedReason).toBe('还没有可用模型，请先完成模型设置')
  expect(store.stageSummary.frontend).toBe('default')
  bridge.request.mockImplementation(async()=>({...data,frontends:{'instance-1':{kind:'custom',mode:'trusted',digest:'d',capabilities:[]}}}))
  await store.refresh()
  expect(store.stageSummary.frontend).toBe('trusted')
})

it('inspects the selected front end instead of assuming the official template',async()=>{
  const data=snapshot()
  bridge.request.mockImplementation(async(operation)=>operation==='frontend-inspect'
    ?{...data,frontends:{'instance-1':{kind:'custom',mode:'sandbox',digest:'d',capabilities:[]}}}:data)
  const store=useLauncherStore()
  await store.initialize()
  await vi.waitFor(()=>expect(bridge.request).toHaveBeenCalledWith('frontend-inspect',{instanceId:'instance-1'}))
  await vi.waitFor(()=>expect(store.stageSummary.frontend).toBe('sandbox'))
})

it('lists the session drawer rows with summaries, a sandbox warning and creator availability',async()=>{
  const data=snapshot()
  bridge.request.mockImplementation(async()=>({...data,frontends:{'instance-1':{kind:'custom',mode:'sandbox',digest:'d',capabilities:[]}}}))
  const store=useLauncherStore();await store.initialize()
  expect(store.drawerRows.map(r=>[r.group,r.id])).toEqual([['游玩','story'],['游玩','model'],['游玩','preset'],['游玩','frontend'],['进阶','play'],['进阶','creator']])
  const row=(id:string)=>store.drawerRows.find(r=>r.id===id)!
  expect(row('story').summary).toBe('主故事线 · 1 条故事线')
  expect(row('model').summary).toBe('actual-model')
  expect(row('preset').summary).toBe('采用包推荐')
  expect(row('frontend')).toMatchObject({summary:'沙箱（自定义前端）',warn:true,action:'解除沙箱'})
  expect(row('creator')).toMatchObject({disabled:true,summary:'启动游戏后可用'})
  bridge.request.mockImplementation(async()=>({...data,core:{state:'running',mode:'real',instanceId:'instance-1',storylineId:'main',url:''}}))
  await store.refresh()
  expect(row('frontend')).toMatchObject({summary:'检查中',warn:false,action:'查看'})
  expect(row('creator').disabled).toBe(false)
})

it('applies the settings window draft once and can reset it to the last applied values',async()=>{
  const store=useLauncherStore();await store.initialize()
  store.resetPreferencesDraft()
  expect(store.preferencesDirty).toBe(false)
  store.preferencesDraft.theme='dark';store.preferencesDraft.largeText=true
  expect(store.preferencesDirty).toBe(true)
  bridge.request.mockClear()
  expect(await store.applyPreferences()).toBe(true)
  expect(bridge.request.mock.calls.filter(call=>call[0]==='preferences')).toHaveLength(1)
  expect(store.theme).toBe('dark');expect(store.preferencesDirty).toBe(false)
  store.preferencesDraft.theme='light'
  store.resetPreferencesDraft()
  expect(store.preferencesDraft.theme).toBe('dark');expect(store.preferencesDirty).toBe(false)
})
