import { expect, it } from 'vitest'
import type { WorldJsonObject } from '@harness-world/contracts'
import { inscriptionReadings } from '../experiments/notice-board-evidence-delivery.ts'

// Self-contained test evidence; the real experiment uses the audited frozen archive.
function archive():WorldJsonObject {
  const address={tenantId:'tenant:test',worldId:'world:test',branchId:'branch:test'}
  const sources=['entity:hall-board','entity:distant-board'].map((targetId,index)=>{
    const content={actorId:'character:npc',capabilityId:'experiment:inspect-notice-board',targetId,
      observedText:index===0?'登记处：二楼203':'登记处：一楼105',
      description:'你亲眼看到公告牌上写着：'+(index===0?'登记处：二楼203':'登记处：一楼105')}
    return {sourceId:'test:'+index,sourceHash:'hash:'+index,epistemicKind:'direct_observation',
      worldSeq:index+1,knownTick:index+2,characterId:'character:npc',worldAddress:address,text:JSON.stringify(content)}
  })
  const facts=sources.map(s=>({id:'atom:'+s.sourceId,memoryLevel:'event_atom',text:'raw atom text',
    sourceRefs:[{sourceId:s.sourceId,sourceHash:s.sourceHash,epistemicKind:s.epistemicKind,
      worldSeq:s.worldSeq,characterId:s.characterId,worldAddress:s.worldAddress}],
    evidence:{context:s.text,quote:s.text,sourceId:s.sourceId},knownTickStart:s.knownTick,knownTickEnd:s.knownTick}))
  return {scope:{characterId:'character:npc',worldAddress:address,asOfWorldSeq:2},sources,facts}
}
it('projects exact host descriptions without changing atoms, evidence mappings or adding conclusions',()=>{
  const input=archive(),before=JSON.stringify(input),readings=inscriptionReadings(input,4,'separate')
  expect(readings.map(r=>r.text)).toEqual([
    '【本角色的直接观察】大厅公告牌：你亲眼看到公告牌上写着：登记处：二楼203',
    '【本角色的直接观察】窗口指示牌：你亲眼看到公告牌上写着：登记处：一楼105'])
  expect(readings.map(r=>r.sourceAgeTicks)).toEqual([2,1])
  expect(readings.map(r=>r.sourceRefs)).toEqual((input.facts as WorldJsonObject[]).map(a=>a.sourceRefs))
  expect(JSON.stringify(input)).toBe(before)
})
it('pairs two atoms as one delivery item while preserving both ids and citations',()=>{
  const input=archive(),parts=inscriptionReadings(input,4,'separate'),paired=inscriptionReadings(input,4,'paired')
  expect(paired).toHaveLength(1)
  expect(paired[0]!.text).toBe(parts.map(p=>p.text).join('\n'))
  expect(paired[0]!.eventAtomIds).toEqual(['atom:test:0','atom:test:1'])
  expect(paired[0]!.sourceRefs).toEqual(parts.flatMap(p=>p.sourceRefs as WorldJsonObject[]))
  expect(paired[0]!.sourceAgeTicks).toBe(1)
})
it.each(['foreign-owner','foreign-world','future','changed-hash','speech','altered-atom','unknown-sign','repeated-source'])(
  'rejects %s rather than projecting it as a direct read',kind=>{
    const input=JSON.parse(JSON.stringify(archive()))
    const source=input.sources[0],atom=input.facts[0],ref=atom.sourceRefs[0]
    if(kind==='foreign-owner')source.characterId=ref.characterId='character:bob'
    if(kind==='foreign-world')source.worldAddress.worldId=ref.worldAddress.worldId='world:foreign'
    if(kind==='future')source.worldSeq=ref.worldSeq=3
    if(kind==='changed-hash')ref.sourceHash='different'
    if(kind==='speech')source.epistemicKind=ref.epistemicKind='reported_speech'
    if(kind==='altered-atom')atom.evidence.context='forged'
    if(kind==='unknown-sign'){
      const content=JSON.parse(source.text);content.targetId='entity:unknown'
      source.text=atom.evidence.context=atom.evidence.quote=JSON.stringify(content)
    }
    if(kind==='repeated-source')input.facts[1]=input.facts[0]
    expect(()=>inscriptionReadings(input,4,'separate')).toThrow()
  })
