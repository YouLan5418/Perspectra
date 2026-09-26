import { setImmediate as nextTurn } from 'node:timers/promises'
import type { StoredWorldEvent, WorldAddress, WorldJsonObject } from '@harness-world/contracts'
import { currentEntityState } from '@harness-world/kernel'

export interface AuditItem { readonly entityId: string; readonly name: string; readonly aliases?: readonly string[] }
export interface AuditCharacter { readonly characterId: string; readonly name: string }
export interface Publication {
  readonly seq: number
  readonly actorId: string
  readonly speech: string
  readonly narration: string
}
/** Metadata and published expression only. No authoritative holder or private agent context. */
export interface HolderQuestion {
  readonly item: AuditItem
  readonly items: readonly AuditItem[]
  readonly characters: readonly AuditCharacter[]
  readonly publication: Publication
}
export interface HolderAnswer {
  readonly choice: string
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence: number | null
  readonly model: string
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly costUsd: number | null
}
export type AuditStatus = 'SUPPORTED' | 'CONFLICT' | 'NO_CLAIM' | 'UNCERTAIN'
  | 'CALL_FAILED' | 'AUDIT_FAILED' | 'QUEUE_SKIPPED'
export interface ShadowRecord {
  readonly address: WorldAddress
  readonly preHeadSeq: number
  readonly postHeadSeq: number
  readonly transactionId: string | null
  readonly publication: Publication | null
  readonly item: AuditItem | null
  readonly status: AuditStatus
  readonly beforeHolder: string | null
  readonly worldHolder: string | null
  readonly claimedHolder: string | null
  readonly holderEventSeq: number | null
  readonly answer: HolderAnswer | null
  readonly latencyMs: number
  readonly reason: string | null
}
export interface ShadowOptions {
  readonly items: readonly AuditItem[]
  readonly classify: (question: HolderQuestion) => Promise<HolderAnswer>
  readonly write: (record: ShadowRecord) => Promise<void>
  readonly onError?: (message: string) => void
}

export const holderChoice = (id: string): string => `holder:${id}`
export function holderCriteria(characters: readonly AuditCharacter[]): Record<string, string> {
  return Object.fromEntries([
    ...characters.map(character => [holderChoice(character.characterId),
      `客观叙述明确确认目标物品在这段表达结束时由${character.name}（${character.characterId}）持有或保管。`]),
    ['GROUND', '客观叙述明确确认目标物品已放下或无人持有。'],
    ['NO_CLAIM', '没有对目标物品的当前持有者作出客观断言；包括未提及、意图、未完成尝试、否定、假设和回忆。'],
    ['SPEECH_ONLY', '持有或转交仅存在于对白、传闻、猜测或思想中，客观叙述未确认。'],
    ['UNCERTAIN', '无法确定指的是哪件物品、最终由谁持有，或出现无法归入一个终态的矛盾。'],
  ])
}

export function parseAuditItems(input: unknown): readonly AuditItem[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8) throw new TypeError('shadow items must contain 1..8 entries')
  const ids = new Set<string>()
  return input.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') throw new TypeError('invalid shadow item')
    const item = entry as Record<string, unknown>
    if (Object.keys(item).some(key => !['entityId', 'name', 'aliases'].includes(key))
      || typeof item.entityId !== 'string' || !item.entityId.trim()
      || typeof item.name !== 'string' || !item.name.trim() || ids.has(item.entityId)) throw new TypeError('invalid or duplicate shadow item')
    if (item.aliases !== undefined && (!Array.isArray(item.aliases)
      || item.aliases.some(alias => typeof alias !== 'string' || !alias.trim()))) throw new TypeError('invalid shadow aliases')
    ids.add(item.entityId)
    return { entityId: item.entityId, name: item.name,
      ...(item.aliases === undefined ? {} : { aliases: item.aliases as string[] }) }
  })
}

/** One queue in the experimental host. It has no world writer, agent, or scheduler reference. */
export class JevShadow {
  #cursor: number
  #queue: Array<{ from: number; to: number }> = []
  #dropped: { from: number; to: number } | undefined
  #running: Promise<void> | undefined
  #closed = false
  #records = 0
  #errors = 0
  #skipped = 0

  constructor(private readonly options: ShadowOptions & {
    readonly address: WorldAddress
    readonly characters: readonly AuditCharacter[]
    readonly initialSeq: number
    readonly readEvents: (asOfSeq: number) => readonly StoredWorldEvent[]
  }) { this.#cursor = options.initialSeq }

  stats(): { records: number; errors: number; skippedWindows: number; pendingWindows: number } {
    return { records: this.#records, errors: this.#errors, skippedWindows: this.#skipped, pendingWindows: this.#queue.length }
  }

  /** Called after the host refreshes its published transcript. Enqueue only; no read or API call. */
  observe(headSeq: number): void {
    if (this.#closed || headSeq <= this.#cursor) return
    const window = { from: this.#cursor, to: headSeq }
    this.#cursor = headSeq
    if (this.#dropped !== undefined || this.#queue.length >= 32) {
      this.#skipped += 1
      if (this.#dropped === undefined) this.#dropped = window
      else this.#dropped.to = headSeq
    } else this.#queue.push(window)
    if (this.#running === undefined) this.#running = this.#drain().finally(() => { this.#running = undefined })
  }

  async #drain(): Promise<void> {
    await nextTurn() // No synchronous prefix replay in observe().
    while (this.#queue.length > 0 || this.#dropped !== undefined) {
      const window = this.#queue.shift()
      if (window === undefined) {
        const dropped = this.#dropped!
        this.#dropped = undefined
        await this.#write(this.#record(dropped.from, dropped.to, { status: 'QUEUE_SKIPPED', reason: 'queue capacity exceeded' }))
        continue
      }
      try { await this.#audit(window.from, window.to) }
      catch {
        this.#errors += 1
        await this.#write(this.#record(window.from, window.to, { status: 'AUDIT_FAILED', reason: 'event prefix read or reconciliation failed' }))
      }
      await nextTurn()
    }
  }

  async #audit(from: number, to: number): Promise<void> {
    const events = this.options.readEvents(to)
    if (events.length !== to || events.some((event, index) => event.seq !== index + 1
      || event.address.tenantId !== this.options.address.tenantId
      || event.address.worldId !== this.options.address.worldId
      || event.address.branchId !== this.options.address.branchId)
      || (from > 0 && events[from - 1]?.transactionId === events[from]?.transactionId)) throw new Error('invalid event prefix')
    let start = from
    while (start < to) {
      const transactionId = events[start]!.transactionId
      let end = start + 1
      while (end < to && events[end]!.transactionId === transactionId) end += 1
      const pre = events.slice(0, start), post = events.slice(0, end)
      for (const event of events.slice(start, end)) {
        if (event.eventType !== 'character.speak') continue
        const data = event.data as WorldJsonObject
        const publication: Publication = { seq: event.seq, actorId: String(data.characterId),
          speech: typeof data.text === 'string' ? data.text : '',
          narration: typeof data.narration === 'string' ? data.narration : '' }
        if (!publication.speech.trim() && !publication.narration.trim()) continue
        for (const item of this.options.items) {
          const before = currentEntityState(pre, item.entityId), world = currentEntityState(post, item.entityId)
          const holderEventSeq = post.findLast(entry => ['entity.upsert', 'entity.transferred', 'entity.taken'].includes(entry.eventType)
            && (entry.data as WorldJsonObject).entityId === item.entityId)?.seq ?? null
          const base = { transactionId, publication, item, beforeHolder: before?.holderId ?? null,
            worldHolder: world?.holderId ?? null, holderEventSeq }
          if (world === undefined) {
            await this.#write(this.#record(start, end, { ...base, status: 'UNCERTAIN', reason: 'configured item is absent from event prefix' }))
            continue
          }
          if (this.options.items.some(other => other.entityId !== item.entityId && other.name === item.name)) {
            await this.#write(this.#record(start, end, { ...base, status: 'UNCERTAIN', reason: 'configured items share the same display name' }))
            continue
          }
          const began = performance.now()
          let answer: HolderAnswer
          try {
            answer = await this.options.classify({ item, items: this.options.items, characters: this.options.characters, publication })
            if (!Object.hasOwn(holderCriteria(this.options.characters), answer.choice)) throw new Error('invalid choice')
          } catch {
            this.#errors += 1
            await this.#write(this.#record(start, end, { ...base, status: 'CALL_FAILED',
              latencyMs: performance.now() - began, reason: 'Jev request failed or response was invalid' }))
            continue
          }
          const choice = answer.choice
          const claimedHolder = choice.startsWith('holder:') ? choice.slice('holder:'.length) : null
          const status: AuditStatus = choice === 'UNCERTAIN' ? 'UNCERTAIN'
            : choice === 'NO_CLAIM' || choice === 'SPEECH_ONLY' ? 'NO_CLAIM'
              : claimedHolder === world.holderId ? 'SUPPORTED' : 'CONFLICT'
          await this.#write(this.#record(start, end, { ...base, answer, claimedHolder, status, latencyMs: performance.now() - began }))
        }
      }
      start = end
      await nextTurn()
    }
  }
  #record(from: number, to: number, fields: Partial<ShadowRecord>): ShadowRecord {
    return { address: this.options.address, preHeadSeq: from, postHeadSeq: to, transactionId: null,
      publication: null, item: null, status: 'AUDIT_FAILED', beforeHolder: null, worldHolder: null,
      claimedHolder: null, holderEventSeq: null, answer: null, latencyMs: 0, reason: null, ...fields }
  }
  async #write(record: ShadowRecord): Promise<void> {
    try { await this.options.write(record); this.#records += 1 }
    catch { this.#errors += 1; this.#report('shadow log write failed') }
  }
  #report(message: string): void { try { this.options.onError?.(message) } catch { /* Observation never affects play. */ } }
  async close(): Promise<void> {
    this.#closed = true
    while (this.#running !== undefined) await this.#running
  }
}
