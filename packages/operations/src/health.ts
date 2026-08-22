import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  brandId,
  type WorldAddress,
  type WorldJsonObject,
} from '@harness-world/contracts'
import { readPragmaInteger, WORLD_APPLICATION_ID, WORLD_SCHEMA_VERSION } from '@harness-world/store-sqlite'

export interface BranchHealthReport extends WorldJsonObject {
  readonly address: WorldAddress
  readonly status: 'healthy' | 'degraded' | 'quarantined'
  readonly runtimePhase: 'active' | 'maintenance' | 'quarantined' | 'archived'
  readonly runtimeEpoch: number
  readonly readyForRead: boolean
  readonly readyForWrite: boolean
  readonly readyForAgentCalls: boolean
  readonly openFailureCount: number
  readonly criticalDeadLetterCount: number
  readonly unavailableCharacterCount: number
  readonly characterAvailability: readonly {
    readonly characterId: string
    readonly state: string
    readonly reason: string | null
    readonly changedAtMs: number
  }[]
  readonly headSeq: number
  readonly tick: number
}

export interface WorldHealthReport extends WorldJsonObject {
  readonly status: 'ready' | 'degraded'
  readonly schemaVersion: number | null
  readonly branchCount: number
  readonly detail: string
  readonly readyForRead: boolean
  readonly readyForWrite: boolean
  readonly readyForAgentCalls: boolean
  readonly branches: readonly BranchHealthReport[]
}

function unavailable(detail: string, schemaVersion: number | null = null): WorldHealthReport {
  return {
    status: 'degraded', schemaVersion, branchCount: 0, detail,
    readyForRead: false, readyForWrite: false, readyForAgentCalls: false, branches: [],
  }
}

/** Read-only process, Branch, and capability readiness; it never migrates or repairs authority. */
export class WorldHealthService {
  constructor(private readonly worldPath: string) {}

  check(): WorldHealthReport {
    if (!existsSync(this.worldPath)) return unavailable('world database is missing')
    try {
      const db = new DatabaseSync(this.worldPath, { readOnly: true })
      try {
        const applicationId = readPragmaInteger(db, 'application_id')
        const schemaVersion = readPragmaInteger(db, 'user_version')
        const integrity = db.prepare('PRAGMA quick_check').get() as { quick_check?: string }
        if (applicationId !== WORLD_APPLICATION_ID || schemaVersion !== WORLD_SCHEMA_VERSION || integrity.quick_check !== 'ok') {
          return unavailable('identity, schema, or integrity mismatch', schemaVersion)
        }
        const rows = db.prepare(`
          SELECT b.tenant_id, b.world_id, b.branch_id, c.admission_state, c.lifecycle_state,
            c.runtime_phase, c.runtime_epoch, h.head_seq, h.tick,
            EXISTS(SELECT 1 FROM branch_activations a WHERE a.address_key = b.address_key) AS activated,
            (SELECT COUNT(*) FROM branch_failures f WHERE f.address_key = b.address_key AND f.status = 'open') AS open_failures,
            (SELECT COUNT(*) FROM outbox o WHERE o.address_key = b.address_key
              AND o.delivery_status = 'dead_letter' AND o.critical = 1) AS critical_dead_letters
          FROM branches b
          JOIN branch_controls c ON c.address_key = b.address_key
          JOIN heads h ON h.address_key = b.address_key
          ORDER BY b.tenant_id, b.world_id, b.branch_id
        `).all() as Array<{
          tenant_id: string
          world_id: string
          branch_id: string
          admission_state: 'open' | 'draining'
          lifecycle_state: 'active' | 'archived'
          runtime_phase: 'active' | 'maintenance' | 'quarantined' | 'archived'
          runtime_epoch: number
          head_seq: number
          tick: number
          activated: number
          open_failures: number
          critical_dead_letters: number
        }>
        const availabilityQuery = db.prepare(`
          SELECT character_id, state, reason, changed_at_ms FROM character_runtime_availability
          WHERE address_key = ? ORDER BY character_id
        `)
        const branches = rows.map(row => {
          const address = {
            tenantId: brandId(row.tenant_id, 'TenantId'),
            worldId: brandId(row.world_id, 'WorldId'),
            branchId: brandId(row.branch_id, 'BranchId'),
          }
          const characterAvailability = availabilityQuery.all(`${row.tenant_id}\u001f${row.world_id}\u001f${row.branch_id}`) as unknown as Array<{
            character_id: string; state: string; reason: string | null; changed_at_ms: number
          }>
          const unavailableCharacterCount = characterAvailability.filter(value => value.state !== 'ready').length
          const readyForWrite = row.admission_state === 'open'
            && row.lifecycle_state === 'active'
            && row.runtime_phase === 'active'
          const readyForAgentCalls = readyForWrite && row.activated === 1
            && row.critical_dead_letters === 0 && unavailableCharacterCount === 0
          const status = row.runtime_phase === 'quarantined'
            ? 'quarantined'
            : readyForWrite && readyForAgentCalls && row.open_failures === 0 ? 'healthy' : 'degraded'
          return {
            address,
            status,
            runtimePhase: row.runtime_phase,
            runtimeEpoch: row.runtime_epoch,
            readyForRead: true,
            readyForWrite,
            readyForAgentCalls,
            openFailureCount: row.open_failures,
            criticalDeadLetterCount: row.critical_dead_letters,
            unavailableCharacterCount,
            characterAvailability: characterAvailability.map(value => ({
              characterId: value.character_id, state: value.state, reason: value.reason, changedAtMs: value.changed_at_ms,
            })),
            headSeq: row.head_seq,
            tick: row.tick,
          } satisfies BranchHealthReport
        })
        return {
          status: 'ready', schemaVersion, branchCount: branches.length, detail: 'ok',
          readyForRead: true,
          readyForWrite: branches.some(branch => branch.readyForWrite),
          readyForAgentCalls: branches.some(branch => branch.readyForAgentCalls),
          branches,
        }
      } finally {
        db.close()
      }
    } catch (error: unknown) {
      return unavailable(`health check failed: ${String(error)}`)
    }
  }
}
