import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { currentEntityState, currentLocation } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import type { WorldJsonObject } from '@harness-world/contracts'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'
import type { CoreRunner } from '../experiments/hindsight-python.ts'
import { readStoryNodes, restoreStoryNode, saveStoryNode } from '../../desktop/story-nodes.ts'
import { exportStoryNode } from '../../desktop/story-share.ts'
import { LauncherCore } from '../../desktop/launcher-core.ts'

const roots: string[] = [], servers: Server[] = [], runtimes: FrozenWorldPlaytestRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) await new Promise<void>(done=>server.close(()=>done()))
  for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true})
})
const built = (input: WorldJsonObject): WorldJsonObject => ({
  archive:{scope:input.scope!,sources:input.sources!,facts:[],episodes:[],observations:[]},
  index:{scope:input.scope!,units:[],vectors:[]},
})
const empty = {delivery:[],deliveryTrace:{delivered:[],activityCoverage:[]}}
async function fixture() {
  const root=mkdtempSync(join(tmpdir(),'story-node-'));roots.push(root)
  const pack=join(root,'pack'),data=join(root,'data')
  cpSync(resolve('examples/world-packs/prototype-g1'),pack,{recursive:true})
  mkdirSync(join(pack,'scripts'))
  cpSync(resolve('examples/world-packs/ai-girls-awaken-v10/scripts/variables.js'),join(pack,'scripts/variables.js'))
  const activity=readFileSync(resolve('examples/world-packs/ai-girls-awaken-v10/scripts/activity.js'),'utf8').replaceAll('character:gpt','character:companion')
  writeFileSync(join(pack,'scripts/activity.js'),activity)
  const source=JSON.parse(readFileSync(join(pack,'worldpack.source.json'),'utf8'))
  source.assetFiles=['scripts/variables.js','scripts/activity.js']
  writeFileSync(join(pack,'worldpack.source.json'),JSON.stringify(source))
  const requests: WorldJsonObject[] = []
  let follow=false, followed=false, gate:Promise<void>|undefined
  const server=createServer((request,response)=>{
    // Endpoint capability probes have no chat body; this fixture implements only POST completion.
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return }
    let body=''
    request.on('data',chunk=>{body+=String(chunk)})
    request.on('end',()=>{void(async()=>{
      const input=JSON.parse(JSON.parse(body).messages.at(-1).content)
      requests.push(input)
      if(gate)await gate
      let answer:unknown={decision:'abstain'}
      if(follow&&!followed&&input.context.character.characterId==='character:companion'&&!input.continuation){
        followed=true;answer={decision:'perform',actionType:'move',parameters:{locationId:'location:back-room'}}
      }
      response.writeHead(200,{'content-type':'application/json'})
      response.end(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)}}]}))
    })()})
  })
  servers.push(server);await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  const port=(server.address() as {port:number}).port, builds:WorldJsonObject[]=[]
  const run:CoreRunner=async input=>{if(input.operation==='build'){builds.push(input);return built(input)}return empty}
  const options={packPath:pack,provider:'local' as const,model:'fixture',utilityEndpoint:'http://127.0.0.1:'+port+'/v1/chat/completions',
    memoryCore:true,memoryCoreRun:run,memoryCoreBuildRun:run}
  const create=async(directory=data, extra:Partial<typeof options>={})=>{
    const runtime=await FrozenWorldPlaytestRuntime.create({...options,...extra,dataDirectory:directory})
    runtimes.push(runtime);return runtime
  }
  const runtime=await create()
  const events=(directory=data)=>{const store=new WorldStore(join(directory,'world.sqlite'))
    try{return store.readEvents(runtime.address)}finally{store.close()}}
  return {root,pack,data,builds,requests,run,options,create,runtime,events,setFollow:()=>{follow=true},setGate:(value:Promise<void>|undefined)=>{gate=value}}
}
const activityRequest=(state:{activity?:WorldJsonObject},operation:string)=>({
  activityId:state.activity?.id as string|null,revision:Number(state.activity?.revision),operation,parameters:{},requestId:randomUUID(),
})

it('restores one complete instant: location, custody, active game, variables and role-authorized memory; keeps the original future',async()=>{
  const f=await fixture()
  await f.runtime.submit('/vars [{"op":"replace","path":"/public/剧情/阶段","value":"节点阶段"}]')
  await f.runtime.submit('/act interact {"targetRef":{"kind":"entity","id":"entity:brass-key"},"bindingId":"binding:key-take","definitionRef":{"id":"base:take","version":1},"arguments":{}}')
  f.setFollow()
  await f.runtime.submit('/act move {"locationId":"location:back-room"}')
  await f.runtime.submit('/act speak {"text":"后室暗号：青松七号。"}')
  const active=await f.runtime.activityAction(activityRequest(await f.runtime.state(),'start'))
  expect(active.activity?.id).not.toBeNull()
  const node=await f.runtime.saveNode('另一个未来的起点')
  const nodeEvents=f.events()
  await f.runtime.activityAction(activityRequest(await f.runtime.state(),'quit'))
  await f.runtime.submit('/act interact {"targetRef":{"kind":"entity","id":"entity:brass-key"},"bindingId":"binding:key-drop","definitionRef":{"id":"base:drop","version":1},"arguments":{}}')
  await f.runtime.submit('/act move {"locationId":"location:front-room"}')
  await f.runtime.submit('/vars [{"op":"replace","path":"/public/剧情/阶段","value":"未来阶段"}]')
  await f.runtime.submit('/act speak {"text":"未来秘密：红杉九号。"}')
  const future=JSON.stringify(f.events())
  await f.runtime.close()
  const target=join(f.root,'child')
  restoreStoryNode(f.data,node.id,target,node.packHash)
  expect(existsSync(join(target,'memory-core'))).toBe(false)
  const child=await f.create(target)
  expect(f.events(target)).toEqual(nodeEvents)
  expect(currentLocation(f.events(target),'character:player')).toBe('location:back-room')
  expect(currentEntityState(f.events(target),'entity:brass-key')?.holderId).toBe('character:player')
  expect((await child.state()).activity).toEqual(active.activity)
  expect((await child.state()).packVariables?.public).toEqual({剧情:{阶段:'节点阶段'}})
  expect(existsSync(join(target,'rebuild-memory.json'))).toBe(false)
  expect(f.builds).toHaveLength(0)
  await child.activityAction(activityRequest(await child.state(),'quit'))
  await child.submit('/act speak {"text":"新故事线继续。"}')
  expect(JSON.stringify(f.events())).toBe(future)
  await child.close()
  const before=f.builds.length
  const resumed=await f.create(target)
  expect(f.builds).toHaveLength(before)
  expect((await resumed.state()).transcript.some(t=>t.text==='新故事线继续。')).toBe(true)
},30_000)

it('refuses to save while a role call is active and leaves no selectable partial node',async()=>{
  const f=await fixture()
  let release!:()=>void
  f.setGate(new Promise<void>(done=>{release=done}))
  const work=f.runtime.submit('/act speak {"text":"正在等待角色。"}')
  try{
    await expect(f.runtime.saveNode('不完整节点')).rejects.toThrow('等待当前行动')
    expect(readStoryNodes(f.data)).toEqual([])
  }finally{release();await work;f.setGate(undefined)}
  await expect(f.runtime.saveNode('完整节点')).resolves.toMatchObject({title:'完整节点'})
},15_000)

it('preserves installed node archives and raw tail without rebuilding or copying future memory',async()=>{
 const f=await fixture()
 await f.runtime.submit('/act speak {"text":"节点前的真实约定。"}')
 await f.runtime.refreshMemory();await f.runtime.waitForMemory()
 await f.runtime.submit('/act speak {"text":"整理后的近期原文。"}')
 const node=await f.runtime.saveNode('已有记忆的节点')
 const saved=JSON.parse(readFileSync(join(f.data,'story-nodes',node.id,'core-memory.json'),'utf8'))
 expect(Object.keys(saved)).toHaveLength(2)
 for(const cached of Object.values(saved) as WorldJsonObject[])expect(Number(((cached.archive as WorldJsonObject).scope as WorldJsonObject).asOfWorldSeq)).toBeLessThan(node.headSeq)
 await f.runtime.submit('/act speak {"text":"后来的未来不应进入旧节点。"}')
 await f.runtime.refreshMemory();await f.runtime.waitForMemory();await f.runtime.close()
 const before=f.builds.length,target=join(f.root,'archived-child')
 restoreStoryNode(f.data,node.id,target,node.packHash)
 const child=await f.create(target)
 expect(f.builds).toHaveLength(before)
 for(const [actor,cached] of Object.entries(saved))expect(JSON.parse(readFileSync(join(target,'memory-core',Buffer.from(actor).toString('base64url')+'.json'),'utf8'))).toEqual(cached)
 await child.submit('/act speak {"text":"检查原始历史尾部。"}')
 const wire=f.requests.at(-1)!
 expect(JSON.stringify(wire)).toContain('整理后的近期原文')
 expect(JSON.stringify(wire)).not.toContain('后来的未来')
 await child.close()
},15_000)

it('repeated nodes and forks below threshold never call memory Build, including old nodes without snapshots',async()=>{
 const f=await fixture()
 for(let i=0;i<3;i++){
  const node=await f.runtime.saveNode('频繁保存 '+i),target=join(f.root,'frequent-'+i)
  if(i===0){const path=join(f.data,'story-nodes',node.id);unlinkSync(join(path,'core-memory.json'));node.files=node.files.filter(name=>name!=='core-memory.json');writeFileSync(join(path,'node.json'),JSON.stringify(node))}
  restoreStoryNode(f.data,node.id,target,node.packHash)
  const child=await f.create(target);await child.close()
 }
 expect(f.builds).toHaveLength(0)
})

it('rejects future or foreign node memory before opening a fork and retains the restore marker',async()=>{
 const f=await fixture();await f.runtime.refreshMemory();await f.runtime.waitForMemory()
 const node=await f.runtime.saveNode('验证边界');await f.runtime.close()
 const original=JSON.stringify(f.events())
 for(const kind of ['future','foreign','source']){
  const target=join(f.root,'bad-'+kind);restoreStoryNode(f.data,node.id,target,node.packHash)
  const path=join(target,'core-memory.json'),saved=JSON.parse(readFileSync(path,'utf8'))
  const cached=saved['character:companion']
  if(kind==='future')cached.archive.scope.asOfWorldSeq=node.headSeq+1
  else if(kind==='foreign')cached.archive.scope.characterId='character:friend'
  else cached.archive.sources[0].text='来自另一条世界线的内容'
  writeFileSync(path,JSON.stringify(saved))
  await expect(f.create(target)).rejects.toThrow(kind==='source'?'memory source prefix changed':'another role, world or future prefix')
  expect(existsSync(join(target,'rebuild-memory.json'))).toBe(true)
  expect(JSON.stringify(f.events())).toBe(original)
 }
},15_000)

it('persists real line selection and restricts forks to reachable saved nodes; Launcher returns no private snapshot data',async()=>{
  const f=await fixture(),root=join(f.root,'launcher'),core=new LauncherCore(resolve('.'),root)
  await core.initialize();await core.handle({operation:'load',path:f.pack})
  const pack=core.snapshot().packs[0]!
  await core.handle({operation:'create',packageId:pack.id,name:'我的实例'})
  const instance=core.snapshot().instances[0]!,directory=join(root,'instances',instance.id)
  const main=await f.create(directory),node=await main.saveNode('主线节点')
  await main.close()
  await core.handle({operation:'story-fork',instanceId:instance.id,nodeId:node.id,name:'不同选择'})
  const lineId=core.snapshot().instances[0]!.currentStorylineId
  expect(lineId).not.toBe('main')
  const restored=new LauncherCore(resolve('.'),root);await restored.initialize()
  expect(restored.snapshot().instances[0]!.currentStorylineId).toBe(lineId)
  const child=await f.create(join(directory,'storylines',lineId))
  const childNode=await child.saveNode('分叉后节点');await child.close()
  await restored.handle({operation:'story-select',instanceId:instance.id,storylineId:'main'})
  await expect(restored.handle({operation:'story-fork',instanceId:instance.id,nodeId:childNode.id,name:'越界'})).rejects.toThrow('历史节点')
  const publicText=JSON.stringify(restored.snapshot())
  expect(publicText).not.toContain('sourceHash')
  expect(publicText).not.toContain('archive')
  expect(publicText).not.toContain('青松七号')
  await expect(restored.handle({operation:'story-fork',instanceId:instance.id,nodeId:'../outside',name:'越界'})).rejects.toThrow('不存在')
  expect(restored.snapshot().instances[0]!.storylines).toHaveLength(2)
},20_000)


it('publishes no partial node on save failure and refuses a node whose variable file is missing',async()=>{
  const f=await fixture(),node=await f.runtime.saveNode('完整记录')
  const before=JSON.stringify(f.events())
  await expect(saveStoryNode(f.data,f.runtime.address,node.packHash,'失败节点',1n)).rejects.toThrow()
  expect(readStoryNodes(f.data).map(n=>n.id)).toEqual([node.id])
  expect(JSON.stringify(f.events())).toBe(before)
  unlinkSync(join(f.data,'story-nodes',node.id,'pack-variables.json'))
  expect(()=>restoreStoryNode(f.data,node.id,join(f.root,'broken'),node.packHash)).toThrow('文件缺失')
  expect(JSON.stringify(f.events())).toBe(before)
})

it('shares one historical node across independent launchers, excludes future and caches, and restores authorized raw history', async()=>{
  const f=await fixture()
  await f.runtime.submit('/vars [{"op":"replace","path":"/public/剧情/阶段","value":"分享阶段"}]')
  await f.runtime.submit('/act interact {"targetRef":{"kind":"entity","id":"entity:brass-key"},"bindingId":"binding:key-take","definitionRef":{"id":"base:take","version":1},"arguments":{}}')
  f.setFollow();await f.runtime.submit('/act move {"locationId":"location:back-room"}')
  await f.runtime.submit('/act speak {"text":"只有后室的人知道：分享暗号青松七号。"}')
  const active=await f.runtime.activityAction(activityRequest(await f.runtime.state(),'start'))
  const node=await f.runtime.saveNode('朋友的起点'),saved=f.events()
  await f.runtime.activityAction(activityRequest(await f.runtime.state(),'quit'))
  await f.runtime.submit('/vars [{"op":"replace","path":"/public/剧情/阶段","value":"后来的未来"}]')
  await f.runtime.submit('/act speak {"text":"后来秘密红杉九号。"}')
  await f.runtime.close()
  const original=JSON.stringify(f.events())
  // These files must not travel with the snapshot, even when present in its directory.
  writeFileSync(join(f.data,'story-nodes',node.id,'context.sqlite'),'REQUEST-SECRET')
  writeFileSync(join(f.data,'story-nodes',node.id,'memory.sqlite'),'DERIVED-CACHE-SECRET')
  const sender=new LauncherCore(resolve('.'),join(f.root,'sender'));await sender.initialize()
  await sender.handle({operation:'load',path:f.pack});const packageId=sender.snapshot().packs[0]!.id
  await sender.handle({operation:'create',packageId,name:'发送者'})
  const senderId=sender.snapshot().instances[0]!.id
  cpSync(f.data,join(f.root,'sender','instances',senderId),{recursive:true})
  const archive=join(f.root,'朋友的故事.perspectra-story')
  await sender.handle({operation:'story-export',instanceId:senderId,nodeId:node.id,path:archive})
  const content=JSON.parse(readFileSync(archive,'utf8'))
  expect(Object.keys(content.files).sort()).toEqual(['memory-aliases.json','pack-variables.json','session.sqlite','world.sqlite'])
  expect(content.node.parentNodeId).toBeNull()
  const decoded=Object.values(content.files).map(bytes=>Buffer.from(bytes as string,'base64').toString('utf8')).join('')
  expect(decoded).not.toContain('REQUEST-SECRET');expect(decoded).not.toContain('DERIVED-CACHE-SECRET')
  expect(decoded).not.toContain('后来秘密红杉九号');expect(decoded).not.toContain('后来的未来')
  const receiverRoot=join(f.root,'receiver'),receiver=new LauncherCore(resolve('.'),receiverRoot)
  await receiver.initialize();await receiver.handle({operation:'load',path:f.pack})
  await receiver.handle({operation:'settings',model:{model:'receiver-own-model',endpoint:'http://127.0.0.1:8046/v1/chat/completions'}})
  await receiver.handle({operation:'story-import',packageId,path:archive,name:'我的续篇'})
  const imported=receiver.snapshot().instances[0]!,directory=join(receiverRoot,'instances',imported.id)
  expect(imported.id).not.toBe(senderId);expect(imported.nodes).toHaveLength(1)
  expect(imported.nodes[0]!.id).not.toBe(node.id);expect(imported.nodes[0]!.parentNodeId).toBeNull()
  expect(imported.model.model).toBe('receiver-own-model')
  expect(existsSync(join(directory,'context.sqlite'))).toBe(false)
  expect(existsSync(join(directory,'memory.sqlite'))).toBe(false)
  expect(existsSync(join(directory,'memory-core'))).toBe(false)
  f.builds.length=0
  const child=await f.create(directory)
  expect(f.events(directory)).toEqual(saved)
  expect(currentLocation(f.events(directory),'character:player')).toBe('location:back-room')
  expect(currentEntityState(f.events(directory),'entity:brass-key')?.holderId).toBe('character:player')
  expect((await child.state()).activity).toEqual(active.activity)
  expect((await child.state()).packVariables?.public).toEqual({剧情:{阶段:'分享阶段'}})
  expect(f.builds).toHaveLength(0)
  await child.activityAction(activityRequest(await child.state(),'quit'))
  await child.submit('/act speak {"text":"接收者继续自己的故事。"}')
  await child.saveNode('导入后保存');await child.close()
  expect(JSON.stringify(f.events())).toBe(original)
  const reloaded=new LauncherCore(resolve('.'),receiverRoot);await reloaded.initialize()
  expect(reloaded.snapshot().instances[0]!.nodes).toHaveLength(2)
  await receiver.handle({operation:'story-import',packageId,path:archive,name:'再次导入'})
  expect(receiver.snapshot().instances).toHaveLength(2)
  expect(receiver.snapshot().instances[1]!.id).not.toBe(imported.id)
},25_000)

it('rejects malformed, unsafe, mismatched and inconsistent shares without publishing or changing an existing instance',async()=>{
  const f=await fixture()
  await f.runtime.submit('/act speak {"text":"节点前的会话事实。"}')
  const node=await f.runtime.saveNode('校验节点');await f.runtime.close()
  const file=join(f.root,'校验.perspectra-story');await exportStoryNode(f.data,node.id,file,f.pack)
  const valid=JSON.parse(readFileSync(file,'utf8')),root=join(f.root,'receiver'),core=new LauncherCore(resolve('.'),root)
  await core.initialize();await core.handle({operation:'load',path:f.pack})
  const packageId=core.snapshot().packs[0]!.id
  await core.handle({operation:'create',packageId,name:'已有实例'})
  const index=readFileSync(join(root,'launcher.json'),'utf8'),events=JSON.stringify(f.events())
  const variants:[string,(value:typeof valid)=>void][]=[
    ['路径越界',value=>{value.node.files.push('../escape.txt');value.files['../escape.txt']='eA=='}],
    ['缺少会话',value=>{value.node.files=value.node.files.filter((name:string)=>name!=='session.sqlite');delete value.files['session.sqlite']}],
    ['缺少变量',value=>{value.node.files=value.node.files.filter((name:string)=>name!=='pack-variables.json');delete value.files['pack-variables.json']}],
    ['时刻不符',value=>{value.node.headSeq++}],
    ['数据库损坏',value=>{value.files['world.sqlite']=Buffer.from('broken database').toString('base64')}],
    ['会话游标损坏',value=>{const path=join(f.root,'edited-session.sqlite');writeFileSync(path,Buffer.from(value.files['session.sqlite'],'base64'));const db=new DatabaseSync(path);try{db.prepare('UPDATE session_delivery_cursor SET last_delivery_seq=last_delivery_seq+1').run()}finally{db.close()}value.files['session.sqlite']=readFileSync(path).toString('base64')}],
    ['包内容不同',value=>{value.node.packHash='sha256:different'}],
    ['无效编码',value=>{value.files['world.sqlite']='not base64!'}],
    ['身份越权',value=>{const aliases=JSON.parse(Buffer.from(value.files['memory-aliases.json'],'base64').toString('utf8'));aliases['character:companion']=[{scope:{characterId:'character:friend',worldAddress:f.runtime.address,asOfWorldSeq:node.headSeq},worldSeq:node.headSeq}];value.files['memory-aliases.json']=Buffer.from(JSON.stringify(aliases)).toString('base64')}],
  ]
  for(const [label,mutate] of variants){
    const edited=structuredClone(valid);mutate(edited);writeFileSync(file,JSON.stringify(edited))
    await expect(core.handle({operation:'story-import',packageId,path:file,name:label})).rejects.toThrow()
    expect(readFileSync(join(root,'launcher.json'),'utf8')).toBe(index)
    expect(core.snapshot().instances).toHaveLength(1)
  }
  writeFileSync(file,'{"kind":')
  await expect(core.handle({operation:'story-import',packageId,path:file,name:'截断'})).rejects.toThrow('不完整')
  truncateSync(file,130*1024*1024)
  await expect(core.handle({operation:'story-import',packageId,path:file,name:'过大'})).rejects.toThrow('大小限制')
  expect(readFileSync(join(root,'launcher.json'),'utf8')).toBe(index)
  expect(existsSync(join(root,'instances','escape.txt'))).toBe(false)
  expect(JSON.stringify(f.events())).toBe(events)
},20_000)
