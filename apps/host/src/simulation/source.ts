import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function simulationSource(pack: string) {
  const drafts = ['creator-activities', 'creator-rules.json', 'creator-knowledge.json', 'creator-presets.json']
  if (!drafts.some(name => existsSync(join(pack, name)))) return { path: pack, close() {} }
  const { buildSource } = await import('../editor/export.ts')
  const path = mkdtempSync(join(tmpdir(), 'perspectra-simulation-source-'))
  const close = () => rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  try {
    await buildSource(pack, path)
    return { path, close }
  } catch (error) {
    close()
    throw error
  }
}
