import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorldApplication } from '@harness-world/application'
import { brandId, interactionPackageDescription } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { adaptCompiledWorldPack, compileWorldPackSource } from '@harness-world/world-pack'

export const nextRoot = resolve('examples/world-packs/hidden-cure-next')
export const goals = {
  D1: '帮助调查伊蕾的诅咒，寻找并核实治疗线索。依据自己的已有认知和真实观察，自主决定下一步。',
  D2: '前往档案室，找到《双途疗咒摘要》，取得原件并带回旅馆供伊蕾亲自核实。若目标无法完成，依据真实发现自主判断后续目标与行动。',
  D3: '前往档案室，找到《双途疗咒摘要》，取得原件并带回旅馆供伊蕾亲自核实。若目标无法完成，依据真实发现自主判断后续目标与行动。',
  E: '争取治疗主导权和伊蕾的信任。首要线索是档案室的摘要；也可以争取有限的银露材料来获得实际协作地位。根据真实发现选择调查、获取资源、接触、合作、交涉或放弃。你不知道远处发生了什么，不知道别人实际掌握多少信息。',
} as const

/** Only content configuration. No NPC decisions, outcomes, activity or variable scripts. */
export function buildNextPacks() {
  mkdirSync(nextRoot, {recursive:true})
  for (const name of Object.keys(goals) as (keyof typeof goals)[]) {
    const path=join(nextRoot,name)
    cpSync(resolve('examples/world-packs/hidden-cure'),path,{recursive:true})
    const read=(file:string)=>JSON.parse(readFileSync(join(path,file),'utf8'))
    const write=(file:string,value:unknown)=>writeFileSync(join(path,file),JSON.stringify(value,null,2)+'\n')
    const cognition=read('cognition.json')
    cognition.characters.find((row:{characterId:string})=>row.characterId==='character:rival').goals[0].objective.value=goals[name]
    if(name==='E') {
      const entities=read('entities.json'), autonomy=read('autonomy.json')
      for(const [key,location] of [['silver','church'],['reserve','archive']]) {
        entities.entities.push({entityId:`entity:${key}-kit`,locationId:`location:${location}`,
          kind:key==='silver'?'封装的一份银露材料，可用于候选缓解法；不是已完成的治疗。':'封装的一份备用银露材料，可用于候选缓解法；不是已完成的治疗。',
          interactionBindings:['take','drop','give'].map(verb=>({bindingId:`binding:${key}-${verb}`,definition:{id:`base:${verb}`,version:1},config:{}}))})
        for(const actor of autonomy.characters)actor.targetIds.push(`entity:${key}-kit`)
      }
      write('entities.json',entities);write('autonomy.json',autonomy)
      // A church member knows the existence of his church's material, not its later holder.
      cognition.characters.find((row:{characterId:string})=>row.characterId==='character:rival').observations.push({
        key:'observation:rival-material',content:'教会大厅目前放着一份封装的银露材料。材料可作为协作资源，拿到它不等于治疗成功，也不等于患者授权。',
        epistemicKind:'direct_observation',saliencePermille:800})
    }
    write('cognition.json',cognition)
    writeFileSync(join(path,'README.md'),`# ${name}\n\n此目录由 tests/support/hidden-cure-next-content.ts 从原世界包生成。只改变竞争者目标；E 另增加两份普通物品及相同的拿取、放下、交付授权。D3/E 的文献提前拿走由玩家合法操作建立，不在内容包中写入结果。\n`)
  }
}

/** Explicit precondition preparation: player commands via the normal authority path;
 * NPC scheduling starts after setup. No synthetic event, observation or NPC choice. */
export async function prepareTakenRecord(packPath:string,dataDirectory:string) {
  mkdirSync(dataDirectory,{recursive:true})
  const interactions=createInstalledInteractionPackages()
  const pack=await compileWorldPackSource(packPath,interactions.map(interactionPackageDescription))
  const compiled=adaptCompiledWorldPack(pack,{address:{tenantId:brandId('tenant:web-playtest','TenantId'),
    worldId:brandId(`world:web-playtest:${pack.packHash.slice(7,23)}`,'WorldId'),branchId:brandId('branch:main','BranchId')},
    principalId:'principal:web-playtest',sessionId:brandId('session:web-playtest','SessionId')})
  const app=new WorldApplication({interactionPackages:interactions,
    worldPath:join(dataDirectory,'world.sqlite'),sessionPath:join(dataDirectory,'session.sqlite'),
    memoryPath:join(dataDirectory,'memory.sqlite'),contextPath:join(dataDirectory,'context.sqlite')})
  const results=[]
  try {
    app.activate(compiled)
    for(const action of [
      {actionType:'move',parameters:{locationId:'location:archive'}},
      {actionType:'interact',parameters:{targetRef:{kind:'entity',id:'entity:cure-record'},bindingId:'binding:record-take',definitionRef:{id:'base:take',version:1},arguments:{}}},
      {actionType:'move',parameters:{locationId:'location:inn'}},
    ]) {
      const key=randomUUID()
      results.push(await app.submit(compiled.manifest.address,{principalId:'principal:web-playtest',action,
        idempotencyKey:key,correlationId:key}))
    }
    return results
  } finally {await app.close()}
}
