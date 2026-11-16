import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { CARD_CREDIT, CARD_CREDIT_LIMIT } from '../../packages/plugins/src/cards/rewards.ts'
import { FrontendActions } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { restoreStoryNode } from '../../apps/host/src/story-nodes.ts'
import { LauncherCore } from '../../apps/launcher/backend/core.ts'
import { openRpgWorld } from '../support/rpg-fixture.ts'
import {
  copyCards,
  startCards,
  chooseCard,
  retryCards,
  cardView,
  committedTable,
  npcChoice,
  object,
  PLAYER,
  B,
  C,
  type CardWorld,
} from '../support/cards-fixture.ts'
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const reward = { rule: 'auction', amount: 3, minimumBid: 6 }
const actor = (input: WorldJsonObject) => object(object(input.context).character).characterId
const decide = (input: WorldJsonObject) => (input.continuation ? { decision: 'abstain' } : npcChoice(input, 'bid:0'))
async function open(config: WorldJsonObject = {}, decision = decide) {
  const fixture = copyCards({ reward, ...config })
  cleanup.push(fixture.cleanup)
  const f = await openRpgWorld(fixture.pack, fixture.data, { decide: decision })
  cleanup.push(f.close)
  return { ...f, fixture }
}
function rewards(f: CardWorld) {
  return f
    .events()
    .filter(
      e =>
        e.eventType === 'status.updated' &&
        object(object(e.data).source).kind === 'activity' &&
        (object(e.data).changes as WorldJsonObject[]).some(change => change.key === CARD_CREDIT),
    )
}
function balance(f: CardWorld): number | undefined {
  return f
    .events()
    .filter(e => e.eventType === 'status.updated')
    .flatMap(e => object(e.data).changes as WorldJsonObject[])
    .findLast(change => change.holderId === PLAYER && change.key === CARD_CREDIT)?.value as number | undefined
}
function resumeEnded(f: CardWorld) {
  const event = f.events().findLast(event => event.eventType === 'activity.updated')!
  const state = object(object(event.data).state)
  return f.runtime.activityAction({
    activityKey: 'cards-auction',
    activityId: String(state.id),
    revision: Number(state.revision),
    operation: 'resume',
    parameters: {},
    requestId: randomUUID(),
  })
}
function ownCreditObjects(value: unknown): WorldJsonObject[] {
  if (Array.isArray(value)) return value.flatMap(ownCreditObjects)
  if (!value || typeof value !== 'object') return []
  const obj = object(value)
  return [
    ...(obj.holderId === PLAYER && obj.key === CARD_CREDIT && obj.value === 3 ? [obj] : []),
    ...Object.values(obj).flatMap(ownCreditObjects),
  ]
}
it('commits a qualifying victory and private world credit in one transaction; exact repeats, reopen and ended continuation do not award again', async () => {
  const f = await open()
  await startCards(f, 'auction')
  const before = await cardView(f),
    offered = before.actions.find(row => row.label === '提交牌桌选择')!
  const actions = new FrontendActions(f.runtime)
  const request = {
    operation: 'perform' as const,
    actionId: randomUUID(),
    requestId: randomUUID(),
    payload: { optionId: offered.id, arguments: { request: 'q1', seat: 'seat-1', choice: 'bid:9' } },
  }
  const final = await actions.perform(request)
  expect(committedTable(f).result!.winners).toEqual(['seat-1'])
  expect(balance(f)).toBe(3)
  expect(rewards(f)).toHaveLength(1)
  const paid = rewards(f)[0]!,
    end = f.events().findLast(e => e.eventType === 'activity.updated')!
  expect(end.transactionId).toBe(paid.transactionId)
  expect(object(object(end.data).state).game).toMatchObject({ active: false, phase: 'finished' })
  expect(final.statusBar).toContainEqual(
    expect.objectContaining({ holderId: PLAYER, key: CARD_CREDIT, value: 3, current: true }),
  )
  expect(ownCreditObjects(f.inputs)).toEqual([])
  expect(JSON.stringify(final)).not.toMatch(/"roles"|"internal"|"rng"/)
  const terminal = committedTable(f)
  const count = f.events().length
  await actions.perform(request)
  expect(f.events()).toHaveLength(count)
  await expect(actions.perform({ ...request, actionId: randomUUID(), requestId: randomUUID() })).rejects.toThrow()
  const denied = await f.runtime.perform({
    ...offered.action,
    parameters: {
      ...offered.action.parameters,
      arguments: { ...object(offered.action.parameters.arguments), ...request.payload.arguments },
    },
  })
  expect(denied.notice).toContain('未成功')
  expect(balance(f)).toBe(3)
  expect(rewards(f)).toHaveLength(1)
  expect(committedTable(f)).toEqual(terminal)
  expect(
    f
      .events()
      .slice(count)
      .filter(event => ['activity.updated', 'status.updated'].includes(event.eventType)),
  ).toEqual([])
  const saved = await f.runtime.saveNode('积分已结算')
  await f.close()
  const reopened = await openRpgWorld(f.pack, f.data)
  cleanup.push(reopened.close)
  expect(balance(reopened)).toBe(3)
  expect(rewards(reopened)).toHaveLength(1)
  expect(reopened.inputs).toHaveLength(0)
  await expect(resumeEnded(reopened)).rejects.toThrow()
  expect(balance(reopened)).toBe(3)
  expect(rewards(reopened)).toHaveLength(1)
  const forkDir = join(f.fixture.root, 'terminal-restore')
  restoreStoryNode(f.data, saved.id, forkDir, saved.packHash)
  const fork = await openRpgWorld(f.pack, forkDir)
  cleanup.push(fork.close)
  expect(balance(fork)).toBe(3)
  expect(rewards(fork)).toHaveLength(1)
  expect(fork.inputs).toHaveLength(0)
}, 60_000)
it('forks before the terminal bid into win/loss balances independently and imports the rewarded complete tree without another payout', async () => {
  const fixture = copyCards({ reward })
  cleanup.push(fixture.cleanup)
  const source = new LauncherCore(resolve('.'), join(fixture.root, 'source')),
    target = new LauncherCore(resolve('.'), join(fixture.root, 'target'))
  cleanup.push(async () => {
    await target.close()
    await source.close()
  })
  for (const core of [source, target]) {
    await core.initialize()
    await core.handle({ operation: 'load', path: fixture.pack })
  }
  const packageId = source.snapshot().packs[0]!.id
  await source.handle({ operation: 'create', packageId, name: '有奖牌桌' })
  const data = join(source.root, 'instances', source.snapshot().instances[0]!.id)
  let finish = false
  const original = await openRpgWorld(fixture.pack, data, {
    decide: input =>
      input.continuation
        ? { decision: 'abstain' }
        : actor(input) === B
          ? npcChoice(input, 'bid:6')
          : finish
            ? npcChoice(input, 'bid:5')
            : { decision: 'abstain' },
  })
  cleanup.push(original.close)
  await startCards(original, 'auction')
  await chooseCard(original, 'bid:7')
  expect(committedTable(original).pending!.answers).toEqual({ 'seat-1': 7, 'seat-2': 6 })
  expect(balance(original)).toBe(0)
  const node = await original.runtime.saveNode('终局前')
  for (const bid of [5, 8]) {
    const dir = join(fixture.root, 'branch-' + bid)
    restoreStoryNode(data, node.id, dir, node.packHash)
    const fork = await openRpgWorld(fixture.pack, dir, {
      decide: input => (input.continuation ? { decision: 'abstain' } : npcChoice(input, 'bid:' + bid)),
    })
    cleanup.push(fork.close)
    await retryCards(fork)
    expect(committedTable(fork).result!.winners).toEqual([bid === 5 ? 'seat-1' : 'seat-3'])
    expect(balance(fork)).toBe(bid === 5 ? 3 : 0)
    expect(rewards(fork)).toHaveLength(bid === 5 ? 1 : 0)
  }
  expect(balance(original)).toBe(0)
  expect(committedTable(original).pending).not.toBeNull()
  finish = true
  await retryCards(original)
  expect(balance(original)).toBe(3)
  await original.runtime.saveNode('终局与积分')
  await original.close()
  const archive = join(fixture.root, 'rewarded-tree.perspectra-backup')
  await source.handle({ operation: 'tree-backup', instanceId: source.snapshot().instances[0]!.id, path: archive })
  await target.handle({ operation: 'tree-restore', packageId, path: archive, name: '恢复有奖牌桌' })
  const restoredData = join(target.root, 'instances', target.snapshot().instances[0]!.id)
  const restored = await openRpgWorld(fixture.pack, restoredData)
  cleanup.push(restored.close)
  expect(balance(restored)).toBe(3)
  expect(rewards(restored)).toHaveLength(1)
  expect(committedTable(restored).result!.winners).toEqual(['seat-1'])
  expect(restored.inputs).toHaveLength(0)
  await restored.runtime.saveNode('不重复结算')
  await expect(resumeEnded(restored)).rejects.toThrow()
  expect(balance(restored)).toBe(3)
  expect(rewards(restored)).toHaveLength(1)
}, 60_000)
it('does not reward an unfinished forced exit, a loss, an under-threshold win, or a pack without the author opt-in', async () => {
  const unfinished = await open({}, () => ({ decision: 'abstain' }))
  await startCards(unfinished, 'auction')
  await chooseCard(unfinished, 'bid:7')
  await unfinished.runtime.escape()
  expect(committedTable(unfinished).result).toBeNull()
  expect(balance(unfinished)).toBe(0)
  expect(rewards(unfinished)).toHaveLength(0)
  await startCards(unfinished, 'identity')
  const identity = await cardView(unfinished)
  const zones = object(identity.activityStage!.payload.zones)
  expect(zones['hand:seat-2']).toEqual({ count: 4 })
  expect(zones['hand:seat-3']).toEqual({ count: 4 })
  expect(JSON.stringify(identity)).not.toMatch(/"roles"|"internal"|"rng"/)
  await unfinished.runtime.escape()
  expect(balance(unfinished)).toBe(0)

  const loss = await open({}, input => (input.continuation ? { decision: 'abstain' } : npcChoice(input, 'bid:8')))
  await startCards(loss, 'auction')
  await chooseCard(loss, 'bid:7')
  expect(committedTable(loss).result!.winners).not.toContain('seat-1')
  expect(balance(loss)).toBe(0)
  expect(rewards(loss)).toHaveLength(0)
  const below = await open()
  await startCards(below, 'auction')
  await chooseCard(below, 'bid:5')
  expect(committedTable(below).result!.winners).toEqual(['seat-1'])
  expect(balance(below)).toBe(0)
  expect(rewards(below)).toHaveLength(0)
  const fixture = copyCards()
  cleanup.push(fixture.cleanup)
  const disabled = await openRpgWorld(fixture.pack, fixture.data, { decide })
  cleanup.push(disabled.close)
  await startCards(disabled, 'auction')
  await chooseCard(disabled, 'bid:9')
  expect(balance(disabled)).toBeUndefined()
  expect(rewards(disabled)).toHaveLength(0)
}, 60_000)
it('formally rejects an out-of-range reward and leaves the final bid, terminal table and balance all uncommitted', async () => {
  let allowC = true,
    attempts = 0
  const f = await open({ reward: { ...reward, amount: CARD_CREDIT_LIMIT } }, input => {
    if (input.continuation) return { decision: 'abstain' }
    if (actor(input) === C) {
      if (!allowC) return { decision: 'abstain' }
      attempts++
    }
    return npcChoice(input, 'bid:0')
  })
  await startCards(f, 'auction')
  await chooseCard(f, 'bid:9')
  expect(balance(f)).toBe(CARD_CREDIT_LIMIT)
  allowC = false
  await startCards(f, 'auction')
  await chooseCard(f, 'bid:9')
  const before = committedTable(f),
    events = f.events(),
    attemptBefore = attempts
  allowC = true
  await retryCards(f).catch(() => undefined)
  expect(attempts).toBe(attemptBefore + 1)
  expect(f.events()).toEqual(events)
  expect(committedTable(f)).toEqual(before)
  expect(committedTable(f).result).toBeNull()
  expect(balance(f)).toBe(CARD_CREDIT_LIMIT)
  expect(rewards(f)).toHaveLength(1)
}, 60_000)
