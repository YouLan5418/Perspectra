import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, type WorldAddress } from '@harness-world/contracts'
import { SnapshotStore } from './snapshot-store.ts'

const directories: string[] = []

function fixture(): { path: string; address: WorldAddress } {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-snapshot-'))
  directories.push(directory)
  return {
    path: join(directory, 'snapshot.sqlite'),
    address: {
      tenantId: brandId('tenant:snapshot', 'TenantId'),
      worldId: brandId('world:snapshot', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    },
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('SnapshotStore', () => {
  it('stores complete deterministic bundles and retires only derived snapshots', () => {
    const { path, address } = fixture()
    const store = new SnapshotStore(path)
    expect(store.latest(address)).toBeUndefined()
    expect(() => store.read(address, 'snapshot:missing')).toThrow('header is missing')
    expect(() => store.create(address, -1, { projection: {} }, 'snapshot:invalid')).toThrow(RangeError)
    expect(() => store.create(address, 0, {}, 'snapshot:empty')).toThrow(TypeError)
    const first = store.create(address, 5, { projection: { claims: ['one'] }, characterViews: { count: 1 } }, 'snapshot:first')
    expect(first).toMatchObject({ status: 'created', bundle: { asOfSeq: 5, status: 'ready' } })
    expect(store.create(address, 5, { characterViews: { count: 1 }, projection: { claims: ['one'] } }, 'snapshot:replay'))
      .toEqual({ ...first, status: 'already_created' })
    expect(() => store.create(address, 5, { projection: { claims: ['changed'] } }, 'snapshot:conflict')).toThrow('different units')
    const second = store.create(address, 8, { projection: { claims: ['two'] } }, 'snapshot:second')
    expect(store.latest(address)).toEqual(second.bundle)
    expect(() => store.retireBefore(address, -1)).toThrow(RangeError)
    expect(store.retireBefore(address, 8)).toBe(1)
    expect(store.retireBefore(address, 8)).toBe(0)
    expect(store.latest(address)).toEqual(second.bundle)
    store.close()

    const raw = new DatabaseSync(path)
    expect(raw.prepare(`SELECT status FROM snapshot_bundles WHERE as_of_seq = 5`).get()).toEqual({ status: 'retired' })
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM snapshot_units`).get()).toEqual({ count: 3 })
    raw.close()
  })

  it('rejects missing or corrupt units and corrupt bundle headers', () => {
    const { path, address } = fixture()
    const setup = new SnapshotStore(path)
    const created = setup.create(address, 1, { projection: { value: 1 } }, 'snapshot:corruption')
    setup.close()

    const raw = new DatabaseSync(path)
    raw.prepare(`UPDATE snapshot_units SET content_json = '{"value":2}'`).run()
    raw.close()
    const corruptUnit = new SnapshotStore(path)
    expect(() => corruptUnit.latest(address)).toThrow('unit projection is corrupt')
    corruptUnit.close()

    const repair = new DatabaseSync(path)
    repair.prepare(`UPDATE snapshot_units SET content_json = '{"value":1}'`).run()
    repair.prepare(`UPDATE snapshot_bundles SET bundle_hash = 'sha256:corrupt'`).run()
    repair.close()
    const corruptHeader = new SnapshotStore(path)
    expect(() => corruptHeader.latest(address)).toThrow('bundle hash is corrupt')
    corruptHeader.close()

    const remove = new DatabaseSync(path)
    remove.exec('PRAGMA foreign_keys = OFF; DELETE FROM snapshot_units;')
    remove.close()
    const missing = new SnapshotStore(path)
    expect(() => missing.latest(address)).toThrow('no units')
    missing.close()
    expect(created.bundle.snapshotId).toContain('snapshot:')
  })
})
