import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { currentEntityState, currentLocation } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import type { WorldJsonObject } from '@harness-world/contracts'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'
import type { CoreRunner } from '../experiments/hindsight-python.ts'
import { readStoryNodes, restoreStoryNode, saveStoryNode } from '../../desktop/story-nodes.ts'
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
  let follow=false, followed=false, gate:Promise<void>|undefined
  const server=createServer((request,response)=>{
    let body=''
    request.on('data',chunk=>{body+=String(chunk)})
    request.on('end',()=>{void(async()=>{
      const input=JSON.parse(JSON.parse(body).messages.at(-1).content)
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
  return {root,pack,data,builds,run,options,create,runtime,events,setFollow:()=>{follow=true},setGate:(value:Promise<void>|undefined)=>{gate=value}}
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
  expect(f.builds).toHaveLength(2)
  for(const build of f.builds){
    const scope=build.scope as WorldJsonObject
    expect(scope.asOfWorldSeq).toBe(node.headSeq)
    expect(build.retainedPrefix).toBeUndefined()
    expect((build.sources as WorldJsonObject[]).every(s=>s.characterId===scope.characterId&&Number(s.worldSeq)<=node.headSeq)).toBe(true)
    expect(JSON.stringify(build)).not.toContain('红杉九号')
    expect(JSON.stringify(build)).not.toContain('未来阶段')
  }
  expect(JSON.stringify(f.builds.find(b=>(b.scope as WorldJsonObject).characterId==='character:companion'))).toContain('青松七号')
  expect(JSON.stringify(f.builds.find(b=>(b.scope as WorldJsonObject).characterId==='character:friend'))).not.toContain('青松七号')
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

it('does not open a fork after partial memory failure; retries the missing role without altering its world or the original',async()=>{
  const f=await fixture(),node=await f.runtime.saveNode('失败重试')
  await f.runtime.close()
  const original=JSON.stringify(f.events()),target=join(f.root,'retry')
  restoreStoryNode(f.data,node.id,target,node.packHash)
  const failed:CoreRunner=async input=>{
    if(input.operation==='build'&&(input.scope as WorldJsonObject).characterId==='character:friend')throw new Error('fixture build failed')
    return input.operation==='build'?built(input):empty
  }
  await expect(f.create(target,{memoryCoreRun:failed,memoryCoreBuildRun:failed})).rejects.toThrow('fixture build failed')
  expect(existsSync(join(target,'rebuild-memory.json'))).toBe(true)
  expect(JSON.stringify(f.events())).toBe(original)
  const child=await f.create(target)
  expect(existsSync(join(target,'rebuild-memory.json'))).toBe(false)
  expect(JSON.stringify(f.events(target))).toBe(original)
  await child.close()
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
