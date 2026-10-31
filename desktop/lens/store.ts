import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sameFieldValue } from './diff.ts'
import type { LensField, LensItem, LensSource, LensView } from './view.ts'

export interface LensRequest {
  readonly id: string
  readonly itemId: string
  readonly itemTitle: string
  readonly source: LensSource
  /** The author's own words, 1-2000 characters. */
  readonly note: string
  readonly valueAtCreation: readonly LensField[]
  readonly createdAt: string
  readonly closedAt?: string
}
export type LensRequestState = 'open' | 'changed' | 'removed' | 'closed'
export interface LensRequestView extends LensRequest {
  readonly state: LensRequestState
}

const DIRECTORY = '.perspectra-lens'
const MAX_NOTE = 2000
// 1-40 characters, none of them a path separator or reserved on Windows; cannot start with a dot.
const RESERVED = new Set('/:*?"<>|' + String.fromCharCode(92))
const validCheckpointName = (name: string) =>
  name.length >= 1 &&
  name.length <= 40 &&
  !name.startsWith('.') &&
  [...name].every(char => !RESERVED.has(char) && char.charCodeAt(0) >= 32)

const sameFields = (a: readonly LensField[], b: readonly LensField[]) =>
  a.length === b.length &&
  a.every(field => {
    const other = b.find(candidate => candidate.key === field.key)
    return other !== undefined && sameFieldValue(field.value, other.value)
  })

function isView(value: unknown): value is LensView {
  const view = value as LensView | null
  return typeof view === 'object' && view !== null && typeof view.packId === 'string' && Array.isArray(view.items)
}

/** Seen snapshots, named checkpoints and the author's change requests. Everything lives in
 * `<pack>/.perspectra-lens/`; nothing else in the pack is written. */
export class LensStore {
  private readonly root: string

  constructor(packPath: string) {
    this.root = join(packPath, DIRECTORY)
  }

  seen(): LensView | null {
    return this.readView(join(this.root, 'seen.json'), true)
  }

  /** Moves the "what changed since I last looked" baseline. Only the Launcher's "seen" action may call this. */
  markSeen(view: LensView): void {
    this.write(join(this.root, 'seen.json'), view)
  }

  checkpoints(): readonly { name: string; savedAt: string }[] {
    const dir = join(this.root, 'checkpoints')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(file => file.endsWith('.json'))
      .map(file => ({ name: file.slice(0, -5), savedAt: statSync(join(dir, file)).mtime.toISOString() }))
      .sort((a, b) => a.savedAt.localeCompare(b.savedAt) || a.name.localeCompare(b.name))
  }

  saveCheckpoint(name: string, view: LensView): void {
    this.write(this.checkpointPath(name), view)
  }

  checkpoint(name: string): LensView {
    const path = this.checkpointPath(name)
    if (!existsSync(path)) throw new Error(`对比点不存在：${name}`)
    return this.readView(path, false)!
  }

  requests(current: LensView): readonly LensRequestView[] {
    const items = new Map(current.items.map(item => [item.id, item]))
    return this.readRequests().map(request => {
      const now = items.get(request.itemId)
      const state: LensRequestState =
        request.closedAt !== undefined
          ? 'closed'
          : now === undefined
            ? 'removed'
            : sameFields(request.valueAtCreation, now.fields)
              ? 'open'
              : 'changed'
      return { ...request, state }
    })
  }

  addRequest(item: LensItem, note: string): LensRequest {
    if (note.length < 1 || note.length > MAX_NOTE) throw new Error(`待改说明需要 1-${MAX_NOTE} 个字符`)
    const request: LensRequest = {
      id: randomUUID(),
      itemId: item.id,
      itemTitle: item.title,
      source: item.source,
      note,
      valueAtCreation: item.fields,
      createdAt: new Date().toISOString(),
    }
    this.write(this.requestsPath(), [...this.readRequests(), request])
    return request
  }

  closeRequest(id: string): void {
    const requests = this.readRequests()
    if (!requests.some(request => request.id === id)) throw new Error(`待改条目不存在：${id}`)
    this.write(
      this.requestsPath(),
      requests.map(request => (request.id === id ? { ...request, closedAt: new Date().toISOString() } : request)),
    )
  }

  scenarios(): readonly string[] {
    const dir = join(this.root, 'scenarios')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(file => file.endsWith('.json'))
      .sort()
  }

  private requestsPath() {
    return join(this.root, 'requests.json')
  }

  private checkpointPath(name: string) {
    if (!validCheckpointName(name)) throw new Error('对比点名称需要 1-40 个字符，且不能含路径符号')
    return join(this.root, 'checkpoints', `${name}.json`)
  }

  private readJson(path: string): unknown {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`透视文件已损坏，无法读取：${path}（${(error as Error).message}）`)
    }
  }

  private readView(path: string, optional: boolean): LensView | null {
    if (!existsSync(path)) {
      if (optional) return null
      throw new Error(`透视文件不存在：${path}`)
    }
    const value = this.readJson(path)
    if (!isView(value)) throw new Error(`透视文件已损坏，无法读取：${path}（不是有效的透视快照）`)
    return value
  }

  private readRequests(): readonly LensRequest[] {
    const path = this.requestsPath()
    if (!existsSync(path)) return []
    const value = this.readJson(path)
    if (!Array.isArray(value)) throw new Error(`透视文件已损坏，无法读取：${path}（不是待改清单）`)
    return value as LensRequest[]
  }

  /** Writes a temporary file next to the target, then renames it into place. A failure (e.g. a read-only pack)
   * becomes a plain message naming the path; a system error with a `code` would reach the author masked. */
  private write(path: string, value: unknown): void {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(temporary, JSON.stringify(value, null, 2))
      renameSync(temporary, path)
    } catch (error) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // The write error below is what the author needs; a leftover .tmp file is harmless.
      }
      const code = (error as NodeJS.ErrnoException).code
      throw new Error(`无法写入透视文件：${path}（${code ?? (error as Error).message}），请确认包目录可写。`, {
        cause: error,
      })
    }
  }
}
