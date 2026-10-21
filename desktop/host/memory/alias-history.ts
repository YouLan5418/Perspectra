import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { worldAddressKey, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'

export function identityEntry(context: WorldJsonObject, scope: WorldJsonObject, worldSeq: number): WorldJsonObject {
 const character=context.character as WorldJsonObject
 if(character.characterId!==scope.characterId)throw new Error('identity context belongs to another character')
 if(!Number.isSafeInteger(worldSeq)||worldSeq<0)throw new Error('invalid identity prefix')
 const scene=context.scene as WorldJsonObject
 const people=[character,...((scene.people as WorldJsonObject[]|undefined)??[])]
  .flatMap(p=>typeof p.characterId==='string'&&typeof p.name==='string'? [{characterId:p.characterId,name:p.name}]:[])
 return {scope,worldSeq,people}
}

// Reuse recorded authorized views from completed rounds; never infer names from the full manifest.
export function restoreAliasHistory(root:string, rounds:{traceIds:string[]}[], address:WorldAddress, headSeq:number):Map<string,WorldJsonObject[]> {
 const history=new Map<string,WorldJsonObject[]>()
 for(const id of rounds.flatMap(r=>r.traceIds)){
  if(!/^turn-\d+-call-\d+-[a-zA-Z0-9_-]+$/.test(id))throw new Error('invalid completed trace ID')
  const trace=JSON.parse(readFileSync(resolve(root,'traces',id+'.json'),'utf8')) as {
   actorId:string;headSeq:number;snapshot:string;hostRequest:{context:WorldJsonObject}}
  const snapshot=JSON.parse(readFileSync(resolve(root,trace.snapshot),'utf8')) as {scope:WorldJsonObject}
  const scope=snapshot.scope
  if(worldAddressKey(scope.worldAddress as WorldAddress)!==worldAddressKey(address)
    ||scope.characterId!==trace.actorId||Number(scope.asOfWorldSeq)>trace.headSeq||trace.headSeq>headSeq)
   throw new Error('identity trace crosses character, world or authorized prefix')
  const entries=history.get(trace.actorId)??[]
  entries.push(identityEntry(trace.hostRequest.context,scope,trace.headSeq))
  history.set(trace.actorId,entries)
 }
 return history
}
