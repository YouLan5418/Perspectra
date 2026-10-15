import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
const bridge = vi.hoisted(() => ({ request: vi.fn(), open: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('../services/desktop.ts', () => ({ coreRequest: bridge.request, openGame: bridge.open }))
import { useLauncherStore } from './launcher.ts'
const endpoint = 'http://127.0.0.1:8046/v1/chat/completions'
const snapshot = () => ({
  packs: [{ id: 'pack:real', version: '1.0.0', title: '真实包', path: 'local', hash: 'hash' }],
  instances: [{ id: 'instance-1', packageId: 'pack:real', packageVersion: '1.0.0', packHash: 'hash', name: '实例', lastPlayedAt: null, model: { model: 'actual-model', endpoint } }],
  frontends: {},
  defaults: { model: 'actual-model', endpoint }, dataDirectory: 'private-data', core: { state: 'idle', mode: 'real' },
})
beforeEach(() => { setActivePinia(createPinia()); bridge.request.mockReset(); bridge.open.mockReset(); bridge.request.mockImplementation(async () => snapshot()) })
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
it('does not forward a session API key to another instance endpoint', async () => {
  const store = useLauncherStore()
  await store.initialize()
  store.providers = [{ id: 'local', label: 'local', endpoint: 'https://other.example/v1/chat/completions', apiKey: 'private-key' }]
  await store.startGame()
  expect(bridge.request.mock.calls.filter(call => call[0] === 'start')).toHaveLength(0)
  expect(store.notice).toContain('密钥绑定')
  store.providers[0]!.endpoint = endpoint
  await store.startGame()
  expect(bridge.request).toHaveBeenCalledWith('start', { instanceId: 'instance-1', apiKey: 'private-key' })
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
  await store.saveStoryNode('保存点')
  expect(bridge.request).toHaveBeenCalledWith('story-save',{instanceId:'instance-1',title:'保存点'})
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

it('saves and exports the new node while keeping the game running and both operations locked',async()=>{
  const data=snapshot()
  const running={state:'running',mode:'real',instanceId:'instance-1'}
  const line={id:'main',name:'主故事线',parentStorylineId:null,parentNodeId:null,currentNodeId:'old',source:{kind:'original',label:'本地实例',storylineId:null,nodeId:null,turn:0}}
  const old={id:'old',parentNodeId:null,turn:1,title:'旧节点',summary:'',createdAt:'2026-10-15T00:00:00Z'}
  const saved={...old,id:'new',parentNodeId:'old',turn:2,title:'当前进度'}
  const state=(updated=false)=>({...data,core:running,instances:[{...data.instances[0]!,currentStorylineId:'main',storylines:[{...line,currentNodeId:updated?'new':'old'}],nodes:updated?[old,saved]:[old]}]})
  bridge.request.mockResolvedValue(state())
  const store=useLauncherStore();await store.initialize()
  bridge.request.mockImplementation(async(operation)=>{
    expect(store.busy).toBe(true)
    if(operation==='story-export')expect(store.currentNode?.id).toBe('new')
    await store.refresh() // Polling cannot overwrite the newly saved node between requests.
    return state(true)
  })
  expect(await store.exportCurrentStory('当前进度','C:/current.perspectra-story')).toBe(true)
  expect(bridge.request.mock.calls.slice(1)).toEqual([
    ['story-save',{instanceId:'instance-1',title:'当前进度'}],
    ['story-export',{instanceId:'instance-1',nodeId:'new',path:'C:/current.perspectra-story'}],
  ])
  expect(store.core.state).toBe('running');expect(store.busy).toBe(false)
})

it('never exports an older node after a failed or unconfirmed save and reports a saved node when only export fails',async()=>{
  const data=snapshot(),running={state:'running',mode:'real',instanceId:'instance-1'}
  bridge.request.mockResolvedValue({...data,core:running})
  const store=useLauncherStore();await store.initialize()
  bridge.request.mockRejectedValue(new Error('请等待当前行动完成'))
  expect(await store.exportCurrentStory('分享','C:/share.perspectra-story')).toBe(false)
  expect(store.notice).toContain('当前行动')
  expect(bridge.request.mock.calls.some(call=>call[0]==='story-export')).toBe(false)
  bridge.request.mockResolvedValue({...data,core:running})
  expect(await store.exportCurrentStory('分享','C:/share.perspectra-story')).toBe(false)
  expect(store.notice).toContain('未找到新保存')
  expect(bridge.request.mock.calls.some(call=>call[0]==='story-export')).toBe(false)
  const node={id:'saved',parentNodeId:null,turn:2,title:'分享',summary:'',createdAt:'2026-10-15T00:00:00Z'}
  const line={id:'main',name:'主线',parentStorylineId:null,parentNodeId:null,currentNodeId:node.id,source:{kind:'original',label:'本地实例',storylineId:null,nodeId:null,turn:0}}
  bridge.request.mockImplementation(async(operation)=>{
    if(operation==='story-export')throw new Error('目标目录不可写')
    return {...data,core:running,instances:[{...data.instances[0]!,currentStorylineId:'main',storylines:[line],nodes:[node]}]}
  })
  expect(await store.exportCurrentStory('分享','C:/share.perspectra-story')).toBe(false)
  expect(store.currentNode?.id).toBe('saved')
  expect(store.notice).toContain('完整节点已保存，导出失败')
  expect(store.notice).toContain('目标目录不可写')
  expect(store.busy).toBe(false)
})

it('binds session credentials to the selected protocol as well as endpoint',async()=>{
 const store=useLauncherStore();await store.initialize()
 store.providers=[{id:'local',label:'native',endpoint,protocol:'anthropic',apiKey:'private-key'}]
 await store.startGame()
 expect(bridge.request.mock.calls.filter(call=>call[0]==='start')).toHaveLength(0)
 expect(store.notice).toContain('密钥绑定')
})

it('applies appearance without changing the running instance or sending session credentials', async () => {
 const store=useLauncherStore(); await store.initialize()
 store.core={state:'running',mode:'real',instanceId:'instance-1'}
 store.providers=[{id:'local',label:'local',endpoint,apiKey:'private-key'}]
 bridge.request.mockResolvedValue({...snapshot(),preferences:{theme:'dark',largeText:true},core:{state:'running',mode:'real',instanceId:'instance-1'}})
 expect(await store.savePreferences('dark',true)).toBe(true)
 expect(bridge.request).toHaveBeenLastCalledWith('preferences',{theme:'dark',largeText:true})
 expect(store.theme).toBe('dark'); expect(store.largeText).toBe(true)
 expect(store.core.state).toBe('running'); expect(store.providers[0]!.apiKey).toBe('private-key')
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
 expect(bridge.request).toHaveBeenLastCalledWith('preferences',{theme:'dark',largeText:false,audio:{...audio,volume:60}})
 expect(store.audio.volume).toBe(60)
 bridge.request.mockRejectedValueOnce(new Error('保存失败'))
 expect(await store.savePreferences('dark',false,undefined,{...audio,volume:10})).toBe(false)
 expect(store.audio.volume).toBe(60)
})
