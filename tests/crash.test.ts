import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionDeliveryAdapter, WorldOutbox, WorldStore } from '@harness-world/store-sqlite'
import {
  fixtureAddress,
  fixtureCommitRequest,
  fixtureDeliveryRequest,
  hardKillAt,
} from '@harness-world/testkit'

const directories: string[] = []
const worker = fileURLToPath(new URL('./workers/crash-worker.ts', import.meta.url))

function database(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-crash-'))
  directories.push(directory)
  return join(directory, name)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
describe('hard process termination recovery', () => {
  it.each([
    ['store.after-event-insert', 0],
    ['store.before-commit', 0],
    ['store.after-commit', 1],
  ] as const)('recovers the complete World transaction at %s', async (point, expectedHead) => {
    const path = database(`${point}.sqlite`)
    const setup = new WorldStore(path)
    setup.createBranch(fixtureAddress())
    setup.close()
    await hardKillAt(worker, ['world', path, point])
    const recovered = new WorldStore(path)
    expect(recovered.head(fixtureAddress()).headSeq).toBe(expectedHead)
    expect(recovered.readEvents(fixtureAddress())).toHaveLength(expectedHead)
    expect(recovered.readOutbox(fixtureAddress())).toHaveLength(expectedHead)
    recovered.close()
  })

  it.each([
    ['session-delivery.after-inbox-insert', 0],
    ['session-delivery.after-observation-append', 0],
    ['session-delivery.after-commit', 1],
  ] as const)('recovers the complete Session delivery at %s', async (point, expectedCursor) => {
    const path = database(`${point}.sqlite`)
    await hardKillAt(worker, ['session', path, point])
    const recovered = new SessionDeliveryAdapter(path)
    expect(recovered.cursor(fixtureDeliveryRequest().sessionId)).toBe(expectedCursor)
    expect(recovered.readEvent(fixtureDeliveryRequest().sessionId, 1) !== undefined).toBe(expectedCursor === 1)
    recovered.close()
  })

  it.each([
    ['outbox.before-receipt-commit', false],
    ['outbox.after-receipt-commit', true],
  ] as const)('recovers the complete sender Receipt at %s', async (point, expectedReceipt) => {
    const path = database(`${point}.sqlite`)
    const setup = new WorldStore(path)
    setup.createBranch(fixtureAddress())
    await setup.commitRound(fixtureCommitRequest())
    setup.close()
    await hardKillAt(worker, ['outbox', path, point])
    const recovered = new WorldOutbox(path)
    const deliveryId = fixtureCommitRequest().outbox[0]!.deliveryId
    expect(recovered.hasReceipt(deliveryId)).toBe(expectedReceipt)
    expect(recovered.claimNext() === undefined).toBe(expectedReceipt)
    recovered.close()
  })
})
