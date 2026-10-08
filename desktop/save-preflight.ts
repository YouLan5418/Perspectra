import { currentWorldDirectory } from './tail-storage.ts'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { interactionPackageDescription } from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'

export interface SavePreflightResult {
  readonly title: string
  readonly packHash: string
  readonly kind: 'new' | 'resume'
}

/** Read the saved Manifest without opening a writable WorldStore or migrating old data. */
export async function preflightSave(packPath: string, dataDirectory: string): Promise<SavePreflightResult> {
  const pack = await compileWorldPackSource(resolve(packPath), [
    interactionPackageDescription(createBasicInteractionPackage()),
  ]) as CompiledWorldPackV5
  const databasePath = resolve(currentWorldDirectory(dataDirectory), 'world.sqlite')
  if (!existsSync(databasePath)) {
    if (existsSync(dataDirectory) && readdirSync(dataDirectory).length > 0) {
      throw new Error('所选存档目录已有数据，但没有 world.sqlite；请选择空目录或有效存档。')
    }
    return { title: pack.content.world.title, packHash: pack.packHash, kind: 'new' }
  }
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const branches = database.prepare('SELECT COUNT(*) AS count FROM branches').get() as { count: number }
    if (branches.count !== 1) throw new Error('当前桌面版只支持单分支存档。')
    const rows = database.prepare(`
      SELECT m.manifest_json FROM branch_activations a
      JOIN world_manifests m ON m.manifest_hash = a.manifest_hash
    `).all() as Array<{ manifest_json: string }>
    if (rows.length !== 1) throw new Error('存档中缺少唯一的已激活世界。')
    const manifest = JSON.parse(rows[0]!.manifest_json) as { contentPack?: { packHash?: string } }
    if (manifest.contentPack?.packHash !== pack.packHash) {
      throw new Error('所选世界包与存档中的世界不一致；请选回原世界包或创建新存档。')
    }
    return { title: pack.content.world.title, packHash: pack.packHash, kind: 'resume' }
  } finally {
    database.close()
  }
}
