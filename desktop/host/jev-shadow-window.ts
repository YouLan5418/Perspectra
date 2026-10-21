import type { StoredWorldEvent, WorldJsonObject } from '@harness-world/contracts'
import type { PlacementClaim } from './jev-shadow-claims-client.ts'
import { currentEntityState, currentLocation } from '@harness-world/kernel'

export interface AuditWindow {
  readonly roundId: string | null
  readonly fromSeq: number
  readonly toSeq: number
  readonly kind: 'round' | 'turn-continuation' | 'nearby-round' | 'player-turn'
}
export interface HolderEvidence {
  readonly heldAtWindowStart: boolean
  readonly enteredSeqs: readonly number[]
  readonly leftSeqs: readonly number[]
}
function bounds(events: readonly StoredWorldEvent[], index: number): [number, number] {
  const tx = events[index]!.transactionId
  let start = index, end = index + 1
  while (start > 0 && events[start-1]!.transactionId === tx) start--
  while (end < events.length && events[end]!.transactionId === tx) end++
  return [start,end]
}
/** Only this atomic round and contiguous preceding commits from the same actor processing turn. Never future rounds. */
export function publicationWindow(events: readonly StoredWorldEvent[], publicationSeq: number): AuditWindow {
  const [begin,end] = bounds(events, publicationSeq-1)
  const round = events.slice(begin,end).find(e => e.eventType === 'world.tick-advanced')?.data as WorldJsonObject | undefined
  const resolution = events.slice(begin,end).find(e => e.eventType === 'action.resolved')?.data as WorldJsonObject | undefined
  let start = begin
  if (resolution?.sourceRole === 'agent' && typeof resolution.participantId === 'string') {
    while (start > 0) {
      const [pStart,pEnd] = bounds(events,start-1)
      const prior = events.slice(pStart,pEnd).find(e => e.eventType === 'action.resolved')?.data as WorldJsonObject | undefined
      if (prior?.sourceRole !== 'agent' || prior.participantId !== resolution.participantId || prior.actorId !== resolution.actorId) break
      start = pStart
    }
  }
  return { roundId: typeof round?.roundId === 'string' ? round.roundId : null,
    fromSeq: start, toSeq: end, kind: start === begin ? 'round' : 'turn-continuation' }
}
export function holderEvidence(events: readonly StoredWorldEvent[], window: AuditWindow, entityId: string, characterId: string): HolderEvidence {
  const heldAtWindowStart = currentEntityState(events.slice(0,window.fromSeq), entityId)?.holderId === characterId
  const enteredSeqs: number[] = [], leftSeqs: number[] = []
  for (const event of events.slice(window.fromSeq,window.toSeq)) {
    const d = event.data as WorldJsonObject
    if (d.entityId !== entityId) continue
    if (event.eventType === 'entity.transferred' || event.eventType === 'entity.taken') {
      if ((Object.hasOwn(d,'toHolderId') ? d.toHolderId : d.characterId) === characterId) enteredSeqs.push(event.seq)
      if (d.fromHolderId === characterId) leftSeqs.push(event.seq)
    }
  }
  return { heldAtWindowStart, enteredSeqs, leftSeqs }
}

/** Nearby receipt/temporary-hold evidence is bounded by the latest submitted player action, ending at this publication commit. */
export function acquisitionWindow(events: readonly StoredWorldEvent[], current: AuditWindow): AuditWindow {
  const playerAction = events.slice(0,current.toSeq).findLast(e => e.eventType === 'action.resolved' && (e.data as WorldJsonObject).sourceRole === 'player')
  if (playerAction !== undefined) {
    const [start] = bounds(events,playerAction.seq-1)
    return { ...current, fromSeq: start, kind: 'player-turn' }
  }
  if (current.fromSeq === 0 || current.kind === 'turn-continuation') return current
  const [,previousEnd] = bounds(events,current.fromSeq-1)
  const previous = publicationWindow(events,previousEnd)
  return { ...current, fromSeq: previous.fromSeq, kind: 'nearby-round' }
}

export interface PlacementAudit extends PlacementClaim {
  readonly status: 'CONFLICT' | 'SUPPORTED' | 'NO_CLAIM' | 'UNCERTAIN' | 'HISTORY_UNRESOLVED'
  readonly window: AuditWindow
  readonly releasedSeqs: readonly number[]
  readonly worldHolder: string | null
  readonly rootPublicationSeq: number | null
}
/** Check a declared release of custody / unassigned availability, never tabletop posture alone. */
export function reconcilePlacement(events:readonly StoredWorldEvent[],window:AuditWindow,entityId:string,actorId:string,publicationSeq:number,claim:PlacementClaim):PlacementAudit {
  const state=currentEntityState(events.slice(0,window.toSeq),entityId)
  const local=acquisitionWindow(events,window)
  const releasedSeqs=events.slice(local.fromSeq,local.toSeq).filter(e=>{
    const d=e.data as WorldJsonObject
    return e.eventType==='entity.transferred'&&d.entityId===entityId&&d.toHolderId===null&&typeof d.fromHolderId==='string'
  }).map(e=>e.seq)
  const location=currentLocation(events.slice(0,window.toSeq),actorId)
  const ground=state?.holderId===null&&state.locationId===location
  const status=claim.kind==='OBJECTIVE_RELEASE'?(ground&&releasedSeqs.length>0?'SUPPORTED':'CONFLICT'):
    claim.kind==='OBJECTIVE_GROUND'?(ground?'SUPPORTED':'CONFLICT'):
    claim.kind==='UNCERTAIN'?'UNCERTAIN':claim.kind==='PAST'?'HISTORY_UNRESOLVED':'NO_CLAIM'
  return {...claim,status,window:claim.kind==='OBJECTIVE_RELEASE'?local:window,releasedSeqs,worldHolder:state?.holderId??null,
    rootPublicationSeq:status==='CONFLICT'?publicationSeq:null}
}
