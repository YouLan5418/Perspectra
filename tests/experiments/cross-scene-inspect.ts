import { DatabaseSync } from 'node:sqlite'
import { resolve, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { currentLocation } from '@harness-world/kernel'
import type { WorldJsonObject } from '@harness-world/contracts'

if (!process.argv[2]) throw new TypeError('请指定短信实验数据目录')
const directory = resolve(process.argv[2]), db = new DatabaseSync(join(directory, 'world.sqlite'), { readOnly: true })
try {
  const events = db.prepare('SELECT seq,event_type,data_json FROM events ORDER BY seq').all().map(row => ({ seq: Number(row.seq), eventType: String(row.event_type), data: JSON.parse(String(row.data_json)) as WorldJsonObject }))
  const observations = (id: string) => events.filter(e => e.eventType === 'observation.upsert' && (e.data.value as WorldJsonObject)?.observerId === id)
  const speech = events.filter(e => e.eventType === 'character.speak')
  const evidence = { positions: Object.fromEntries(['character:player', 'character:companion', 'character:friend'].map(id => [id, currentLocation(events, id)])),
    remoteMessages: speech.filter(e => e.data.medium === '短信').map(e => ({ seq: e.seq, from: e.data.characterId, to: e.data.addresseeIds, text: e.data.text })),
    localPublications: speech.filter(e => e.data.medium === undefined).map(e => ({ seq: e.seq, actor: e.data.characterId, segments: e.data.segments })),
    secretLeakedToFriend: JSON.stringify(observations('character:friend')).includes('蓝色纸鹤'),
    playerReceivedBackRoomDialogue: observations('character:player').some(e => { const content = ((e.data.value as WorldJsonObject).content as WorldJsonObject), s = content?.speech as WorldJsonObject | undefined
      return s !== undefined && s.characterId !== 'character:player' && s.medium === undefined }),
  }
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally { db.close() }
