import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createTable, identityRule, legalChoices } from '@perspectra/plugins/cards'
import { FrontendActions } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { restoreStoryNode } from '../../apps/host/src/story-nodes.ts'
import { openRpgWorld } from '../support/rpg-fixture.ts'
import {
  copyCards,
  startCards,
  cardView,
  chooseCard,
  committedTable,
  npcChoice,
  retryCards,
  object,
  B,
  C,
} from '../support/cards-fixture.ts'
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function open(config = {}, decide?: (input: import('@perspectra/sdk/contracts').WorldJsonObject) => unknown) {
  const fixture = copyCards(config)
  cleanup.push(fixture.cleanup)
  const f = await openRpgWorld(fixture.pack, fixture.data, decide ? { decide } : {})
  cleanup.push(f.close)
  return { ...f, fixture }
}
it('plays identity via actual Activity/Operation/stage; saves defense and aid, restores, forks and rejects old scope/stale/duplicate/unauthorized choices atomically', async () => {
  let mode = 'wait'
  const f = await open({}, input => {
    if (input.continuation) return { decision: 'abstain' }
    const actor = object(object(input.context).character).characterId
    return mode === 'pass' && actor === B ? npcChoice(input, 'pass') : { decision: 'abstain' }
  })
  await startCards(f, 'identity')
  expect((await cardView(f)).activityStage!.renderer).toBe('official-cards.table')
  const before = await cardView(f),
    oldAction = before.actions.find(a => a.label === '提交牌桌选择')!
  const payload = before.activityStage!.payload
  const own = payload.own as unknown as { seat: string; choices: { id: string }[] }[]
  const attack = own[0]!.choices.find(c => c.id.startsWith('attack:') && c.id.endsWith(':seat-2'))!
  const args = { request: object(payload.request).id!, seat: 'seat-1', choice: attack.id }
  const bad = {
    ...oldAction.action,
    parameters: {
      ...oldAction.action.parameters,
      arguments: { ...object(oldAction.action.parameters.arguments), ...args, seat: 'seat-2' },
    },
  }
  const events = f.events().length
  await expect(f.runtime.perform(bad)).rejects.toThrow()
  expect(f.events()).toHaveLength(events)
  await chooseCard(f, attack.id)
  expect(committedTable(f).pending!.kind).toBe('defense')
  expect(committedTable(f).zones.paid!.cards).toHaveLength(1)
  const defense = await f.runtime.saveNode('等待乙防御')
  mode = 'pass'
  await retryCards(f)
  expect(committedTable(f).pending!.kind).toBe('aid')
  expect(committedTable(f).turnOwner).toBe('seat-1')
  const aid = await f.runtime.saveNode('等待丙求援')
  for (const [node, prefix] of [
    [defense, 'defend:'],
    [aid, 'aid:'],
    [aid, 'pass'],
  ] as const) {
    const dir = join(f.fixture.root, `fork-${prefix.replace(':', '')}`)
    restoreStoryNode(f.data, node.id, dir, node.packHash)
    const fork = await openRpgWorld(f.pack, dir, {
      decide: input =>
        input.continuation ? { decision: 'abstain' } : npcChoice(input, ids => ids.find(id => id.startsWith(prefix))),
    })
    cleanup.push(fork.close)
    const count = fork.events().length
    await expect(
      fork.runtime.perform({
        ...oldAction.action,
        parameters: {
          ...oldAction.action.parameters,
          arguments: { ...object(oldAction.action.parameters.arguments), ...args },
        },
      }),
    ).rejects.toThrow()
    expect(fork.events()).toHaveLength(count)
    expect(fork.inputs).toHaveLength(0)
    await retryCards(fork)
    expect(committedTable(fork).frames).toEqual([])
    expect(committedTable(fork).zones.paid!.cards).toEqual([])
    expect(committedTable(fork).accepted).toHaveLength(node === defense ? 2 : 3)
    if (prefix === 'defend:') expect(committedTable(fork).log.join()).toContain('不退款')
  }
  const count = f.events().length
  await expect(f.runtime.perform(oldAction.action)).rejects.toThrow()
  expect(f.events()).toHaveLength(count)
  await f.runtime.escape()
  expect((await cardView(f)).activityStage).toBeNull()
  expect(f.events().filter(e => ['entity.transferred', 'status.updated'].includes(e.eventType))).toEqual([])
}, 60_000)
it('actual Host auction keeps one logical multi-seat request and resumes without re-asking accepted bids', async () => {
  let bidB = false,
    bidC = false
  const f = await open({}, input => {
    if (input.continuation) return { decision: 'abstain' }
    const actor = object(object(input.context).character).characterId
    return actor === B && bidB
      ? npcChoice(input, 'bid:8')
      : actor === C && bidC
        ? npcChoice(input, 'bid:7')
        : { decision: 'abstain' }
  })
  await startCards(f, 'auction')
  bidB = true
  await chooseCard(f, 'bid:5')
  expect(committedTable(f).pending!.answers).toEqual({ 'seat-1': 5, 'seat-2': 8 })
  const logical = committedTable(f).pending!.id
  const view = await cardView(f)
  expect(JSON.stringify(view.activityStage)).not.toContain('ownBid":8')
  expect(view.actions.some(a => a.label === '提交牌桌选择')).toBe(false)
  const node = await f.runtime.saveNode('两席密封')
  const dir = join(f.fixture.root, 'auction-restore')
  restoreStoryNode(f.data, node.id, dir, node.packHash)
  const asked: string[] = []
  const fork = await openRpgWorld(f.pack, dir, {
    decide: input => {
      asked.push(String(object(object(input.context).character).characterId))
      return input.continuation ? { decision: 'abstain' } : npcChoice(input, 'bid:7')
    },
  })
  cleanup.push(fork.close)
  expect(committedTable(fork).pending!.id).toBe(logical)
  expect(fork.inputs).toHaveLength(0)
  await retryCards(fork)
  expect(committedTable(fork).result!.winners).toEqual(['seat-2'])
  expect(asked).not.toContain(B)
  expect((await cardView(fork)).activityStage).toBeNull()
  const count = fork.events().length
  await expect(
    fork.runtime.activityAction({
      activityKey: 'cards-auction',
      activityId: String(view.activityStage!.activityId),
      revision: Number(view.activityStage!.revision),
      operation: 'choose-old',
      parameters: { request: logical, seat: 'seat-2', choice: 'bid:9' },
      requestId: randomUUID(),
    }),
  ).rejects.toThrow()
  expect(fork.events()).toHaveLength(count)
  bidC = true
  await retryCards(f)
  expect(committedTable(f).result).toEqual(committedTable(fork).result)
}, 60_000)
it('official deterministic NPCs use the same validator and return to ordinary life after normal finish', async () => {
  const f = await open({ npcMode: 'deterministic' })
  await startCards(f, 'auction')
  await chooseCard(f, 'bid:9')
  expect(committedTable(f).result).not.toBeNull()
  expect(committedTable(f).accepted.map(row => row.actor)).toEqual(['character:player', B, C])
  expect((await cardView(f)).activityStage).toBeNull()
  await startCards(f, 'identity')
  await f.runtime.escape()
  expect(committedTable(f).result).toBeNull()
  expect((await cardView(f)).activityStage).toBeNull()
})
it('fixture seed provides actual legal defense and third-seat aid for the recovery scenarios', () => {
  const s = createTable(
    identityRule,
    ['x', 'y', 'z'].map((id, i) => ({ id: `seat-${i + 1}`, controller: id, label: id })),
    3,
  )
  expect(legalChoices(s, identityRule, 'seat-1').length).toBeGreaterThan(1)
  expect(s.zones['hand:seat-2']!.cards.some(id => s.cards[id]!.definition === 'defend')).toBe(true)
  expect(s.zones['hand:seat-3']!.cards.some(id => s.cards[id]!.definition === 'aid')).toBe(true)
})
it('rejects an old instance action at exactly the same activity/request/revision; fresh actions continue and identical request retries do not commit twice', async () => {
  const f = await open()
  await startCards(f, 'auction')
  const view = await cardView(f),
    action = view.actions.find(a => a.label === '提交牌桌选择')!
  const args = { request: 'q1', seat: 'seat-1', choice: 'bid:5' }
  const submittedAction = {
    ...action.action,
    parameters: { ...action.action.parameters, arguments: { ...object(action.action.parameters.arguments), ...args } },
  }
  const node = await f.runtime.saveNode('相同版本请求')
  const dir = join(f.fixture.root, 'same-revision')
  restoreStoryNode(f.data, node.id, dir, node.packHash)
  const fork = await openRpgWorld(f.pack, dir)
  cleanup.push(fork.close)
  expect((await fork.runtime.state()).activity!.id).toBe((await f.runtime.state()).activity!.id)
  expect((await fork.runtime.state()).activity!.revision).toBe((await f.runtime.state()).activity!.revision)
  const count = fork.events().length
  await expect(fork.runtime.perform(submittedAction)).rejects.toThrow()
  expect(fork.events()).toHaveLength(count)
  const actions = new FrontendActions(fork.runtime),
    fresh = (await cardView(fork)).actions.find(a => a.label === '提交牌桌选择')!
  const request = {
    operation: 'perform' as const,
    actionId: randomUUID(),
    requestId: randomUUID(),
    payload: { optionId: fresh.id, arguments: args },
  }
  await actions.perform(request)
  const acceptedCount = fork.events().length
  await actions.perform(request)
  expect(fork.events()).toHaveLength(acceptedCount)
  expect(committedTable(fork).accepted).toHaveLength(1)
  await expect(actions.perform({ ...request, actionId: randomUUID(), requestId: randomUUID() })).rejects.toThrow()
  expect(fork.events()).toHaveLength(acceptedCount)
}, 60_000)
it('keeps unsupported card tail regeneration safely rejected and retains the committed result', async () => {
  const f = await open()
  await startCards(f, 'auction')
  await chooseCard(f, 'bid:5')
  const before = committedTable(f),
    events = f.events().length
  const state = await f.runtime.state()
  expect(state.tailRound?.canRegenerate).toBe(true)
  await expect(f.runtime.regenerate(state.tailRound!.id!, randomUUID())).rejects.toThrow()
  expect(committedTable(f)).toEqual(before)
  expect(f.events()).toHaveLength(events)
  // Ordinary node restore/fresh operation continuation remains covered above and in cards-save-tree.
}, 60_000)
it('refuses incompatible rule/state versions before resuming and keeps the saved bytes unchanged', async () => {
  const { createCardsContent, officialCardRules } = await import('@perspectra/plugins/cards')
  const { assembleRoleplay } = await import('../../apps/host/src/official-bundle.ts')
  const { readFileSync } = await import('node:fs')
  const f = await open()
  await startCards(f, 'auction')
  await chooseCard(f, 'bid:5')
  const node = await f.runtime.saveNode('不兼容规则探针')
  const dir = join(f.fixture.root, 'incompatible-rule')
  restoreStoryNode(f.data, node.id, dir, node.packHash)
  const before = readFileSync(join(dir, 'world.sqlite'))
  await expect(
    openRpgWorld(f.pack, dir, {
      composition: assembleRoleplay({
        content: [
          createCardsContent(
            officialCardRules.map(rule => ({ ...rule, version: rule.id === 'auction' ? 2 : rule.version })),
          ),
        ],
      }),
    }),
  ).rejects.toThrow('validateState')
  expect(readFileSync(join(dir, 'world.sqlite'))).toEqual(before)
})
