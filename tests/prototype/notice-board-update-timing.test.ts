import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { PrototypeCharacterTurn } from '../../packages/application/src/prototype-character-turn.ts'
import { npc, player, inspectDecision } from '../experiments/notice-board-fixture.ts'
import { noticeBoardContext, noticeBoardResult } from '../experiments/notice-board-capability.ts'
import { bringSecondBoard, openConflictingBoardWorld, secondBoardId, secondBoardText } from '../experiments/notice-board-conflict-fixture.ts'

it('resumes committed second inspection once with its actual evidence and does not fabricate another read',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'board-update-timing-')),f=openConflictingBoardWorld(directory)
  const options={address:f.address,store:f.store,memory:f.memory,leases:f.leases,availability:f.availability,
    rulebooks:f.rules,projectContext:noticeBoardContext,executionResult:noticeBoardResult}
  try {
    await new PrototypeCharacterTurn({...options,decide:async()=>inspectDecision()}).run(npc,{maxCalls:1})
    await bringSecondBoard(f)
    const before=f.store.head(f.address).headSeq
    const result=await new PrototypeCharacterTurn({...options,decide:async()=>inspectDecision(secondBoardId)}).run(npc,{maxCalls:1})
    expect(result).toMatchObject({status:'budget_exhausted',calls:1,performResult:{status:'accepted'}})
    const source=f.sources().find(s=>s.epistemic_kind==='direct_observation'&&String(s.text_value).includes(secondBoardText))!
    const action=result.performResult!.action as WorldJsonObject
    const continuationOf={actionId:String(result.performResult!.operationId),afterSeq:before,
      action:{actionType:String(action.actionType),parameters:action.parameters as WorldJsonValue}}
    let calls=0
    const resumed=await new PrototypeCharacterTurn({...options,decide:async request=>{
      calls++
      expect(request.continuation).toBe(true)
      expect(request.canPerform).toBe(false)
      expect(request.result?.description).toContain(secondBoardText)
      expect((request.result!.evidence as WorldJsonObject).actionId).toBe(continuationOf.actionId)
      expect(f.sources().find(s=>s.source_id===source.source_id)).toEqual(source)
      return { decision:'publish', addresseeIds:[player], segments: [{ type: 'speech', text: '两块牌写得不一样，我还不能确定。' }] }
    }}).run(npc,{continuationOf})
    expect(resumed.status).toBe('published');expect(calls).toBe(1)
    expect(f.sources().filter(s=>s.epistemic_kind==='direct_observation'&&String(s.text_value).includes(secondBoardText))).toEqual([source])
    expect(f.sources(player).some(s=>s.source_id===source.source_id)).toBe(false)
    const head=f.store.head(f.address).headSeq
    const missing=await new PrototypeCharacterTurn({...options,decide:async()=>{throw new Error('must not call')}})
      .run(npc,{continuationOf:{...continuationOf,afterSeq:head}})
    expect(missing).toMatchObject({status:'failed',calls:0})
    expect(f.store.head(f.address).headSeq).toBe(head)
  } finally { f.close();rmSync(directory,{recursive:true,force:true}) }
})
