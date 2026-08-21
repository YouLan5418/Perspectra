import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalizeWorldJson, type WorldJsonValue } from '@harness-world/contracts'

export const WORLD_APPLICATION_ID = 0x48435757
export const SESSION_APPLICATION_ID = 0x48435753
export const PROJECTION_APPLICATION_ID = 0x48435750
export const SCHEMA_VERSION = 1

export function readPragmaInteger(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>
  const value = row[name]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`PRAGMA ${name} is not an integer`)
  return value
}

/** Open one owned SQLite database with the locked V0 durability configuration. */
export function openOwnedDatabase(path: string, applicationId: number, schema: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = FULL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    const existingApplicationId = readPragmaInteger(db, 'application_id')
    const existingVersion = readPragmaInteger(db, 'user_version')
    if (existingApplicationId !== 0 && existingApplicationId !== applicationId) {
      throw new Error(`SQLite application_id mismatch: expected ${applicationId}, got ${existingApplicationId}`)
    }
    if (existingVersion !== 0 && existingVersion !== SCHEMA_VERSION) {
      throw new Error(`SQLite user_version mismatch: expected ${SCHEMA_VERSION}, got ${existingVersion}`)
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(schema)
      db.exec(`PRAGMA application_id = ${applicationId}`)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      db.exec('COMMIT')
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

/** Serialize already validated World JSON for a TEXT column. */
export function worldJsonText(value: WorldJsonValue): string {
  return Buffer.from(canonicalizeWorldJson(value)).toString('utf8')
}

/** Parse and revalidate World JSON read from durable storage. */
export function parseWorldJson(text: string): WorldJsonValue {
  const value: unknown = JSON.parse(text)
  canonicalizeWorldJson(value as WorldJsonValue)
  return value as WorldJsonValue
}

/** Roll back an active transaction without hiding the original error. */
export function rollbackAndThrow(db: DatabaseSync, error: unknown): never {
  try {
    db.exec('ROLLBACK')
  } catch {
    // A failed COMMIT can leave no active transaction; the original failure owns the operation.
  }
  throw error
}
