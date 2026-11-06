import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The player's in-game choice to let story pacing bring events. A play preference, not a world fact: it is kept
 * beside the storyline, not in the event log, and a restored node starts with pacing on. */
const FILE = 'play-preferences.json'

export function readPacingPreference(root: string): boolean {
  const path = join(root, FILE)
  if (!existsSync(path)) return true
  const value = JSON.parse(readFileSync(path, 'utf8')) as { pacing?: unknown }
  if (!value || typeof value !== 'object' || (value.pacing !== undefined && typeof value.pacing !== 'boolean'))
    throw new Error('玩家偏好记录损坏：' + path)
  return value.pacing !== false
}

export function writePacingPreference(root: string, enabled: boolean): void {
  const path = join(root, FILE)
  writeFileSync(path + '.tmp', JSON.stringify({ pacing: enabled }) + '\n')
  renameSync(path + '.tmp', path)
}
