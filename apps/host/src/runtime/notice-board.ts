import { committedStatusTruth, type WorldRoundSnapshot } from '@perspectra/core'
import { currentSceneDecisionStates, sceneObserverIds } from '@perspectra/core/kernel'
import type { NoticeReceipt, WorldStore } from '@perspectra/core/store'
import type { EventBook } from '@perspectra/sdk'
import {
  hashWorldJson,
  type StoredWorldEvent,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonObject,
} from '@perspectra/sdk/contracts'
import { firstPackTimeCrossing } from './pack-time.ts'

/** A place shared by several active scenes does not identify one authorized audience. */
export function localWitnesses(events: WorldRoundSnapshot['events'], location: string) {
  const scenes = currentSceneDecisionStates(events).filter(
    scene => scene.lifecycle === 'active' && scene.locationId === location,
  )
  return new Set<string>(scenes.length === 1 ? sceneObserverIds(events, scenes[0]!) : [])
}

interface Posting extends WorldJsonObject {
  registrationId: string
  occurrenceId: string
  clockTransaction: string
  location: string
  text: string
}
function occurrenceIdentity(registrationId: string, clockTransaction: string) {
  return hashWorldJson('notice-posting', [registrationId, clockTransaction])
}
interface Posted {
  fact: Posting
  signup: boolean
  witnesses: Map<string, number>
  postedAt: number
  readers: Map<string, { seq: number; committedAt: number }>
}
type Evidence = 'witness' | 'read'
function observation(post: Posting, observerId: string, origin: Evidence): WorldEventDraft {
  const lead = origin === 'witness' ? '你看到告示张贴出来：' : '你在告示栏上读到：'
  return {
    eventType: 'observation.upsert',
    eventVersion: 1,
    data: {
      id: post.occurrenceId + ':' + origin + ':' + observerId,
      sceneReaction: false,
      value: {
        observerId,
        noticeOccurrenceId: post.occurrenceId,
        noticeSource: origin,
        content: { eventNotice: lead + post.text },
      },
    },
  }
}
function evidence(rows: readonly StoredWorldEvent[], post: Posting, origin: Evidence) {
  const result = new Map<string, number>()
  for (const row of rows) {
    const data = row.data as WorldJsonObject,
      value = data.value as WorldJsonObject
    if (value.noticeOccurrenceId !== post.occurrenceId || value.noticeSource !== origin) continue
    if (
      typeof value.observerId !== 'string' ||
      data.id !== post.occurrenceId + ':' + origin + ':' + value.observerId ||
      result.has(value.observerId)
    )
      throw new Error('告示观察身份不一致。')
    result.set(value.observerId, row.seq)
  }
  return result
}

function savedClock(receipt: NoticeReceipt, book: EventBook, snapshot: WorldRoundSnapshot) {
  const { calendar, baseline, proposal, afterWorldSeq } = receipt
  const rule = book.rules.find(row => row.id === proposal?.calendarRule),
    clock = rule?.crossesPackTime
  if (
    !clock ||
    rule?.location !== receipt.location ||
    calendar?.dayKey !== clock.dayKey ||
    calendar.slotKey !== clock.slotKey ||
    !Array.isArray(calendar.slots) ||
    calendar.slots.length !== clock.slots.length ||
    !clock.slots.every((slot, i) => slot === calendar.slots[i]) ||
    !Number.isSafeInteger(proposal.day) ||
    !clock.slots.includes(proposal.slot) ||
    typeof proposal.text !== 'string' ||
    !proposal.text.trim() ||
    proposal.text.length > 2000 ||
    !Number.isSafeInteger(baseline?.day) ||
    baseline.day < 0 ||
    !clock.slots.includes(baseline.slot) ||
    proposal.day < baseline.day ||
    (proposal.day === baseline.day && clock.slots.indexOf(proposal.slot) <= clock.slots.indexOf(baseline.slot))
  )
    throw new Error('告示登记与游戏包日历不一致。')
  const truth = committedStatusTruth(snapshot.events.slice(0, afterWorldSeq)).public
  if (truth[clock.dayKey] !== baseline.day || truth[clock.slotKey] !== baseline.slot)
    throw new Error('告示登记时的日历与世界前缀不一致。')
  return { ...clock, at: { day: proposal.day, slot: proposal.slot } }
}

/** A derived index for one effective branch. Posting belongs to settlement; reading is actor-scoped. */
export class NoticeBoard {
  private readonly posts = new Map<string, Posted>()
  private readonly postedRegistrations = new Set<string>()

  index(
    authority: WorldJsonObject,
    observations: readonly StoredWorldEvent[],
    committedAt: number,
    registrations?: readonly NoticeReceipt[],
  ) {
    for (const fact of (authority.noticePostings ?? []) as Posting[]) {
      const receipt = registrations?.find(r => r.registrationId === fact.registrationId)
      if (
        !receipt ||
        receipt.afterWorldSeq >= committedAt ||
        receipt.location !== fact.location ||
        receipt.proposal.text !== fact.text ||
        fact.occurrenceId !== occurrenceIdentity(fact.registrationId, fact.clockTransaction)
      )
        throw new Error('告示张贴与有效分支的登记不一致。')
      if (this.postedRegistrations.has(fact.registrationId) || this.posts.has(fact.occurrenceId))
        throw new Error('告示重复张贴。')
      this.postedRegistrations.add(fact.registrationId)
      this.posts.set(fact.occurrenceId, {
        fact,
        signup: receipt.proposal.commission === 'signup',
        postedAt: committedAt,
        witnesses: evidence(observations, fact, 'witness'),
        readers: new Map(),
      })
    }
    const read = authority.noticeRead as { actorId: string; occurrenceId: string } | undefined
    if (!read) return
    const post = this.posts.get(read.occurrenceId)
    if (!post || post.readers.has(read.actorId)) throw new Error('告示阅读与分支历史不一致。')
    const records = evidence(observations, post.fact, 'read')
    const seen = records.get(read.actorId)
    if (authority.actorId !== read.actorId || records.size !== 1 || seen === undefined)
      throw new Error('告示阅读缺少角色观察。')
    post.readers.set(read.actorId, { seq: seen, committedAt })
  }

  settle(
    store: WorldStore,
    address: WorldAddress,
    book: EventBook,
    snapshot: WorldRoundSnapshot,
    windowStart?: number,
  ) {
    const postings: Posting[] = [],
      events: WorldEventDraft[] = []
    for (const receipt of store.pendingNoticeDefinitions(address)) {
      if (receipt.afterWorldSeq > snapshot.head.headSeq || this.postedRegistrations.has(receipt.registrationId))
        continue
      const clock = savedClock(receipt, book, snapshot)
      const crossing = firstPackTimeCrossing(snapshot.events, clock, () => {}, {
        afterWorldSeq: receipt.afterWorldSeq,
        ...receipt.baseline,
        complete(first, last) {
          return (
            first.eventOrdinal === 0 && store.committedRound(first.address, first.transactionId)?.headSeq === last.seq
          )
        },
      })
      if (!crossing || (windowStart !== undefined && crossing.at(-1)!.seq <= windowStart)) continue
      const clockTransaction = crossing[0]!.transactionId
      const fact: Posting = {
        registrationId: receipt.registrationId,
        occurrenceId: occurrenceIdentity(receipt.registrationId, clockTransaction),
        clockTransaction,
        location: receipt.location,
        text: receipt.proposal.text,
      }
      postings.push(fact)
      for (const actor of localWitnesses(snapshot.events, fact.location))
        events.push(observation(fact, actor, 'witness'))
    }
    return { postings, events }
  }

  /** Only index a commission against a prior personal observation of that exact posting. */
  signupEvidence(actor: string, occurrenceId: string, through: number): number | undefined {
    const post = this.posts.get(occurrenceId)
    if (!post?.signup || post.postedAt > through) return
    const witness = post.witnesses.get(actor)
    if (witness !== undefined) return witness
    const read = post.readers.get(actor)
    return read && read.committedAt <= through ? read.seq : undefined
  }
  localNotices(actor: string, events: WorldRoundSnapshot['events'], through: number) {
    const access = new Map<string, boolean>()
    return [...this.posts.values()]
      .filter(({ postedAt, fact }) => {
        if (postedAt > through) return false
        if (!access.has(fact.location)) access.set(fact.location, localWitnesses(events, fact.location).has(actor))
        return access.get(fact.location)
      })
      .map(({ fact, witnesses, readers }) => ({
        occurrenceId: fact.occurrenceId,
        text: fact.text,
        known: witnesses.has(actor) || (readers.get(actor)?.committedAt ?? Infinity) <= through,
      }))
  }
  available(actor: string, events: WorldRoundSnapshot['events']) {
    return this.localNotices(actor, events, events.at(-1)?.seq ?? 0).map(post => post.occurrenceId)
  }
  known(actor: string, through: number) {
    return [...this.posts.values()].flatMap(({ fact, postedAt, witnesses, readers }) => {
      if (postedAt > through) return []
      const witness = witnesses.get(actor),
        read = readers.get(actor)
      const witnessedAt = witness !== undefined && witness <= through ? witness : null
      const readAt = read !== undefined && read.committedAt <= through ? read.seq : null
      return witnessedAt === null && readAt === null
        ? []
        : [{ occurrenceId: fact.occurrenceId, text: fact.text, witnessedAt, readAt }]
    })
  }
  read(actor: string, occurrenceId: string, snapshot: WorldRoundSnapshot) {
    const post = this.posts.get(occurrenceId)
    if (!post || !localWitnesses(snapshot.events, post.fact.location).has(actor))
      throw new TypeError('当前无法查看这张告示。')
    if (post.readers.has(actor)) return undefined
    return observation(post.fact, actor, 'read')
  }
}
