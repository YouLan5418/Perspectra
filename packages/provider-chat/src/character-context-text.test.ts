import { expect, it } from 'vitest'
import type { WorldJsonObject } from '@harness-world/contracts'
import { characterRequestText } from './character-context-text.ts'
import { prototypeTurnCall } from './prototype-turn.ts'
const source = {sourceKind:'reported_speech',sourceId:'event:private',sourceHash:'sha256:internal'}
it('removes host evidence metadata while preserving subjective provenance, original speech and action references', () => {
 const context:WorldJsonObject={character:{characterId:'character:a',name:'甲',locationId:'location:kitchen'},
  cognition:{address:{worldId:'world:internal'},characterId:'character:a',asOfWorldSeq:99,bundleHash:'sha256:bundle',
   claims:[{id:'claim:internal',characterId:'character:a',validFromSeq:1,validToSeq:null,sourceRef:source,
    value:{proposition:{text:'乙声称蛋糕在书房'},stance:'suspected',confidencePermille:600,basisRefs:[source]}}]},
  observations:[{id:'observation:internal',sourceSeq:12,value:{observerId:'character:a',actionId:'action:internal',
   content:{actorId:'character:b',status:'accepted',speech:{scope:'private',addresseeIds:['character:a'],segments:[{type:'speech',text:'蛋糕在书房'}]},
    parameters:{operationId:'creator-operation',sourceHash:'creator-reference'},playerInput:{sourceText:'原始完整输入',sourceSpans:[{actionId:'action:internal',startUtf16:0,endUtf16:6}]}}}}],
  memories:[{memoryId:'memory:internal',sourceIds:['event:private'],sourceAgeTicks:5,epistemicKind:'reported_speech',text:'仅听说，并未目击',keyEvidence:[source]}],
  stimulus:[{observerId:'character:a',actionId:'action:internal',content:{actorId:'character:b',status:'accepted'}}],
  affordances:[{actionType:'interact',interactions:[{targetRef:{id:'entity:cake',kind:'entity'},bindingId:'binding:give',definitionRef:{id:'base:give',version:1},arguments:{recipientId:'character:b'}}]}],
  activity:{id:'activity:game',revision:9,game:{turn:'character:a'}},packVariables:{private:{sourceHash:'creator-authored-value'}}}
 const request={context,continuation:true,result:{operationId:'operation:internal',eventRefs:[99],status:'accepted',description:'已经交付',action:{actionType:'interact',parameters:{targetRef:{id:'entity:cake',kind:'entity'}}}}}
 const before=JSON.stringify(request), rendered=JSON.parse(prototypeTurnCall(request).messages.at(-1)!.content)
 for(const text of ['sha256:internal','sha256:bundle','world:internal','event:private','claim:internal','observation:internal','action:internal','operation:internal'])expect(JSON.stringify(rendered)).not.toContain(text)
 expect(rendered.context.cognition.claims[0].value).toMatchObject({stance:'suspected',confidencePermille:600,basisRefs:[{sourceKind:'reported_speech'}]})
 expect(rendered.context.history[0].content.content).toMatchObject({actorId:'character:b',speech:{scope:'private',addresseeIds:['character:a']},parameters:{operationId:'creator-operation',sourceHash:'creator-reference'},playerInput:{sourceText:'原始完整输入'}})
 expect(rendered.context.memories[0]).toMatchObject({sourceAgeTicks:5,epistemicKind:'reported_speech',text:'仅听说，并未目击'})
 expect(rendered.context.affordances).toEqual(context.affordances)
 expect(rendered.context.activity).toEqual(context.activity)
 expect(rendered.context.packVariables).toEqual(context.packVariables)
 expect(rendered.result).toMatchObject({status:'accepted',description:'已经交付',action:request.result.action})
 expect(rendered.context.character.locationId).toBeUndefined()
 expect(rendered.context.locationId).toBe('location:kitchen')
 expect(JSON.stringify(request)).toBe(before)
})
it('merges observed and self history in stable chronological order, leaving new stimulus after history', () => {
 const request={context:{character:{characterId:'a',locationId:'kitchen'},observations:[
  {sourceSeq:4,value:{content:{actorId:'b',speech:{segments:[{type:'speech',text:'稍后的对白'}]}}}},
  {sourceSeq:1,value:{content:{actorId:'b',speech:{segments:[{type:'speech',text:'最早的对白'}]}}}}],
  selfObservations:[{sourceSeq:2,content:{actionType:'speak',segments:[{type:'speech',text:'我自己的回答'}]}}],stimulus:[{content:{text:'新刺激'}}]},continuation:false}
 const before=characterRequestText(request), initial=JSON.parse(before)
 expect(initial.context.history.map((r:WorldJsonObject)=>r.kind)).toEqual(['observed','self','observed'])
 expect(initial.context.history[0].content.content.speech.segments[0].text).toBe('最早的对白')
 request.context.selfObservations.push({sourceSeq:5,content:{actionType:'speak',segments:[{type:'speech',text:'新回答'}]}})
 request.context.stimulus=[{content:{text:'另一个刺激'}}]
 const after=characterRequestText(request),next=JSON.parse(after)
 expect(next.context.history.slice(0,3)).toEqual(initial.context.history)
 expect(after.startsWith(before.slice(0,before.indexOf('],"stimulus"')))).toBe(true)
 expect(after.indexOf('新回答')).toBeLessThan(after.indexOf('另一个刺激'))
 expect(next.context.observations).toBeUndefined()
 expect(next.context.selfObservations).toBeUndefined()
})
it('keeps occurrence-only private observations occurrence-only and preserves custom fallback evidence', () => {
 const request={context:{observations:[{sourceSeq:1,value:{observerId:'a',actionId:'op',content:{actorId:'b',actionType:'private_interaction',contentVisibility:'occurrence_only'}}},{text:'授权的自定义观察'}],selfObservations:[]}}
 const rendered=JSON.parse(characterRequestText(request))
 expect(rendered.context.history[0].content).toEqual({content:{actorId:'b',actionType:'private_interaction',contentVisibility:'occurrence_only'}})
 expect(rendered.context.history[1].content).toEqual({text:'授权的自定义观察'})
})
