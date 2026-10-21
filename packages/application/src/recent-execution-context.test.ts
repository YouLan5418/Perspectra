import { expect, it } from 'vitest'
import type { WorldJsonObject } from '@harness-world/contracts'
import { recentExecutionContext, RECENT_EXECUTION_LIMITS } from './recent-execution-context.ts'
import { characterRequestText } from '../../provider-chat/src/character-context-text.ts'
import { characterTurnCall } from '../../provider-chat/src/character-turn-call.ts'

const observation=(seq:number,content:WorldJsonObject,patch:WorldJsonObject={})=>({id:`o:${seq}`,sourceSeq:seq,
 value:{observerId:'character:a',actionId:`action:${seq}`,content},...patch})
const context=(observations:WorldJsonObject[]):WorldJsonObject=>({character:{characterId:'character:a'},cognition:{asOfWorldSeq:20},observations})
const move={actorId:'character:a',actionType:'move',status:'accepted',movement:{characterId:'character:a',toLocationId:'location:archive'},resultDescription:'移动已执行。'}

it('presents an arrival without inferring a search, goal progress or completion',()=>{
 const input=context([observation(1,move)])
 const result=recentExecutionContext(input)
 expect(result.recentExecutionEvidence).toMatchObject({items:[{actionType:'move',toLocationId:'location:archive',result:'accepted',sourceSeq:1}]})
 expect(result).not.toHaveProperty('goalProgress')
 expect(JSON.stringify(result.recentExecutionEvidence)).not.toMatch(/search|blocked|completed/)
 expect(input).not.toHaveProperty('recentExecutionEvidence')
})

it('does not mine speech, subjective memories, invalid ownership, future or missing sources',()=>{
 const input={...context([
  observation(1,{...move,actionType:'speak',speech:{text:'已经找到原件'}}),
  observation(2,move,{value:{observerId:'character:b',actionId:'foreign',content:{...move,resultDescription:'私密暗号'}}}),
  observation(21,move),observation(0,move),observation(3,move,{id:null}),
  observation(4,{...move,actionType:'private_interaction'}),
 ]),memories:[{epistemicKind:'subjective_inference',text:'查找失败了'}],selfObservations:[{sourceSeq:8,content:{actionType:'speak',text:'拿到了'}}]}
 expect(recentExecutionContext(input)).toBe(input)
 expect(recentExecutionContext({...input,cognition:{}})).toEqual({...input,cognition:{}})
 expect(recentExecutionContext({...context([observation(1,move)]),cognition:{asOfWorldSeq:20,characterId:'character:b'}})).not.toHaveProperty('recentExecutionEvidence')
})

it('retains a finite custom outcome and rejects neither the route nor the goal',()=>{
 const input=context([observation(2,{actorId:'character:a',actionType:'interact',status:'accepted',resultDescription:'仅西架未发现目标。',resultMetadata:{definitionId:'author:search',range:'west',finding:'not_found'}}),
  observation(3,{actorId:'character:a',actionType:'interact',status:'rejected',resultDescription:'目标当前不可接触。'})])
 const result=recentExecutionContext(input)
 expect(result.recentExecutionEvidence).toMatchObject({items:[{result:'accepted',resultMetadata:{range:'west',finding:'not_found'}},{result:'rejected',description:'目标当前不可接触。'}]})
 expect(JSON.stringify(result.recentExecutionEvidence)).not.toContain('blocked')
 const text=characterRequestText({context:result,canPerform:false})
 expect(text).not.toMatch(/sourceSeq|observationId|actionId/)
 expect(text).toContain('not_found')
 expect(characterTurnCall({context:result,continuation:false,canPerform:false}).messages[0]!.content).toContain('失败也不必然要求立即换方案')
 expect(characterTurnCall({context:input,continuation:false,canPerform:false}).messages[0]!.content).not.toContain('recentExecutionEvidence 是')
})

it('records an observed transfer without attributing another actor to the reader',()=>{
 const result=recentExecutionContext(context([observation(2,{actorId:'character:b',actionType:'interact',status:'accepted',
  interaction:{characterId:'character:b',interactionId:'base:give',entityId:'entity:paper',toHolderId:'character:a',toLocationId:null}})]))
 expect(result.recentExecutionEvidence).toMatchObject({items:[{actorId:'character:b',definitionId:'base:give',entityId:'entity:paper',toHolderId:'character:a'}]})
})

it('deduplicates one execution, enforces the count and text budget, and skips oversized evidence intact',()=>{
 const rows=Array.from({length:15},(_,index)=>observation(index+1,move))
 rows.push(observation(18,{...move,resultDescription:'字'.repeat(2000)}))
 const projected=recentExecutionContext(context(rows)).recentExecutionEvidence as WorldJsonObject
 expect((projected.items as unknown[]).length).toBeLessThanOrEqual(RECENT_EXECUTION_LIMITS.maximumItems)
 expect(JSON.stringify(projected).length).toBeLessThanOrEqual(RECENT_EXECUTION_LIMITS.maximumJsonCharacters)
 expect(JSON.stringify(projected)).not.toContain('字')
 const source=observation(1,{actorId:'character:a',actionType:'interact',status:'accepted',resultMetadata:{finding:'not_found'}})
 const duplicate=observation(2,{actorId:'character:a',actionType:'interact',status:'accepted',resultDescription:'通用成功反馈。'},
  {value:{observerId:'character:a',actionId:source.value.actionId,content:{actorId:'character:a',actionType:'interact',status:'accepted',resultDescription:'通用成功反馈。'}}})
 const dedup=recentExecutionContext(context([source,duplicate])).recentExecutionEvidence as WorldJsonObject
 expect(dedup.items).toHaveLength(1)
 expect(dedup.items).toMatchObject([{sourceSeq:1,resultMetadata:{finding:'not_found'}}])
})
