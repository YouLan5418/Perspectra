import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertNoticeCursor, noticeCursorAt, noticeStorageEnabled, type NoticeCursor } from '@perspectra/core/store'

interface StoryPosition {
  headSeq: number
  tick: number
  noticeCursor?: NoticeCursor
}

/** Read the immutable backup, never a live head sampled before the SQLite backup finished. */
export function readStoryPosition(
  directory: string,
  expectedKey?: string,
  parent?: StoryPosition,
  parentDirectory?: string,
): StoryPosition {
  const db = new DatabaseSync(join(directory, 'world.sqlite'), { readOnly: true })
  try {
    const heads = db.prepare('SELECT address_key, head_seq, tick FROM heads').all()
    if (heads.length !== 1) throw new Error('故事节点需要唯一世界分支。')
    const key = String(heads[0]!.address_key),
      headSeq = Number(heads[0]!.head_seq),
      tick = Number(heads[0]!.tick)
    if (expectedKey !== undefined && expectedKey !== key) throw new Error('故事节点的世界分支不一致。')
    if (!noticeStorageEnabled(db)) {
      if (parent?.noticeCursor) throw new Error('子节点缺少父节点的告示存档格式。')
      return { headSeq, tick }
    }
    if (parent) {
      const cut = noticeCursorAt(db, key, parent.headSeq, parent.noticeCursor?.metadataSeq ?? 0)
      if (parent.noticeCursor !== undefined) assertNoticeCursor(parent.noticeCursor, cut)
      else if (parentDirectory) {
        // A schema-21 parent has no portable cursor; its immutable SQLite head still identifies its game prefix.
        const old = new DatabaseSync(join(parentDirectory, 'world.sqlite'), { readOnly: true })
        try {
          const head = old.prepare('SELECT head_seq,tick,event_hash FROM heads WHERE address_key=?').get(key)
          if (
            noticeStorageEnabled(old) ||
            head?.head_seq !== parent.headSeq ||
            head.tick !== parent.tick ||
            head.event_hash !== cut.eventHash
          )
            throw new Error('旧节点与当前世界前缀不一致。')
        } finally {
          old.close()
        }
      }
    }
    return { headSeq, tick, noticeCursor: noticeCursorAt(db, key, headSeq) }
  } finally {
    db.close()
  }
}

export function assertStoryPosition(node: StoryPosition, actual: StoryPosition) {
  if (node.headSeq !== actual.headSeq || node.tick !== actual.tick) throw new Error('故事节点时刻与数据库不一致。')
  if (node.noticeCursor !== undefined || actual.noticeCursor !== undefined) {
    if (!node.noticeCursor || !actual.noticeCursor) throw new Error('故事节点缺少配对的告示游标或登记库。')
    assertNoticeCursor(node.noticeCursor, actual.noticeCursor)
  }
}
