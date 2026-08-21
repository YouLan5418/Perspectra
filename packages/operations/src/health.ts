import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { WorldJsonObject } from '@harness-world/contracts'
import { readPragmaInteger, WORLD_APPLICATION_ID, WORLD_SCHEMA_VERSION } from '@harness-world/store-sqlite'

export interface WorldHealthReport extends WorldJsonObject {
  readonly status: 'ready' | 'degraded'
  readonly schemaVersion: number | null
  readonly branchCount: number
  readonly detail: string
}

/** Read-only local readiness check; it never migrates or repairs a database. */
export class WorldHealthService {
  constructor(private readonly worldPath: string) {}

  check(): WorldHealthReport {
    if (!existsSync(this.worldPath)) return { status: 'degraded', schemaVersion: null, branchCount: 0, detail: 'world database is missing' }
    try {
      const db = new DatabaseSync(this.worldPath, { readOnly: true })
      try {
        const applicationId = readPragmaInteger(db, 'application_id')
        const schemaVersion = readPragmaInteger(db, 'user_version')
        const integrity = db.prepare('PRAGMA quick_check').get() as { quick_check?: string }
        const branches = db.prepare('SELECT COUNT(*) AS count FROM branches').get() as { count: number }
        const checks = [applicationId === WORLD_APPLICATION_ID, schemaVersion === WORLD_SCHEMA_VERSION, integrity.quick_check === 'ok']
        if (!checks.every(Boolean)) {
          return { status: 'degraded', schemaVersion, branchCount: branches.count, detail: 'identity, schema, or integrity mismatch' }
        }
        return { status: 'ready', schemaVersion, branchCount: branches.count, detail: 'ok' }
      } finally {
        db.close()
      }
    } catch (error: unknown) {
      return { status: 'degraded', schemaVersion: null, branchCount: 0, detail: `health check failed: ${String(error)}` }
    }
  }
}
