import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, hashWorldJson } from '@harness-world/contracts'
import { fixtureAddress, fixtureCommitRequest } from '@harness-world/testkit'
import { WorldLogicalTransferService } from './logical-transfer.ts'
import { OperationalAuditLog } from './operational-audit.ts'
import { RoundInbox } from './round-inbox.ts'
import { SessionDeliveryAdapter } from './session-delivery.ts'
import { SessionOutboxWorker, WorldOutbox } from './outbox-worker.ts'
import { WriterLeaseService } from './writer-lease.ts'
import { WorldStore } from './world-store.ts'

const directories: string[] = []

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'hcw-logical-transfer-'))
  directories.push(path)
  return path
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('WorldLogicalTransferService', () => {
  it('round-trips authority tables without Session, Memory, Audit, or process state', async () => {
    const root = directory()
    const source = join(root, 'source.sqlite')
    const parent = fixtureAddress('logical-parent')
    const child = fixtureAddress('logical-child')
    const setup = new WorldStore(source)
    setup.createBranch(parent)
    const commitRequest = fixtureCommitRequest(parent)
    const committed = await setup.commitRound(commitRequest)
    setup.forkBranch(parent, child, 1)
    const eventHash = setup.readEvents(parent)[0]!.eventHash
    setup.close()
    const leases = new WriterLeaseService(source)
    const lease = leases.acquire(parent, 'kernel:logical')
    const inbox = new RoundInbox(source)
    inbox.enqueue({
      address: parent,
      idempotencyKey: 'logical:completed',
      principalId: 'principal:logical',
      input: { actionType: 'fixture' },
      correlationId: 'logical:inbox',
    }, 4)
    inbox.claimNext(parent, 'kernel:logical', lease.fencingToken)
    const completedResult = { status: 'accepted', bundleHash: committed.bundleHash }
    inbox.complete(parent, 1, 'kernel:logical', lease.fencingToken, {
      transactionId: commitRequest.transactionId,
      bundleHash: committed.bundleHash,
    }, completedResult)
    inbox.close()
    leases.close()
    const sender = new WorldOutbox(source)
    const delivery = sender.claimNext(parent)
    if (delivery === undefined) throw new Error('logical transfer fixture Outbox is missing')
    await sender.recordDelivered(delivery)
    sender.close()

    const service = new WorldLogicalTransferService(source)
    const exportPath = join(root, 'world.dshworld')
    const bundleHash = service.exportAuthority(exportPath, 'logical:export')
    const target = join(root, 'target.sqlite')
    expect(service.importAuthority(exportPath, target, 'logical:import')).toBe(bundleHash)
    const imported = new WorldStore(target)
    expect(imported.readEvents(parent)[0]!.eventHash).toBe(eventHash)
    expect(imported.readEvents(child)).toHaveLength(1)
    imported.close()
    const importedInbox = new RoundInbox(target)
    expect(importedInbox.readCompleted(parent, 'logical:completed')).toEqual(completedResult)
    importedInbox.close()
    const importedOutbox = new WorldOutbox(target)
    const rebuiltSession = new SessionDeliveryAdapter(join(root, 'rebuilt-session.sqlite'))
    const rebuiltWorker = new SessionOutboxWorker(importedOutbox, rebuiltSession, parent)
    await expect(rebuiltWorker.runOnce('logical:session-rebuild')).resolves.toMatchObject({
      status: 'delivered', deliveryId: commitRequest.outbox[0]!.deliveryId,
    })
    expect(rebuiltSession.cursor(commitRequest.outbox[0]!.sessionId)).toBe(1)
    expect(rebuiltSession.readEvent(commitRequest.outbox[0]!.sessionId, 1)).toMatchObject({
      payloadHash: hashWorldJson('world-outbox-payload', commitRequest.outbox[0]!.payload),
    })
    rebuiltSession.close()
    importedOutbox.close()
    const importProvenance = new OperationalAuditLog(`${target}.audit.sqlite`)
    expect(importProvenance.read()).toMatchObject([{
      operation: 'authority.import.completed',
      details: { exportPath: expect.stringContaining('world.dshworld'), bundleHash },
    }])
    importProvenance.close()
    const tamperedInbox = JSON.parse(readFileSync(exportPath, 'utf8')) as any
    tamperedInbox.data.tables.round_inbox[0].commit_bundle_hash = 'sha256:wrong'
    tamperedInbox.bundleHash = hashWorldJson('logical-authority-export', tamperedInbox.data)
    const tamperedInboxPath = join(root, 'tampered-inbox.dshworld')
    writeFileSync(tamperedInboxPath, JSON.stringify(tamperedInbox))
    expect(() => service.importAuthority(tamperedInboxPath, join(root, 'tampered-inbox.sqlite'), 'logical:inbox-tamper'))
      .toThrow('completed Round Inbox')
    const malformedResult = JSON.parse(readFileSync(exportPath, 'utf8')) as any
    malformedResult.data.tables.round_inbox[0].result_json = JSON.stringify('not-an-object')
    malformedResult.data.tables.round_inbox[0].result_hash = hashWorldJson('player-round-result', 'not-an-object')
    malformedResult.bundleHash = hashWorldJson('logical-authority-export', malformedResult.data)
    const malformedResultPath = join(root, 'malformed-result.dshworld')
    writeFileSync(malformedResultPath, JSON.stringify(malformedResult))
    expect(() => service.importAuthority(malformedResultPath, join(root, 'malformed-result.sqlite'), 'logical:result-shape'))
      .toThrow('completed Round Inbox')
    expect(() => service.exportAuthority(source, 'logical:alias')).toThrow('aliases the source')
    expect(() => service.importAuthority(exportPath, target, 'logical:exists')).toThrow('already exists')
    const audit = new OperationalAuditLog(`${source}.audit.sqlite`)
    expect(audit.read().map(event => event.operation)).toEqual(expect.arrayContaining([
      'authority.export.requested', 'authority.export.completed',
      'authority.import.requested', 'authority.import.completed',
    ]))
    audit.close()
  })

  it('exports every authority table from one WAL snapshot during a concurrent commit', async () => {
    const root = directory()
    const source = join(root, 'source.sqlite')
    const target = fixtureAddress('snapshot')
    const setup = new WorldStore(source)
    setup.createBranch(target)
    const first = await setup.commitRound(fixtureCommitRequest(target))
    setup.close()
    let committedDuringExport = false
    const service = new WorldLogicalTransferService(source, (table) => {
      if (table !== 'branches' || committedDuringExport) return
      committedDuringExport = true
      const writer = new WorldStore(source)
      void writer.commitRound({
        ...fixtureCommitRequest(target),
        transactionId: brandId('transaction:concurrent-export', 'TransactionId'),
        roundId: brandId('round:concurrent-export', 'InteractionRoundId'),
        expectedHeadSeq: first.headSeq,
        expectedTick: first.tick,
        nextTick: first.tick + 1,
        events: [{ eventType: 'fixture.concurrent', eventVersion: 1, data: {} }],
        outbox: [],
      })
      writer.close()
    })
    const exportPath = join(root, 'snapshot.dshworld')
    service.exportAuthority(exportPath, 'logical:snapshot')
    expect(committedDuringExport).toBe(true)
    const importedPath = join(root, 'snapshot-import.sqlite')
    service.importAuthority(exportPath, importedPath, 'logical:snapshot-import')
    const imported = new WorldStore(importedPath)
    expect(imported.head(target).headSeq).toBe(first.headSeq)
    imported.close()
    const sourceAfter = new WorldStore(source)
    expect(sourceAfter.head(target).headSeq).toBe(first.headSeq + 1)
    sourceAfter.close()
  })

  it('rolls back both in-transaction and post-commit export failures', () => {
    const root = directory()
    const source = join(root, 'source.sqlite')
    const setup = new WorldStore(source)
    setup.createBranch(fixtureAddress('export-failure'))
    setup.close()

    const interrupted = new WorldLogicalTransferService(source, table => {
      if (table === 'events') throw new Error('interrupted export')
    })
    expect(() => interrupted.exportAuthority(join(root, 'interrupted.dshworld'), 'logical:interrupted'))
      .toThrow('interrupted export')

    const occupiedTarget = join(root, 'occupied-after-commit.dshworld')
    const occupied = new WorldLogicalTransferService(source, table => {
      if (table === 'round_inbox') writeFileSync(occupiedTarget, 'occupied')
    })
    expect(() => occupied.exportAuthority(occupiedTarget, 'logical:post-commit'))
      .toThrow()
  })

  it('round-trips an empty genesis head and rejects corrupted genesis metadata', () => {
    const root = directory()
    const source = join(root, 'source.sqlite')
    const setup = new WorldStore(source)
    setup.createBranch(fixtureAddress('empty-logical'))
    setup.close()
    const service = new WorldLogicalTransferService(source)
    const exportPath = join(root, 'empty.dshworld')
    service.exportAuthority(exportPath, 'logical:empty')
    service.importAuthority(exportPath, join(root, 'empty.sqlite'), 'logical:empty-import')
    const envelope = JSON.parse(readFileSync(exportPath, 'utf8')) as any
    const rejectHead = (name: string, mutate: (head: any) => void) => {
      const copy = structuredClone(envelope)
      mutate(copy.data.tables.heads[0])
      copy.bundleHash = hashWorldJson('logical-authority-export', copy.data)
      const path = join(root, `${name}.dshworld`)
      writeFileSync(path, JSON.stringify(copy))
      expect(() => service.importAuthority(path, join(root, `${name}.sqlite`), `logical:${name}`))
        .toThrow('Event chain tail')
    }
    rejectHead('empty-hash', head => { head.event_hash = 'sha256:not-genesis' })
    rejectHead('empty-tick', head => { head.tick = 1 })
  })

  it('rejects malformed, unsupported, missing-table, invalid-row, and divergent Event exports', async () => {
    const root = directory()
    const source = join(root, 'source.sqlite')
    const setup = new WorldStore(source)
    const address = fixtureAddress()
    setup.createBranch(address)
    await setup.commitRound(fixtureCommitRequest(address))
    setup.forkBranch(address, fixtureAddress('logical-validation-child'), 1)
    setup.close()
    const service = new WorldLogicalTransferService(source)
    const malformed = join(root, 'malformed.dshworld')
    writeFileSync(malformed, '{')
    expect(() => service.importAuthority(malformed, join(root, 'malformed.sqlite'), 'logical:malformed')).toThrow('invalid')

    const valid = join(root, 'valid.dshworld')
    service.exportAuthority(valid, 'logical:valid')
    const envelope = JSON.parse(readFileSync(valid, 'utf8')) as any
    const unsupported = join(root, 'unsupported.dshworld')
    writeFileSync(unsupported, JSON.stringify({ ...envelope, format: 'wrong' }))
    expect(() => service.importAuthority(unsupported, join(root, 'unsupported.sqlite'), 'logical:unsupported')).toThrow('unsupported')
    const badHash = join(root, 'bad-hash.dshworld')
    writeFileSync(badHash, JSON.stringify({ ...envelope, bundleHash: 'sha256:wrong' }))
    expect(() => service.importAuthority(badHash, join(root, 'bad-hash.sqlite'), 'logical:hash')).toThrow('hash is invalid')

    const missing = structuredClone(envelope)
    delete missing.data.tables.heads
    missing.bundleHash = (await import('@harness-world/contracts')).hashWorldJson('logical-authority-export', missing.data)
    const missingPath = join(root, 'missing.dshworld')
    writeFileSync(missingPath, JSON.stringify(missing))
    expect(() => service.importAuthority(missingPath, join(root, 'missing.sqlite'), 'logical:missing')).toThrow('table heads is missing')

    const invalidRow = structuredClone(envelope)
    invalidRow.data.tables.heads = [1]
    invalidRow.bundleHash = (await import('@harness-world/contracts')).hashWorldJson('logical-authority-export', invalidRow.data)
    const invalidRowPath = join(root, 'invalid-row.dshworld')
    writeFileSync(invalidRowPath, JSON.stringify(invalidRow))
    expect(() => service.importAuthority(invalidRowPath, join(root, 'invalid-row.sqlite'), 'logical:row')).toThrow('invalid row')

    const divergent = structuredClone(envelope)
    divergent.data.tables.events[0].event_hash = brandId('sha256:divergent', 'WorldHash')
    divergent.bundleHash = (await import('@harness-world/contracts')).hashWorldJson('logical-authority-export', divergent.data)
    const divergentPath = join(root, 'divergent.dshworld')
    writeFileSync(divergentPath, JSON.stringify(divergent))
    expect(() => service.importAuthority(divergentPath, join(root, 'divergent.sqlite'), 'logical:event')).toThrow('divergent Event')

    const rejectTamper = (name: string, mutate: (copy: any) => void, expected: string) => {
      const copy = structuredClone(envelope)
      mutate(copy)
      copy.bundleHash = hashWorldJson('logical-authority-export', copy.data)
      const exportPath = join(root, `${name}.dshworld`)
      writeFileSync(exportPath, JSON.stringify(copy))
      expect(() => service.importAuthority(exportPath, join(root, `${name}.sqlite`), `logical:${name}`)).toThrow(expected)
    }
    rejectTamper('unknown-column', copy => { copy.data.tables.heads[0].extra = true }, 'missing or unknown columns')
    rejectTamper('renamed-column', copy => {
      copy.data.tables.heads[0].unexpected_tick = copy.data.tables.heads[0].tick
      delete copy.data.tables.heads[0].tick
    }, 'missing or unknown columns')
    rejectTamper('head', copy => { copy.data.tables.heads[0].head_seq = 0 }, 'Head does not match')
    rejectTamper('head-tail', copy => { copy.data.tables.heads[0].event_hash = 'sha256:wrong-tail' }, 'Event chain tail')
    rejectTamper('head-tail-tick', copy => { copy.data.tables.heads[0].tick += 1 }, 'Event chain tail')
    rejectTamper('round-bundle', copy => { copy.data.tables.round_commits[0].bundle_hash = 'sha256:wrong' }, 'Round bundle')
    rejectTamper('round-event-range', copy => { copy.data.tables.round_commits[0].head_seq += 1 }, 'Round event range')
    rejectTamper('round-outbox-boundary', copy => { copy.data.tables.outbox[0].world_seq += 1 }, 'Outbox boundary')
    rejectTamper('round-tick-boundary', copy => { copy.data.tables.round_commits[0].base_tick += 2 }, 'tick boundary')
    rejectTamper('outbox-state', copy => { copy.data.tables.outbox[0].delivery_status = 'delivered' }, 'normalized Outbox')
    rejectTamper('outbox-attempt', copy => { copy.data.tables.outbox[0].attempt_count = 1 }, 'normalized Outbox')
    rejectTamper('outbox-sequence', copy => { copy.data.tables.outbox[0].session_delivery_seq = 2 }, 'Outbox delivery sequencing')
    rejectTamper('outbox-counter', copy => {
      copy.data.tables.outbox[0].session_delivery_seq = 1
      copy.data.tables.outbox_session_counters = [{
        session_id: copy.data.tables.outbox[0].session_id,
        next_delivery_seq: 3,
      }]
    }, 'Outbox delivery sequencing')
    rejectTamper('outbox-error', copy => { copy.data.tables.outbox[0].last_error = 'tampered' }, 'normalized Outbox')
    rejectTamper('outbox-payload', copy => {
      copy.data.tables.outbox[0].payload_hash = 'sha256:wrong-payload'
      const commit = copy.data.tables.round_commits[0]
      commit.bundle_hash = hashWorldJson('world-round-bundle', {
        address: fixtureAddress(),
        roundId: commit.round_id,
        tick: commit.tick,
        eventHashes: copy.data.tables.events
          .filter((event: any) => event.transaction_id === commit.transaction_id)
          .map((event: any) => event.event_hash),
        outboxHashes: ['sha256:wrong-payload'],
      })
    }, 'normalized Outbox')

    rejectTamper('fork-parent-world', copy => {
      copy.data.tables.branches[1].world_id = 'world:other'
    }, 'invalid Branch parent')
    rejectTamper('fork-anchor', copy => {
      copy.data.tables.branches[1].fork_seq = 999
    }, 'invalid Branch fork anchor')
    rejectTamper('fork-cycle', copy => {
      copy.data.tables.branches[1].parent_address_key = copy.data.tables.branches[1].address_key
    }, 'cyclic Branch lineage')

    rejectTamper('event-chain', copy => {
      const event = copy.data.tables.events[0]
      event.previous_hash = 'sha256:wrong-parent'
      event.event_hash = hashWorldJson('world-event-envelope', {
        address: fixtureAddress(),
        seq: event.seq,
        tick: event.tick,
        eventType: event.event_type,
        eventVersion: event.event_version,
        data: JSON.parse(event.data_json),
        previousHash: event.previous_hash,
        transactionId: event.transaction_id,
        eventOrdinal: event.event_ordinal,
      })
    }, 'discontinuous Event chain')
  })
})
