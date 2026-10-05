import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { brandId, resolutionAuthority, type WorldJsonObject } from '@harness-world/contracts'
import { currentLocation } from '@harness-world/kernel'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { openCapabilityWorld, inspectDecision, npc, player, bob, playerText } from '../experiments/notice-board-fixture.ts'
import { boardText, privateText, noticeBoardContext, noticeBoardResult } from '../experiments/notice-board-capability.ts'

const cleanup: (()=>void)[]=[]
afterEach(()=>{ for(const f of cleanup.splice(0).reverse())f() })
function setup() {
  const dir=mkdtempSync(join(tmpdir(),'board-capability-'))
  cleanup.push(()=>rmSync(dir,{recursive:true,force:true}))
  const f=openCapabilityWorld(dir);cleanup.push(f.close)
  return f
}
function turn(f:ReturnType<typeof setup>,decide:(r:PrototypeTurnRequest)=>Promise<unknown>) {
  return new PrototypeCharacterTurn({address:f.address,store:f.store,memory:f.memory,
    leases:f.leases,availability:f.availability,rulebooks:f.rules,projectContext:noticeBoardContext,
    executionResult:noticeBoardResult,decide})
}
function reads(f:ReturnType<typeof setup>) {
  return f.store.readEvents(f.address).filter(e=>e.eventType==='observation.upsert'
    && ((e.data as WorldJsonObject).value as WorldJsonObject).epistemicKind==='direct_observation'
    && typeof (((e.data as WorldJsonObject).value as WorldJsonObject).content)==='object')
}

it('lists only reachable authorized boards and never reads their text during affordance generation',async()=>{
  const f=setup(),before=f.store.head(f.address).headSeq
  await turn(f,async r=>{
    expect(JSON.stringify(r)).not.toContain(boardText)
    expect(JSON.stringify(r)).not.toContain(privateText)
    const a=(r.context.affordances as WorldJsonObject[]).find(a=>a.actionType==='interact')!
    expect((a.interactions as WorldJsonObject[]).map(c=>(c.targetRef as WorldJsonObject).id)).toEqual(['entity:hall-board'])
    return {decision:'abstain'}
  }).run(npc)
  expect(f.store.head(f.address).headSeq).toBe(before)
  expect(reads(f)).toHaveLength(0)
})

it('commits a real inspection before continuation, captures own Source and keeps bystanders separate',async()=>{
  const f=setup(),stimulus=await f.submitPlayer(playerText,'initial')
  let calls=0
  await turn(f,async r=>{
    if(++calls===1){expect(JSON.stringify(r)).not.toContain(boardText);return inspectDecision()}
    expect(reads(f)).toHaveLength(1)
    expect(r.result?.description).toContain(boardText)
    expect(JSON.stringify(r.context.observations)).toContain(boardText)
    expect(f.sources().filter(s=>s.epistemic_kind==='direct_observation'&&String(s.text_value).includes(boardText))).toHaveLength(1)
    return {decision:'publish',speech:'牌子上写着二楼203。',addresseeIds:[player]}
  }).run(npc,{stimulus,maxCalls:2})
  const events=f.store.readEvents(f.address),read=reads(f)[0]!
  const value=(read.data as WorldJsonObject).value as WorldJsonObject
  const action=events.find(e=>e.eventType==='action.resolved'&&(e.data as WorldJsonObject).actionId===value.actionId)!
  expect(action.tick).toBe(read.tick)
  expect(events.find(e=>e.eventType==='world.tick-advanced'&&e.tick===read.tick)).toBeDefined()
  const source=f.sources().find(s=>s.source_seq===read.seq)!
  expect(source.source_id).toBe('event:'+read.seq)
  expect(source.source_hash).toBe(read.eventHash)
  expect(source.namespace_key).toBe([f.address.tenantId,f.address.worldId,f.address.branchId,npc].join('\x1f'))
  for(const observer of [player,bob]){
    expect(f.sources(observer).some(s=>s.source_seq===read.seq)).toBe(false)
    expect(f.sources(observer).some(s=>s.epistemic_kind==='direct_observation'&&String(s.text_value).includes(boardText))).toBe(false)
  }
  expect(f.sources(player).filter(s=>String(s.text_value).includes('203')).every(s=>s.epistemic_kind==='reported_speech')).toBe(true)
})

it.each(['entity:private-board','entity:distant-board'])('rejects a guessed %s without a reading Source',async target=>{
  const f=setup();let calls=0
  const result=await turn(f,async r=>{
    if(++calls===1)return inspectDecision(target)
    expect(r.result?.status).toBe('rejected')
    expect(JSON.stringify(r)).not.toContain(boardText)
    expect(JSON.stringify(r)).not.toContain(privateText)
    return {decision:'abstain'}
  }).run(npc)
  expect(result.performResult?.status).toBe('rejected')
  expect(reads(f)).toHaveLength(0)
})
it('rejects a stale board option after the character moves away',async()=>{
  const f=setup()
  await turn(f,async r=>r.continuation?{decision:'abstain'}:
    {decision:'perform',actionType:'move',parameters:{locationId:'location:next'}}).run(npc)
  expect(currentLocation(f.store.readEvents(f.address),npc)).toBe('location:next')
  const result=await turn(f,async r=>r.continuation?{decision:'abstain'}:inspectDecision()).run(npc)
  expect(result.performResult?.status).toBe('rejected')
  expect(reads(f)).toHaveLength(0)
})
it.each([{text:'forged truth'},{query:'SELECT *'},{statement:'registration is next door'},{readerId:npc}])(
  'rejects arbitrary read arguments %j',async args=>{
    const f=setup()
    const result=await turn(f,async r=>r.continuation?{decision:'abstain'}:inspectDecision('entity:hall-board',args)).run(npc)
    expect(result.performResult?.status).toBe('rejected')
    expect(reads(f)).toHaveLength(0)
  })
it('a published claim of inspection stays speech and never invokes the reader',async()=>{
  const f=setup()
  await turn(f,async()=>({decision:'publish',speech:'我已经看过公告牌了，写的是二楼203。'})).run(npc)
  expect(reads(f)).toHaveLength(0)
  const sources=f.sources().filter(s=>String(s.text_value).includes('203'))
  expect(sources.length).toBeGreaterThan(0)
  expect(sources.every(s=>s.epistemic_kind==='reported_speech')).toBe(true)
})
it('mixed perform and success narration is rejected as a whole before commit',async()=>{
  const f=setup(),before=f.store.head(f.address).headSeq
  const result=await turn(f,async()=>({...inspectDecision(),narration:'我已经看到203了。'})).run(npc)
  expect(result.failure).toBe('invalid_output')
  expect(f.store.head(f.address).headSeq).toBe(before)
})
it('refuses to render an accepted result without evidence',()=>{
  const f=setup(),decision=inspectDecision()
  expect(()=>noticeBoardResult({manifest:f.world.manifest,events:f.store.readEvents(f.address),actorId:npc,
    action:{actionType:'interact',parameters:decision.parameters},status:'accepted',reason:null})).toThrow()
})
it('permission applies to the actual actor, while the private reader can inspect its own board',()=>{
  const f=setup(),rule=f.rules.resolve(f.world.manifest.rulebook.rulebookId,f.world.manifest.rulebook.version,'test',f.address)
  const resolution=rule.resolve({manifest:f.world.manifest,manifestHash:f.world.manifestHash,
    events:f.store.readEvents(f.address),characterId:bob,asOfWorldSeq:f.store.head(f.address).headSeq,
    resolutionAuthority:resolutionAuthority('agent','standard'),roundId:brandId('private-reader','InteractionRoundId'),
    actionId:'private-reader:action',action:{actionType:'interact',parameters:inspectDecision('entity:private-board').parameters}})
  expect(resolution.status).toBe('accepted')
  expect(JSON.stringify(resolution.events)).toContain(privateText)
  expect(((resolution.events[0]!.data as WorldJsonObject).value as WorldJsonObject).observerId).toBe(bob)
})

it('rolls back read evidence with the action when the existing world transaction fails',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'board-rollback-'))
  cleanup.push(()=>rmSync(dir,{recursive:true,force:true}))
  let armed=false,calls=0
  const f=openCapabilityWorld(dir,{hit:point=>{
    if(armed&&point==='store.before-commit')throw new Error('controlled commit failure')
  }})
  cleanup.push(f.close)
  const head=f.store.head(f.address),initialSources=f.sources()
  armed=true
  await expect(turn(f,async()=>{calls++;return inspectDecision()}).run(npc)).rejects.toThrow('controlled commit failure')
  expect(calls).toBe(1)
  expect(f.store.head(f.address)).toEqual(head)
  expect(reads(f)).toHaveLength(0)
  expect(f.sources()).toEqual(initialSources)
})
