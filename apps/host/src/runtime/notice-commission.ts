import { activityProgress, type WorldRoundSnapshot } from '@perspectra/core'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import type { NoticeBoard } from './notice-board.ts'
import type { HostAction, PlayerLine } from './http-server.ts'

export const commissionSource = 'host.notice-commission/v1'
export type BoardOperation = 'read' | 'enroll' | 'withdraw'
export interface BoardChoice {
  occurrenceId: string
  operation: BoardOperation
  label: string
}
const unavailable = () => new TypeError('当前无法办理这项告示操作。')

export function boardCommand(
  action: HostAction,
  line?: PlayerLine,
): Pick<BoardChoice, 'occurrenceId' | 'operation'> | undefined {
  const { definitionRef, occurrenceId, operation } = action.parameters
  if (action.actionType !== 'interact' || (definitionRef as WorldJsonObject | undefined)?.id !== 'host:notice-board')
    return
  if (line) throw new TypeError('告示操作不能附带发言')
  if (
    typeof occurrenceId !== 'string' ||
    (operation !== 'read' && operation !== 'enroll' && operation !== 'withdraw') ||
    (definitionRef as WorldJsonObject).version !== 1 ||
    Object.keys(definitionRef as WorldJsonObject).length !== 2 ||
    Object.keys(action.parameters).length !== 3
  )
    throw unavailable()
  return { occurrenceId, operation }
}

interface Enrollment {
  enrolledAt: number
  withdrawnAt?: number
}

/** One fixed signup sheet per actual posting. No scripts, roles, payout or NPC actions. */
export class NoticeCommissions {
  private readonly entries = new Map<string, Map<string, Enrollment>>()
  constructor(private readonly board: NoticeBoard) {}

  choices(actor: string, events: WorldRoundSnapshot['events'], through: number): BoardChoice[] {
    const local = this.board.localNotices(actor, events, through)
    if (!local.length || [...activityProgress(events).values()].some(activity => activity.game.active)) return []
    const choices: BoardChoice[] = []
    for (const [index, { occurrenceId, text, known }] of local.entries()) {
      if (!known) {
        choices.push({
          occurrenceId,
          operation: 'read',
          label: local.length === 1 ? '查看告示栏上的告示' : '查看告示栏上的第' + (index + 1) + '张告示',
        })
        continue
      }
      if (this.board.signupEvidence(actor, occurrenceId, through) === undefined) continue
      const entry = this.entries.get(occurrenceId)?.get(actor)
      if (!entry || entry.enrolledAt > through)
        choices.push({ occurrenceId, operation: 'enroll', label: '报名：' + text })
      else if ((entry.withdrawnAt ?? Infinity) > through)
        choices.push({ occurrenceId, operation: 'withdraw', label: '已报名，放弃：' + text })
    }
    return choices
  }

  adjudicate(actorId: string, occurrenceId: string, operation: 'enroll' | 'withdraw', snapshot: WorldRoundSnapshot) {
    const { events, head } = snapshot
    const evidenceSeq = this.board.signupEvidence(actorId, occurrenceId, head.headSeq)
    if (
      evidenceSeq === undefined ||
      !this.board.localNotices(actorId, events, head.headSeq).some(post => post.occurrenceId === occurrenceId) ||
      [...activityProgress(events).values()].some(activity => activity.game.active)
    )
      throw unavailable()
    const entry = this.entries.get(occurrenceId)?.get(actorId)
    if (operation === 'enroll') {
      if (entry?.withdrawnAt !== undefined) throw unavailable()
      if (entry) return
    } else {
      if (!entry) throw unavailable()
      if (entry.withdrawnAt !== undefined) return
    }
    return { actorId, occurrenceId, operation, evidenceSeq }
  }

  index(row: WorldJsonObject, seq: number) {
    const { actorId, occurrenceId, operation, evidenceSeq } = row
    if (
      typeof actorId !== 'string' ||
      typeof occurrenceId !== 'string' ||
      typeof evidenceSeq !== 'number' ||
      this.board.signupEvidence(actorId, occurrenceId, seq - 1) !== evidenceSeq
    )
      throw new Error('告示委托缺少本分支中在先的个人观察。')
    const sheet = this.entries.get(occurrenceId) ?? new Map<string, Enrollment>()
    const entry = sheet.get(actorId)
    if (operation === 'enroll' && !entry) {
      sheet.set(actorId, { enrolledAt: seq })
      this.entries.set(occurrenceId, sheet)
    } else if (operation === 'withdraw' && entry && entry.withdrawnAt === undefined) {
      entry.withdrawnAt = seq
    } else throw new Error('告示委托的报名历史不一致。')
  }
}
