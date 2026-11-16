import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { createCardsContent, identityRule, move } from '@perspectra/plugins/cards'
import { AuthorizedSourceStore } from '@perspectra/core/memory'
import { WorldStore, CharacterViewBuilder } from '@perspectra/core/store'
import { brandId } from '@perspectra/sdk/contracts'
import { playerViewPatch } from '@perspectra/frontend'
import { assembleRoleplay } from '../../apps/host/src/official-bundle.ts'
import { openRpgWorld } from '../support/rpg-fixture.ts'
import {
  copyCards,
  startCards,
  cardView,
  chooseCard,
  committedTable,
  npcChoice,
  object,
  B,
  C,
  PLAYER,
  type CardWorld,
} from '../support/cards-fixture.ts'
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
// Normalize only runtime-generated identity/time fields. actorId, targets, responders, revisions,
// counts, operation arguments, source text and accepted/rejected outcomes remain in the comparison.
function normalized(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
      .replace(/choose-[0-9a-f]{20}/g, 'choose-<scope>')
      .replace(/observation:scene-result:[0-9a-f]{24}/g, 'observation:scene-result:<action-derived>')
      .replace(/"durationMs":\d+/g, '"durationMs":0')
      .replace(/opt:[0-9a-f]{64}/g, 'opt:<scope-derived>')
      .replace(/sha256:[0-9a-f]{64}/g, 'sha256:<derived>')
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<time>'),
  )
}
function evidence(f: CardWorld, observer: string) {
  const store = new WorldStore(join(f.runtime.dataDirectory, 'world.sqlite'))
  const memory = new AuthorizedSourceStore(join(f.runtime.dataDirectory, 'memory.sqlite'), store)
  try {
    const head = store.head(f.runtime.address).headSeq,
      id = brandId(observer, 'CharacterId')
    memory.catchUp(f.runtime.address, id, head)
    return {
      observations: new CharacterViewBuilder(store)
        .rebuildAt(f.runtime.address, id, head)
        .observations.toSorted((a, b) => a.sourceSeq - b.sourceSeq),
      sources: memory.sources(f.runtime.address, id, head),
    }
  } finally {
    memory.close()
    store.close()
  }
}
it('paired Host auction hides only-changed sealed values across raw state, deltas, observer model/continuation requests, observations and authorized memory', async () => {
  const pairs: unknown[] = []
  for (const bid of [6, 9]) {
    const fixture = copyCards()
    cleanup.push(fixture.cleanup)
    const f = await openRpgWorld(fixture.pack, fixture.data, {
      decide: input => {
        if (input.continuation) return { decision: 'abstain' }
        return object(object(input.context).character).characterId === B
          ? npcChoice(input, `bid:${bid}`)
          : { decision: 'abstain' }
      },
    })
    cleanup.push(f.close)
    await startCards(f, 'auction')
    const before = await cardView(f)
    await chooseCard(f, 'bid:5')
    const after = await cardView(f)
    expect(committedTable(f).pending!.answers['seat-2']).toBe(bid)
    const observerCalls = f.inputs.filter(input => object(object(input.context).character).characterId === C)
    expect(observerCalls.length).toBeGreaterThan(0)
    // Bidder's own continuation may know its input; neither other seat receives it.
    expect(
      f.inputs.some(input => input.continuation && object(object(input.context).character).characterId === B),
    ).toBe(true)
    const player = evidence(f, PLAYER),
      observer = evidence(f, C)
    const raw = await f.runtime.state()
    expect(JSON.stringify(raw.activity)).not.toContain(`bid:${bid}`)
    expect(JSON.stringify(after.activityStage)).not.toContain(`ownBid":${bid}`)
    expect(JSON.stringify({ player, observer })).not.toContain(`bid:${bid}`)
    pairs.push(
      normalized({ raw, before, after, delta: playerViewPatch(before, after), observerCalls, player, observer }),
    )
  }
  expect(pairs[0]).toEqual(pairs[1])
}, 60_000)
it('paired Host identity changes other hidden roles and defensive cards while fixed observers receive identical metadata and no hidden responder fingerprint', async () => {
  const pairs: unknown[] = []
  const OBSERVER = 'character:viewer'
  for (const variant of [false, true]) {
    const rule = {
      ...identityRule,
      initialize(s: Parameters<typeof identityRule.initialize>[0]) {
        identityRule.initialize(s)
        if (!variant) return
        const roles = s.data.roles as Record<string, string>
        ;[roles['seat-2'], roles['seat-3']] = [roles['seat-3']!, roles['seat-2']!]
        const b = s.zones['hand:seat-2']!.cards.find(id => s.cards[id]!.definition === 'defend')!
        const c = s.zones['hand:seat-3']!.cards.find(id => s.cards[id]!.definition === 'aid')!
        // Swap hidden custody while keeping all public counts and the fixed observer's own cards unchanged.
        move(s, [b], 'hand:seat-2', 'hand:seat-3')
        move(s, [c], 'hand:seat-3', 'hand:seat-2')
        // Hide the two custody operations' display epoch: initialize is one atomic setup in both variants.
        s.exposure -= 2
      },
    }
    const fixture = copyCards({ npcIds: [B, C, OBSERVER], seed: 1 })
    cleanup.push(fixture.cleanup)
    const f = await openRpgWorld(fixture.pack, fixture.data, {
      composition: assembleRoleplay({ content: [createCardsContent([rule])] }),
      decide: input =>
        input.continuation || object(object(input.context).character).characterId === OBSERVER
          ? { decision: 'abstain' }
          : npcChoice(input, 'pass'),
    })
    cleanup.push(f.close)
    await startCards(f, 'identity')
    const before = await cardView(f)
    const own = before.activityStage!.payload.own as unknown as { choices: { id: string }[] }[]
    const attack = own[0]!.choices.find(c => c.id.startsWith('attack:') && c.id.endsWith(':seat-2'))!
    await chooseCard(f, attack.id)
    const after = await cardView(f)
    const observerCalls = f.inputs.filter(input => object(object(input.context).character).characterId === OBSERVER)
    expect(observerCalls.length).toBeGreaterThan(0)
    expect(committedTable(f).pending!.kind).toBe('aid')
    expect(committedTable(f).pending!.seats).toEqual(['seat-3', 'seat-4'])
    pairs.push(
      normalized({
        raw: await f.runtime.state(),
        before,
        after,
        delta: playerViewPatch(before, after),
        observerCalls,
        player: evidence(f, PLAYER),
        observer: evidence(f, OBSERVER),
        offers: f.runtime.characterAffordances(OBSERVER),
      }),
    )
  }
  expect(pairs[0]).toEqual(pairs[1])
}, 60_000)
