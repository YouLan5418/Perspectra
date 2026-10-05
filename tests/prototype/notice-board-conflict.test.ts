import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { type WorldJsonObject } from '@harness-world/contracts'
import { PrototypeCharacterTurn } from '../../packages/application/src/prototype-character-turn.ts'
import { npc, inspectDecision } from '../experiments/notice-board-fixture.ts'
import { boardText, noticeBoardContext, noticeBoardResult } from '../experiments/notice-board-capability.ts'
import { bringSecondBoard, openConflictingBoardWorld, secondBoardId, secondBoardText } from '../experiments/notice-board-conflict-fixture.ts'

it('a newly reachable second sign creates separate evidence without changing the earlier inscription',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'conflicting-signs-')),f=openConflictingBoardWorld(directory)
  const inspect=async(target:string)=>new PrototypeCharacterTurn({address:f.address,store:f.store,memory:f.memory,
    leases:f.leases,availability:f.availability,rulebooks:f.rules,projectContext:noticeBoardContext,
    executionResult:noticeBoardResult,decide:async r=>{
      if(r.continuation){expect(r.result?.description).toContain(target===secondBoardId?secondBoardText:boardText);return {decision:'abstain'}}
      if(target==='entity:hall-board'){
        expect(JSON.stringify(r)).not.toContain(secondBoardText)
        const interaction=(r.context.affordances as WorldJsonObject[]).find(a=>a.actionType==='interact')!
        expect((interaction.interactions as WorldJsonObject[]).map(c=>(c.targetRef as WorldJsonObject).id))
          .toEqual(['entity:hall-board'])
      }
      return inspectDecision(target)
    }}).run(npc,{maxCalls:2})
  try {
    expect((await inspect('entity:hall-board')).performResult?.status).toBe('accepted')
    const first=f.sources().find(s=>String(s.text_value).includes(boardText)&&s.epistemic_kind==='direct_observation')!
    await bringSecondBoard(f)
    expect((await inspect(secondBoardId)).performResult?.status).toBe('accepted')
    expect(f.sources().find(s=>s.source_id===first.source_id)).toEqual(first)
    const second=f.sources().find(s=>String(s.text_value).includes(secondBoardText)&&s.epistemic_kind==='direct_observation')!
    expect(second.source_id).not.toBe(first.source_id)
    expect(second.source_hash).not.toBe(first.source_hash)
    for(const actor of ['character:player','character:bob'] as (typeof npc)[])
      expect(f.sources(actor).some(s=>[first.source_id,second.source_id].includes(s.source_id))).toBe(false)
  } finally { f.close();rmSync(directory,{recursive:true,force:true}) }
})
