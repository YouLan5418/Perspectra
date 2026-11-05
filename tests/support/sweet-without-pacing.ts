import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll } from 'vitest'

/** A copy of the sweet days pack without its pacing, for cases that pin one event's own conditions:
 * a lens simulation draws real random numbers, so pacing would make them come and go. */
export function sweetWithoutPacing(): string {
  const root = mkdtempSync(join(tmpdir(), 'sweet-without-pacing-'))
  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const pack = join(root, 'model-girls-sweet-days')
  cpSync(resolve('examples/world-packs/model-girls-sweet-days'), pack, { recursive: true })
  const file = join(pack, 'worldpack.source.json')
  const source = JSON.parse(readFileSync(file, 'utf8'))
  source.assetFiles = source.assetFiles.filter((asset: string) => asset !== 'scripts/pacing.js')
  writeFileSync(file, JSON.stringify(source, null, 2))
  return pack
}
