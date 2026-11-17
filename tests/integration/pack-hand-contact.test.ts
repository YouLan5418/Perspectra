import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorldApplication } from '@perspectra/core'
import { GameplayScript } from '@perspectra/providers/activities'
import { adaptCompiledWorldPack, compileWorldPackSource } from '@perspectra/world-pack'
import { WorldStore } from '@perspectra/core/store'
import { brandId } from '@perspectra/sdk/contracts'
import type { RulebookEvent } from '@perspectra/core/kernel'

const player = brandId('character:player', 'CharacterId')
const companion = brandId('character:companion', 'CharacterId')
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(source?: string, root = mkdtempSync(join(tmpdir(), 'pack-contact-'))) {
  const packPath = resolve('examples/world-packs/hand-in-hand')
  const pack = await compileWorldPackSource(packPath, [])
  if (pack.compiledSchemaVersion !== 'worldpack/v5') throw new Error('expected current pack')
  expect(pack.interactions.packages).toEqual([])
  expect(pack.interactions.definitions).toEqual([])
  const compiled = adaptCompiledWorldPack(pack, {
    address: {
      tenantId: 'tenant:contact' as never,
      worldId: 'world:contact' as never,
      branchId: 'branch:main' as never,
    },
    principalId: 'principal:player',
    sessionId: 'session:contact' as never,
  })
  const worldPath = join(root, 'world.sqlite')
  const app = new WorldApplication({
    worldPath,
    sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'),
  })
  app.activate(compiled)
  const scope = await app.createInstanceScope()
  const engine = await app.createExecutionEngine({ scope, address: compiled.manifest.address })
  const gameplay = await app.createGameplayRuntime({
    scope,
    engine,
    address: compiled.manifest.address,
    availableServices: ['status'],
  })
  const script = new GameplayScript(source ?? readFileSync(join(packPath, pack.scripts!.gameplay.entry), 'utf8'))
  gameplay.register(script.definition, {})
  await gameplay.initialize()
  let closed = false
  const close = async () => {
    if (!closed) {
      closed = true
      await app.close()
      script.close()
    }
  }
  cleanup.push(async () => {
    await close()
    rmSync(root, { recursive: true, force: true })
  })
  const events = () => {
    const store = new WorldStore(worldPath)
    try {
      return store.readEvents(compiled.manifest.address)
    } finally {
      store.close()
    }
  }
  const partners = (actorId: string) =>
    events()
      .filter(event => event.eventType === 'status.updated')
      .flatMap(event => (event.data as { changes: { holderId: string; key: string; value: unknown }[] }).changes)
      .findLast(change => change.holderId === actorId && change.key === 'contact-partners')?.value
  const hold = () => gameplay.executePlayer('principal:player', 'contact:hold-hand', { partnerId: companion })
  const move = () =>
    app.submit(compiled.manifest.address, {
      idempotencyKey: 'move',
      principalId: 'principal:player',
      correlationId: 'contact:move',
      action: { actionType: 'move', parameters: { locationId: 'location:ridge-path' } },
    })
  return { app, gameplay, script, root, close, events, partners, hold, move }
}

it('uses pack-owned state for contact, checks both participants, and lets either side release', async () => {
  const f = await fixture()
  expect((await f.hold()).status).toBe('accepted')
  expect(f.partners(player)).toEqual([companion])
  expect(f.partners(companion)).toEqual([player])
  const head = f.events().length
  expect(await f.hold()).toMatchObject({ status: 'rejected', rejection: { code: 'CONTACT_ALREADY_ACTIVE' } })
  expect(f.events()).toHaveLength(head)
  expect(f.gameplay.adjudicate(f.events(), companion, 'contact:hold-hand', { partnerId: player })).toMatchObject({
    status: 'rejected',
    rejection: { code: 'CONTACT_PLAYER_ONLY' },
  })
  const release = f.gameplay.adjudicate(f.events(), companion, 'contact:end-contact', { partnerId: player })
  expect(release.status).toBe('accepted')
  expect(
    release.events
      .filter(event => event.eventType === 'status.updated')
      .flatMap(event => (event.data as { changes: unknown[] }).changes),
  ).toEqual([
    { holderId: companion, key: 'contact-partners', value: [] },
    { holderId: player, key: 'contact-partners', value: [] },
  ])
  expect(
    f.gameplay.adjudicate(f.events(), brandId('character:friend', 'CharacterId'), 'contact:end-contact', {
      partnerId: player,
    }),
  ).toMatchObject({ status: 'rejected', rejection: { code: 'CONTACT_NOT_ACTIVE' } })
  expect(
    (await f.gameplay.executePlayer('principal:player', 'contact:end-contact', { partnerId: companion })).status,
  ).toBe('accepted')
  expect(f.partners(player)).toEqual([])
  expect(f.partners(companion)).toEqual([])
  expect(f.events().some(event => event.eventType.startsWith('character.relation-'))).toBe(false)
})

it('restores pack state and ends both sides atomically with departure', async () => {
  const first = await fixture()
  await first.hold()
  await first.close()
  const f = await fixture(undefined, first.root)
  expect(f.partners(player)).toEqual([companion])
  await f.move()
  expect(f.partners(player)).toEqual([])
  expect(f.partners(companion)).toEqual([])
  const moved = f.events().findLast(event => event.eventType === 'character.moved')!
  const released = f.events().findLast(event => event.eventType === 'status.updated')!
  expect(released.transactionId).toBe(moved.transactionId)
  expect(await f.hold()).toMatchObject({ status: 'rejected', rejection: { code: 'CONTACT_OUT_OF_REACH' } })
})

it('rolls back the move when the pack derivation fails', async () => {
  const packSource = readFileSync(resolve('examples/world-packs/hand-in-hand/scripts/gameplay.cjs'), 'utf8')
  const f = await fixture(
    packSource.replace(
      /if \(!changes.length\) return \[\];?/,
      "if (!changes.length) return []; throw new Error('derivation failure');",
    ),
  )
  await f.hold()
  const before = f.events()
  await expect(f.move()).rejects.toMatchObject({ origin: 'plugin' })
  expect(f.events()).toEqual(before)
  expect(f.partners(player)).toEqual([companion])
})

it('keeps private contact lists out of a witness projection and supports author-defined NPC initiation', async () => {
  const packSource = readFileSync(resolve('examples/world-packs/hand-in-hand/scripts/gameplay.cjs'), 'utf8')
  const f = await fixture(packSource.replace('id === playerId', 'true'))
  await f.hold()
  const view = f.gameplay.projectContext(f.events(), brandId('character:friend', 'CharacterId'), {})
  expect(JSON.stringify(view)).not.toContain('"partners":["character:companion"]')
  const npcView = f.gameplay.projectContext(f.events(), companion, {})
  expect(JSON.stringify(npcView)).toContain('character:player')
  await f.gameplay.executePlayer('principal:player', 'contact:end-contact', { partnerId: companion })
  expect(f.gameplay.adjudicate(f.events(), companion, 'contact:hold-hand', { partnerId: player })).toMatchObject({
    status: 'rejected',
    rejection: { code: 'CONTACT_TARGET_DISABLED' },
  })
  // Target eligibility is authored too: this source permits the player as a contact target.
  const source = packSource
    .replace('id === playerId', 'true')
    .replace('const CONTACT_TARGETS = {', 'const CONTACT_TARGETS = { "character:player": "旅人",')
  const npc = await fixture(source)
  expect(npc.gameplay.adjudicate(npc.events(), companion, 'contact:hold-hand', { partnerId: player }).status).toBe(
    'accepted',
  )
})

it('uses authorized scene observers for gameplay results and rejects an unobservable contact target', async () => {
  const f = await fixture()
  const sceneId = 'scene:ridge-shelter'
  const hidden = (observerId: string): RulebookEvent => ({
    eventType: 'visibility.upsert',
    eventVersion: 1,
    data: { id: 'visibility:hidden', value: { sceneId, observerId, visible: false } },
  })
  const exclusions: RulebookEvent[] = [
    hidden('character:friend'),
    { eventType: 'scene.member_left', eventVersion: 1, data: { sceneId, characterId: 'character:friend' } },
    {
      eventType: 'character.lifecycle-changed',
      eventVersion: 1,
      data: { characterId: 'character:friend', lifecycleState: 'departed' },
    },
  ]
  for (const exclusion of exclusions) {
    const result = f.gameplay.adjudicate([...f.events(), exclusion], player, 'contact:hold-hand', {
      partnerId: companion,
    })
    expect(result.status).toBe('accepted')
    const recipients = result.events
      .filter(event => event.eventType === 'observation.upsert')
      .map(event => (event.data as { value: { observerId: string } }).value.observerId)
    expect(recipients).toContain(companion)
    expect(recipients).not.toContain('character:friend')
  }
  expect(
    f.gameplay.adjudicate([...f.events(), hidden(companion)], player, 'contact:hold-hand', { partnerId: companion }),
  ).toMatchObject({ status: 'rejected', rejection: { code: 'CONTACT_TARGET_UNOBSERVABLE' } })
})
