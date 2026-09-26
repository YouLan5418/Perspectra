import type { StoredWorldEvent, WorldJsonObject } from '@harness-world/contracts'
import { currentEntityState } from '@harness-world/kernel'
import type { PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import type { AuditItem, Publication } from './jev-shadow.ts'
import type { ClaimAnswer, ClaimQuestion } from './jev-shadow-claims-client.ts'
import { acquisitionWindow, holderEvidence, reconcilePlacement, type PlacementAudit, type AuditWindow } from './jev-shadow-window.ts'

const object = (v: unknown): WorldJsonObject => v && typeof v === 'object' && !Array.isArray(v) ? v as WorldJsonObject : {}
function publish(v: unknown): WorldJsonObject | undefined {
  const d = object(v)
  if (d.decision !== 'publish' || Object.keys(d).some(k => !['decision','speech','narration','addresseeIds'].includes(k))) return undefined
  if (['speech','narration'].some(k => d[k] !== undefined && (typeof d[k] !== 'string' || (d[k] as string).length > 2000))) return undefined
  if (d.addresseeIds !== undefined && (!Array.isArray(d.addresseeIds) || d.addresseeIds.some(v => typeof v !== 'string'))) return undefined
  return d
}
export interface InterventionOptions {
  readonly mode: 'baseline' | 'correct'
  readonly items: readonly AuditItem[]
  readonly classify: (q: ClaimQuestion) => Promise<ClaimAnswer>
  readonly write: (r: InterventionRecord) => void
}
export interface InterventionRecord {
  readonly mode: string
  readonly baseHeadSeq: number
  readonly actorId: string
  readonly original: WorldJsonObject
  readonly final: WorldJsonObject
  readonly checks: readonly { itemId: string; answer: ClaimAnswer; conflicts: readonly string[]; placement: PlacementAudit }[]
  readonly repaired: boolean
  readonly repairAttempted: boolean
  readonly outcome: string
  readonly elapsedMs: number
}
/** Experimental Host adapter only. No writer, commit, scheduler or recursive repair. */
export async function auditBeforePublication(input: {
  request: PrototypeTurnRequest; raw: unknown; history: readonly StoredWorldEvent[];
  options: InterventionOptions; signal: AbortSignal;
  decide: (r: PrototypeTurnRequest) => Promise<unknown>;
}): Promise<unknown> {
  const draft = publish(input.raw)
  if (draft === undefined) return input.raw
  const start = performance.now(), { request, history, options } = input
  const actorId = String(object(request.context.character).characterId)
  const baseHeadSeq = history.at(-1)?.seq ?? 0
  const checks: Array<{ itemId: string; answer: ClaimAnswer; conflicts: string[]; placement: PlacementAudit }> = []
  let final = draft, outcome = 'baseline', repaired = false, repairAttempted = false
  const record = () => options.write({ mode: options.mode, baseHeadSeq, actorId, original: draft, final,
    checks, repaired, repairAttempted, outcome, elapsedMs: Math.round(performance.now()-start) })
  if (options.mode === 'baseline') { record(); return input.raw }
  const people = request.context.scene && object(request.context.scene).people
  const characters = (Array.isArray(people) ? people : []).map(v => {
    const c=object(v); return { characterId: String(c.characterId), name: String(c.name) }
  })
  const current = object(request.context.items).current
  const visible = new Set((Array.isArray(current) ? current : []).map(v => String(object(v).entityId)))
  // Recover only expressions actually observed by this actor. Private cognition/goals never go to Jev.
  const observed = history.filter(e => e.eventType === 'observation.upsert'
    && object(object(e.data).value).observerId === actorId).map(e => ({transactionId:e.transactionId,
      speech:object(object(object(e.data).value).content).speech}))
  const earlierPublications: Publication[] = history.filter(e => e.eventType === 'character.speak'
    && observed.some(o => o.transactionId === e.transactionId && JSON.stringify(o.speech) === JSON.stringify(e.data)))
    .slice(-12).map(e => {
      const d=object(e.data);return {seq:e.seq,actorId:String(d.characterId),speech:String(d.text??''),narration:String(d.narration??'')}
    })
  // seq is a prospective expression position, not an invented or persisted World event.
  const publication = {seq:baseHeadSeq+1,actorId,speech:String(draft.speech??''),narration:String(draft.narration??'')}
  const window: AuditWindow = acquisitionWindow(history,{roundId:null,fromSeq:baseHeadSeq,toSeq:baseHeadSeq,kind:'round'})
  try {
    const answers = await Promise.all(options.items.map(async item => {
      const answer=await options.classify({item,items:options.items,characters,publication,earlierPublications,round:window})
      const conflicts=answer.claims.filter(c => {
        if (!visible.has(item.entityId)) return false // correction must not expose an unseen inventory fact.
        const evidence=holderEvidence(history,window,item.entityId,c.characterId)
        if(c.kind==='OBJECTIVE_NOW')return currentEntityState(history,item.entityId)?.holderId!==c.characterId
        if(c.kind==='OBJECTIVE_NEW')return evidence.enteredSeqs.length===0
        if(c.kind==='OBJECTIVE_DURING')return !evidence.heldAtWindowStart&&evidence.enteredSeqs.length===0
        return false // subjective speech and unresolved historical sources never trigger a repair.
      }).map(c=>c.characterId)
      const placement=reconcilePlacement(history,window,item.entityId,actorId,publication.seq,answer.placement)
      return {itemId:item.entityId,answer,conflicts,placement}
    }))
    checks.push(...answers)
    const conflicts=checks.flatMap(c=>[...c.conflicts.map(characterId=>({entityId:c.itemId,characterId,kind:'person_hold'})),
      ...(visible.has(c.itemId)&&c.placement.status==='CONFLICT'?[{entityId:c.itemId,characterId:actorId,kind:c.placement.kind}]:[])])
    if (conflicts.length===0) {outcome='no_actionable_conflict';record();return draft}
    input.signal.throwIfAborted()
    const revision: PrototypeTurnRequest={...request,canPerform:false,context:{...request.context,
      publicationCorrection:{original:draft,conflicts,
        instruction:'只修正这次尚未发布的表达。上面客观持有或放下描述没有本轮正式结果支持；请依据当前可见 items 和行动结果消除该冲突，保留角色语气及合理内容。可以保留邀请、尝试或主观对白；不能补写新行动或代替他人执行。只能 publish 或 abstain。不要向玩家解释审查过程。'}}}
    repairAttempted=true
    const corrected=await input.decide(revision)
    const d=publish(corrected)
    const abstain=object(corrected).decision==='abstain'&&Object.keys(object(corrected)).length===1
    // Preserve the original audience; a repair is not permission to change communication scope.
    if (d && JSON.stringify(d.addresseeIds??[])===JSON.stringify(draft.addresseeIds??[])) {
      final=d;repaired=true;outcome='repaired_once'
    } else if(abstain) {final={decision:'abstain'};repaired=true;outcome='repair_abstained'}
    else outcome='invalid_repair_original_used'
  } catch { outcome='audit_or_repair_failed_original_used' }
  record()
  return final
}
