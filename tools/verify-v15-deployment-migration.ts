import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openContextDatabase } from '@harness-world/agents'
import { canonicalizeWorldJson, hashWorldJson, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { reactionPolicyFromManifest, type CompiledWorldManifest } from '@harness-world/kernel'
import { DeploymentBackupService } from '@harness-world/operations'
import {
  ProjectionRebuilder,
  readPragmaInteger,
  WORLD_SCHEMA_VERSION,
  WorldLogicalTransferService,
  WorldStore,
} from '@harness-world/store-sqlite'

const [sourceArgument, exerciseArgument] = process.argv.slice(2)
if (sourceArgument === undefined || exerciseArgument === undefined) {
  throw new TypeError('usage: verify-v15-deployment-migration <v15-source-directory> <new-exercise-directory>')
}
const source = resolve(sourceArgument)
const exercise = resolve(exerciseArgument)
if (existsSync(exercise)) throw new Error(`exercise target already exists: ${exercise}`)

const fileNames = [
  'world.sqlite', 'world.sqlite.audit.sqlite', 'session.sqlite', 'memory.sqlite', 'context.sqlite',
] as const
const migrated = join(exercise, 'migrated')
mkdirSync(migrated, { recursive: true })
for (const name of fileNames) copyFileSync(join(source, name), join(migrated, name), constants.COPYFILE_EXCL)

function sha256(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

function historicalSnapshot(path: string): { readonly schemaVersion: number; readonly hash: string } {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = (db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'world_reaction_%'
      ORDER BY name
    `).all() as Array<{ name: string }>).map(row => row.name)
    const contents: Record<string, WorldJsonValue> = {}
    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM "${table}"`).all() as WorldJsonObject[]
      contents[table] = rows.map(row => row as WorldJsonValue)
        .sort((left, right) => Buffer.from(canonicalizeWorldJson(left)).compare(Buffer.from(canonicalizeWorldJson(right))))
    }
    return {
      schemaVersion: readPragmaInteger(db, 'user_version'),
      hash: hashWorldJson('v15-history-snapshot/v1', contents),
    }
  } finally {
    db.close()
  }
}

const worldPath = join(migrated, 'world.sqlite')
const contextPath = join(migrated, 'context.sqlite')
const before = historicalSnapshot(worldPath)
if (before.schemaVersion !== 15) throw new Error(`source World must be schema v15, got v${before.schemaVersion}`)
const contextBefore = historicalSnapshot(contextPath)
const sourceFiles = fileNames.map(name => ({ name, byteLength: statSync(join(source, name)).size, sha256: sha256(join(source, name)) }))

const world = new WorldStore(worldPath)
const branches = world.listBranches().map((address) => {
  const integrity = world.verifyBranchIntegrity(address)
  const head = world.head(address)
  const projection = new ProjectionRebuilder(world).rebuildAt(address, integrity.headSeq)
  const storedManifest = world.readManifest(address)
  if (storedManifest === undefined) throw new Error(`branch has no Manifest: ${address.branchId}`)
  const reaction = reactionPolicyFromManifest(storedManifest.manifest as CompiledWorldManifest)
  if (reaction.mode !== 'disabled') throw new Error(`legacy branch unexpectedly enabled reactions: ${address.branchId}`)
  if (world.listReactionCycles(address).length !== 0) throw new Error(`legacy branch acquired Reaction rows: ${address.branchId}`)
  return {
    address, headSeq: integrity.headSeq, tick: integrity.tick, eventHash: head.eventHash,
    projectionHash: projection.bundleHash, reactionMode: reaction.mode,
  }
})
world.close()
openContextDatabase(contextPath).close()

const after = historicalSnapshot(worldPath)
const contextAfter = historicalSnapshot(contextPath)
if (after.schemaVersion !== WORLD_SCHEMA_VERSION || after.hash !== before.hash) {
  throw new Error(`v15 migration rewrote history or failed: before=${before.hash}, after=${after.hash}, schema=${after.schemaVersion}`)
}
if (contextAfter.hash !== contextBefore.hash) throw new Error('Context migration rewrote existing rows')

const authorityPath = join(exercise, 'authority-v6.json')
const importedPath = join(exercise, 'logical-import', 'world.sqlite')
mkdirSync(join(exercise, 'logical-import'), { recursive: true })
const transfer = new WorldLogicalTransferService(worldPath)
const authorityHash = transfer.exportAuthority(authorityPath, 'migration:authority:export')
if (transfer.importAuthority(authorityPath, importedPath, 'migration:authority:import') !== authorityHash) {
  throw new Error('logical authority import hash diverged')
}
const imported = new WorldStore(importedPath)
for (const branch of branches) {
  const restored = imported.verifyBranchIntegrity(branch.address)
  const restoredHead = imported.head(branch.address)
  const projection = new ProjectionRebuilder(imported).rebuildAt(branch.address, restored.headSeq)
  if (restoredHead.eventHash !== branch.eventHash || projection.bundleHash !== branch.projectionHash) {
    throw new Error(`logical restore diverged for ${branch.address.branchId}`)
  }
}
imported.close()

const databasePaths = {
  worldPath,
  sessionPath: join(migrated, 'session.sqlite'),
  memoryPath: join(migrated, 'memory.sqlite'),
  contextPath,
  lockPath: join(migrated, 'instance.lock'),
  sourceDeployment: basename(source),
}
const deployment = new DeploymentBackupService(databasePaths)
const artifact = join(exercise, 'deployment-backup')
const manifest = await deployment.backup(artifact, 'migration:deployment:backup')
const restoredDirectory = join(exercise, 'deployment-restored')
const provenance = deployment.restore(artifact, restoredDirectory, 'migration:deployment:restore')
const restoredManifest = deployment.validate(restoredDirectory, 'migration:deployment:validate')
if (restoredManifest.manifestHash !== manifest.manifestHash) throw new Error('deployment restore manifest diverged')

const result = {
  schemaVersionBefore: before.schemaVersion,
  schemaVersionAfter: after.schemaVersion,
  historicalSnapshotHashBefore: before.hash,
  historicalSnapshotHashAfter: after.hash,
  contextSchemaVersionBefore: contextBefore.schemaVersion,
  contextSchemaVersionAfter: contextAfter.schemaVersion,
  contextSnapshotHashBefore: contextBefore.hash,
  contextSnapshotHashAfter: contextAfter.hash,
  sourceFiles,
  branches,
  authorityHash,
  deploymentManifestHash: manifest.manifestHash,
  restoreProvenanceHash: provenance.provenanceHash,
  restoredReady: true,
}
process.stdout.write(`${Buffer.from(canonicalizeWorldJson(result)).toString('utf8')}\n`)
