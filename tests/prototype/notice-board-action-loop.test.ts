import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PrototypeCharacterTurn } from '../../packages/application/src/prototype-character-turn.ts'
import { openActionWorld, actionContext, actionResult, evidenceDecision, askId, terminalId,
  staffText, terminalText } from '../experiments/notice-board-action-fixture.ts'
import { npc, player, bob } from '../experiments/notice-board-fixture.ts'
import type { WorldJsonObject } from '@harness-world/contracts'
const cleanup:(()=>void)[]=[]
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f()})
function setup(fault?:Parameters<typeof openActionWorld>[2]){
  const dir=mkdtempSync(join(tmpdir(),'evidence-action-'))
  cleanup.push(()=>rmSync(dir,{recursive:true,force:true}))
  const f=openActionWorld(dir,false,fault);cleanup.push(f.close);return f
}
it('exposes both acquisition choices and both destinations without disclosing hidden response text',async()=>{
  const f=setup()
  const turn=new PrototypeCharacterTurn({...f,projectContext:actionContext,executionResult:actionResult,
    rulebooks:f.rules,decide:async request=>{
      expect(JSON.stringify(request)).not.toContain(staffText)
      expect(JSON.stringify(request)).not.toContain(terminalText)
      const affordances=request.context.affordances as WorldJsonObject[]
      expect(JSON.stringify(affordances)).toContain(askId)
      expect(JSON.stringify(affordances)).toContain(terminalId)
      expect(JSON.stringify(affordances)).toContain('location:203')
      expect(JSON.stringify(affordances)).toContain('location:105')
      return {decision:'abstain'}
    }})
  expect((await turn.run(npc)).status).toBe('abstained')
})
it.each([[askId,'reported_speech',staffText],[terminalId,'direct_observation',terminalText]])(
  '%s produces an atomic attributed Source before expression, never a location truth',async(id,kind,text)=>{
    const f=setup();let calls=0
    const turn=new PrototypeCharacterTurn({...f,rulebooks:f.rules,executionResult:actionResult,projectContext:actionContext,
      decide:async r=>{
        if(++calls===1)return evidenceDecision(id)
        expect(r.result?.status).toBe('accepted')
        expect(r.result?.description).toContain(text)
        const rows=f.sources().filter(s=>String(s.text_value).includes(text!))
        expect(rows).toHaveLength(1);expect(rows[0]!.epistemic_kind).toBe(kind)
        for(const observer of [player,bob])expect(f.sources(observer).some(s=>s.source_seq===rows[0]!.source_seq)).toBe(false)
        return {decision:'abstain'}
      }})
    const r=await turn.run(npc)
    expect(r.performResult?.status).toBe('accepted')
    const events=f.store.readEvents(f.address),row=f.sources().find(s=>String(s.text_value).includes(text!))!
    const source=events.find(e=>e.seq===row.source_seq)!
    const value=(source.data as WorldJsonObject).value as WorldJsonObject
    const accepted=events.find(e=>e.eventType==='action.resolved'&&(e.data as WorldJsonObject).actionId===value.actionId)!
    expect(source.transactionId).toBe(accepted.transactionId)
    expect(row.source_hash).toBe(source.eventHash)
    expect(events.some(e=>e.eventType==='character.moved')).toBe(false)
})
it('speech promising to ask staff does not call the capability or produce its reply',async()=>{
  const f=setup(),turn=new PrototypeCharacterTurn({...f,rulebooks:f.rules,
    decide:async()=>({ decision:'publish', segments: [{ type: 'speech', text: '我去问问工作人员。' }] })})
  await turn.run(npc)
  expect(f.sources().some(s=>String(s.text_value).includes(staffText))).toBe(false)
})
it('forged arguments produce no acquired evidence',async()=>{
  const f=setup(),d=evidenceDecision()
  const turn=new PrototypeCharacterTurn({...f,rulebooks:f.rules,executionResult:actionResult,
    decide:async r=>r.continuation?{decision:'abstain'}:{...d,parameters:{...d.parameters,arguments:{text:'forged'}}}})
  expect((await turn.run(npc)).performResult?.status).toBe('rejected')
  expect(f.sources().some(s=>String(s.text_value).includes(staffText))).toBe(false)
})
it('a stale acquisition after moving is rejected without a Source',async()=>{
  const f=setup()
  const turn=new PrototypeCharacterTurn({...f,rulebooks:f.rules,executionResult:actionResult,
    decide:async r=>r.continuation?{decision:'abstain'}:{decision:'perform',actionType:'move',parameters:{locationId:'location:105'}}})
  expect((await turn.run(npc)).performResult?.status).toBe('accepted')
  const stale=new PrototypeCharacterTurn({...f,rulebooks:f.rules,executionResult:actionResult,
    decide:async r=>r.continuation?{decision:'abstain'}:evidenceDecision()})
  expect((await stale.run(npc)).performResult?.status).toBe('rejected')
  expect(f.sources().some(s=>String(s.text_value).includes(staffText))).toBe(false)
})
it('an interrupted commit rolls back the acquired Source with the accepted action',async()=>{
  let armed=false
  const f=setup({hit:point=>{if(armed&&point==='store.before-commit')throw new Error('controlled commit failure')}})
  const before=f.store.head(f.address);armed=true
  const turn=new PrototypeCharacterTurn({...f,rulebooks:f.rules,executionResult:actionResult,decide:async()=>evidenceDecision()})
  await expect(turn.run(npc)).rejects.toThrow('controlled commit failure')
  expect(f.store.head(f.address)).toEqual(before)
  expect(f.sources().some(s=>String(s.text_value).includes(staffText))).toBe(false)
})
