/** Deterministic delivery of existing authorized inscription atoms, no cognition rewrite. */
import type { WorldJsonObject } from '@harness-world/contracts'

const labels:Record<string,string>={'entity:hall-board':'大厅公告牌','entity:distant-board':'窗口指示牌'}
function object(value:unknown):WorldJsonObject {
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('expected evidence object')
  return value as WorldJsonObject
}
export function inscriptionReadings(archive:WorldJsonObject,nowTick:number,mode:'separate'|'paired'):WorldJsonObject[] {
  const scope=object(archive.scope),address=object(scope.worldAddress)
  if(!Array.isArray(archive.sources)||!Array.isArray(archive.facts)||archive.facts.length!==2)
    throw new Error('this experiment requires exactly two inscription atoms')
  const atoms=archive.facts as WorldJsonObject[],sources=archive.sources as WorldJsonObject[]
  const readings=atoms.map(atom=>{
    if(atom.memoryLevel!=='event_atom'||!Array.isArray(atom.sourceRefs)||atom.sourceRefs.length!==1)
      throw new Error('expected single-source inscription atom')
    const ref=object(atom.sourceRefs[0]),source=sources.find(s=>s.sourceId===ref.sourceId)
    if(!source)throw new Error('missing canonical source')
    const sourceAddress=object(source.worldAddress),refAddress=object(ref.worldAddress)
    for(const field of ['tenantId','worldId','branchId'])
      if(sourceAddress[field]!==address[field]||refAddress[field]!==address[field])throw new Error('foreign world evidence')
    for(const field of ['sourceId','sourceHash','worldSeq','characterId','epistemicKind'])
      if(ref[field]!==source[field])throw new Error('source mapping changed')
    if(source.characterId!==scope.characterId||source.epistemicKind!=='direct_observation'
      ||Number(source.worldSeq)>Number(scope.asOfWorldSeq)||Number(source.knownTick)>nowTick)
      throw new Error('unauthorized or future observation')
    const content=object(JSON.parse(String(source.text))),evidence=object(atom.evidence)
    if(content.actorId!==scope.characterId||content.capabilityId!=='experiment:inspect-notice-board'
      ||evidence.context!==source.text||evidence.quote!==source.text||evidence.sourceId!==source.sourceId
      ||typeof content.observedText!=='string'
      ||content.description!=='你亲眼看到公告牌上写着：'+content.observedText)
      throw new Error('not an unmodified host-owned inscription observation')
    const label=labels[String(content.targetId)]
    if(!label)throw new Error('unknown sign identity')
    if(atom.knownTickStart!==source.knownTick||atom.knownTickEnd!==source.knownTick)throw new Error('evidence time differs')
    return {memoryId:atom.id!,memoryLevel:'event_atom',epistemicKind:'direct_observation',
      text:'【本角色的直接观察】'+label+'：'+String(content.description),
      sourceIds:[source.sourceId!],sourceRefs:atom.sourceRefs,sourceAgeTicks:nowTick-Number(source.knownTick)}
  })
  if(new Set(readings.flatMap(r=>r.sourceIds as string[])).size!==2)throw new Error('repeated source')
  if(mode==='separate')return readings
  if(mode!=='paired')throw new Error('unknown delivery mode')
  return [{memoryId:'delivery:inscription-pair',memoryLevel:'event_atom',epistemicKind:'direct_observation',
    eventAtomIds:atoms.map(a=>a.id!),
    text:readings.map(r=>r.text).join('\n'),
    sourceIds:readings.flatMap(r=>r.sourceIds as string[]),
    sourceRefs:readings.flatMap(r=>r.sourceRefs as WorldJsonObject[]),
    sourceAgeTicks:Math.min(...readings.map(r=>Number(r.sourceAgeTicks)))}]
}
