import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandId, type WorldAddress } from '@harness-world/contracts'
import { DeterministicPresenter } from '@harness-world/presentation'
import { CharacterViewBuilder, SessionDeliveryAdapter, SessionOutboxWorker, WorldOutbox, WorldStore } from '@harness-world/store-sqlite'

describe('Phase 2 Observation and Session acceptance', () => {
  it('keeps multi-character futures private and closes the Outbox/Session/Presentation path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-p2-'))
    const worldPath = join(directory, 'world.sqlite')
    const sessionPath = join(directory, 'session.sqlite')
    const parent: WorldAddress = {
      tenantId: brandId('tenant:p2', 'TenantId'),
      worldId: brandId('world:p2', 'WorldId'),
      branchId: brandId('branch:parent', 'BranchId'),
    }
    const child: WorldAddress = { ...parent, branchId: brandId('branch:child', 'BranchId') }
    const characterA = brandId('character:a', 'CharacterId')
    const characterB = brandId('character:b', 'CharacterId')
    const sessionId = brandId('session:a', 'SessionId')
    try {
      const store = new WorldStore(worldPath)
      store.createBranch(parent)
      await store.commitRound({
        address: parent,
        transactionId: brandId('transaction:p2:base', 'TransactionId'),
        roundId: brandId('round:p2:base', 'InteractionRoundId'),
        expectedHeadSeq: 0,
        expectedTick: 0,
        nextTick: 1,
        events: [
          { eventType: 'character.upsert', eventVersion: 1, data: { characterId: characterA, locationId: 'location:room' } },
          { eventType: 'character.upsert', eventVersion: 1, data: { characterId: characterB, locationId: 'location:room' } },
          { eventType: 'scene.upsert', eventVersion: 1, data: { sceneId: 'scene:room', value: { participantIds: [characterA, characterB] } } },
          { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:a', value: { observerId: characterA, content: 'A_VISIBLE' } } },
          { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:b', value: { observerId: characterB, content: 'B_PRIVATE' } } },
          { eventType: 'claim.upsert', eventVersion: 1, data: { id: 'claim:a', value: { characterId: characterA, proposition: 'A_KNOWS' } } },
          { eventType: 'goal.upsert', eventVersion: 1, data: { id: 'goal:a', value: { characterId: characterA, goal: 'A_GOAL' } } },
        ],
        outbox: [{
          deliveryId: brandId('delivery:p2', 'DeliveryId'),
          sessionId,
          payload: { observationType: 'player-action-result', actionType: 'speak', status: 'accepted', reason: null },
          critical: true,
        }],
        correlationId: 'p2-base',
      })
      const forkSeq = store.head(parent).headSeq
      store.forkBranch(parent, child, forkSeq)
      const head = store.head(parent)
      await store.commitRound({
        address: parent,
        transactionId: brandId('transaction:p2:future', 'TransactionId'),
        roundId: brandId('round:p2:future', 'InteractionRoundId'),
        expectedHeadSeq: head.headSeq,
        expectedTick: head.tick,
        nextTick: head.tick + 1,
        events: [{ eventType: 'observation.upsert', eventVersion: 1, data: { id: 'future', value: { observerId: characterA, content: 'FUTURE_CANARY' } } }],
        outbox: [],
        correlationId: 'p2-future',
      })
      const view = new CharacterViewBuilder(store).rebuildAt(child, characterA, forkSeq)
      expect(JSON.stringify(view)).toContain('A_VISIBLE')
      expect(JSON.stringify(view)).not.toContain('B_PRIVATE')
      expect(JSON.stringify(view)).not.toContain('FUTURE_CANARY')

      const outbox = new WorldOutbox(worldPath)
      const session = new SessionDeliveryAdapter(sessionPath)
      const worker = new SessionOutboxWorker(outbox, session)
      await expect(worker.runOnce('p2-worker')).resolves.toEqual({ status: 'delivered', deliveryId: 'delivery:p2' })
      const delivered = session.readEvent(sessionId, 1)
      expect(delivered).toBeDefined()
      const rendered = new DeterministicPresenter().render(delivered!.payload, { locale: 'zh-CN' })
      expect(rendered.text).toBe('行动已执行：speak')
      expect(outbox.hasReceipt(brandId('delivery:p2', 'DeliveryId'))).toBe(true)
      session.close()
      outbox.close()
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
