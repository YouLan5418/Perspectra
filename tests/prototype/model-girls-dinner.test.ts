import { afterEach, expect, it } from 'vitest'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { currentEntityState } from '@harness-world/kernel'
import { FrozenWorldRuntimeCore } from '../experiments/playtest-frozen-runtime.ts'
import { projectPlayerView } from '../../packages/frontend/src/player-view.ts'

const roots:string[]=[],runtimes:FrozenWorldRuntimeCore[]=[]
afterEach(async()=>{for(const r of runtimes.splice(0))await r.close();for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true})})

async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'model-girls-dinner-'));roots.push(root)
  const pack=join(root,'pack'),data=join(root,'data');cpSync(resolve('examples/world-packs/model-girls-dinner-v2'),pack,{recursive:true})
  // No usable provider: NPC turns fail fast, so only the player's adjudicated actions change the world.
  const runtime=await FrozenWorldRuntimeCore.create({packPath:pack,dataDirectory:data,provider:'ollama',model:'unused',
    utilityEndpoint:'http://127.0.0.1:1/api/chat',timeoutMs:1000});runtimes.push(runtime)
  const events=()=>{const store=new WorldStore(join(data,'world.sqlite'));try{return store.readEvents(runtime.address)}finally{store.close()}}
  const actions=async()=>projectPlayerView(await runtime.state()).actions
  const act=async(label:string,extra:WorldJsonObject={})=>{
    const action=(await actions()).find(a=>a.label===label);expect(action,label).toBeDefined()
    return runtime.perform({...action!.action,parameters:{...action!.action.parameters,...extra}})
  }
  const kind=(id:string)=>currentEntityState(events(),id)?.kind
  return {runtime,events,actions,act,kind}
}

it('advances the clock in one click, narrates the time and closes it so characters keep hearing ordinary speech',async()=>{
  const f=await fixture()
  const labels=(await f.actions()).map(a=>a.label)
  expect(labels).toEqual(expect.arrayContaining(['等 5 分钟','等 10 分钟','等 20 分钟']))
  expect(labels).not.toContain('开始 看看时间')
  const state=await f.act('等 5 分钟')
  // The clock closes immediately, so ordinary speech is never routed through an activity that has no NPC participants.
  expect(state.activity?.game).toMatchObject({active:false,public:{时间:'16:05'}})
  const announced=f.events().filter(e=>e.eventType==='character.speak'&&(e.data as WorldJsonObject).characterId==='character:player')
  expect(announced.at(-1)?.data).toMatchObject({text:'',narration:'过了 5 分钟，墙上的钟指向 16:05。离晚饭还有 115 分钟。'})
  // The provider is unreachable, so the first autonomous role fails; reaching it proves the wait triggered autonomy.
  expect(((state.debug.autonomy as WorldJsonObject).activations as unknown[]).length).toBeGreaterThan(0)
  await f.act('等 20 分钟')
  expect((await f.runtime.state()).activity?.game).toMatchObject({active:false,public:{时间:'16:25'}})
  // A management start and a counted operation, so each wait still triggers the declared autonomy.
  expect(f.events().filter(e=>e.eventType==='activity.updated').map(e=>(e.data as WorldJsonObject).operation))
    .toEqual(['start','wait-5','start','wait-20'])
})

it('requires the toolbox to repair the stove, and the stove before a cooked dinner',async()=>{
  const f=await fixture()
  await f.act('前往 厨房（饭桌）')
  const before=(await f.actions()).map(a=>a.label)
  expect(before).toContain('拿取 · 玻璃蒸馏器')
  expect(before).not.toContain('修理 · 灶台')
  expect(before).not.toContain('开火做家常菜 · 晚宴食材')
  await f.act('前往 卧室');await f.act('拿取 · GLM 的工具箱');await f.act('前往 厨房（饭桌）')
  await f.act('修理 · 灶台')
  expect(f.kind('entity:stove')).toBe('灶台：点火正常，可以开火')
  await f.act('用蒸馏器熬高汤做大餐 · 晚宴食材')
  expect(f.kind('entity:ingredients')).toMatch(/^蒸馏高汤赔罪大餐/u)
  expect((await f.actions()).map(a=>a.label)).not.toContain('开火做家常菜 · 晚宴食材')
})

it('lets an early cold platter still be cooked once the stove works',async()=>{
  const f=await fixture()
  await f.act('前往 厨房（饭桌）');await f.act('做一桌凉拌冷盘 · 晚宴食材')
  expect((await f.actions()).map(a=>a.label)).not.toContain('做一桌凉拌冷盘 · 晚宴食材')
  await f.act('前往 卧室');await f.act('拿取 · GLM 的工具箱');await f.act('前往 厨房（饭桌）');await f.act('修理 · 灶台')
  await f.act('开火做家常菜 · 晚宴食材')
  expect(f.kind('entity:ingredients')).toMatch(/^家常晚饭/u)
})

it('seats only invited present characters and reads the dinner the host can see',async()=>{
  const f=await fixture()
  await f.act('前往 厨房（饭桌）')
  await f.act('做一桌凉拌冷盘 · 晚宴食材')
  const state=await f.act('开始 晚宴',{startParameters:{npcIds:['character:deepseek']}})
  expect(state.activity?.game).toMatchObject({public:{晚饭:'凉拌冷盘',入座:'DeepSeek'}})
  expect(String(((state.activity!.game as WorldJsonObject).public as WorldJsonObject).lastResult)).toContain('Claude 的座位空着')
  await expect(f.act('开始 晚宴',{startParameters:{npcIds:['character:claude']}})).rejects.toThrow()
})
