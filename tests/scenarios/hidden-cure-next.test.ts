import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WorldStore } from '@harness-world/store-sqlite'
import { currentEntityState } from '@harness-world/kernel'
import { brandId, interactionPackageDescription } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { compileWorldPackSource } from '@harness-world/world-pack'
import { goals, nextRoot, prepareTakenRecord } from '../support/hidden-cure-next-content.ts'
import { createEPolicy } from '../support/hidden-cure-next-policy.ts'
import { object } from '../support/hidden-cure-scenario.ts'
import type { PlayerView } from '../../packages/frontend/src/player-view.ts'

it('establishes the blocked condition through accepted player actions before NPC scheduling', async () => {
  const path = mkdtempSync(join(tmpdir(), 'hidden-cure-next-'))
  try {
    const results = await prepareTakenRecord(join(nextRoot, 'D3'), path)
    expect(results.map(result => result.status)).toEqual(['accepted', 'accepted', 'accepted'])
    const pack = await compileWorldPackSource(
      join(nextRoot, 'D3'),
      createInstalledInteractionPackages().map(interactionPackageDescription),
    )
    const store = new WorldStore(join(path, 'world.sqlite'))
    try {
      const events = store.readEvents({
        tenantId: brandId('tenant:web-playtest', 'TenantId'),
        worldId: brandId(`world:web-playtest:${pack.packHash.slice(7, 23)}`, 'WorldId'),
        branchId: brandId('branch:main', 'BranchId'),
      })
      expect(currentEntityState(events, 'entity:cure-record')).toMatchObject({
        holderId: 'character:player',
        locationId: null,
      })
      expect(
        events.filter(event => event.eventType === 'action.resolved').map(event => object(event.data).actorId),
      ).toEqual(['character:player', 'character:player', 'character:player'])
    } finally {
      store.close()
    }
    expect(goals.D3).toBe(goals.D2)
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
})

it('searches only authorized map options and never sends off-scene direct speech', () => {
  const view: PlayerView = {
    game: { title: 'test' },
    player: { name: '洛恩' },
    scene: { locationName: '旅馆', visibleCharacters: [], recipients: [] },
    status: 'ready',
    history: [],
    actions: [],
  }
  const policy = createEPolicy()
  expect(JSON.parse(policy(view).input.split('/act speak ')[1]!)).toMatchObject({ scope: 'self', addresseeIds: [] })
  view.actions.push({
    id: 'move:location:archive',
    label: '档案室',
    action: { actionType: 'move', parameters: { locationId: 'location:archive' } },
    kind: 'move',
  })
  const input = policy(view).input
  expect(input).toBe('/act move {"locationId":"location:archive"}')
})

it('uses a heard material claim to request a real handover without assigning an NPC action', () => {
  const policy = createEPolicy()
  const view: PlayerView = {
    game: { title: 'test' },
    player: { name: '洛恩' },
    status: 'ready',
    actions: [],
    scene: {
      locationName: '档案室',
      visibleCharacters: ['伊蕾', '塞维恩'],
      recipients: [
        { id: 'character:priestess', name: '伊蕾' },
        { id: 'character:rival', name: '塞维恩' },
      ],
    },
    history: [{ seq: 100, speaker: '塞维恩', text: '材料已经由我收存。', player: false }],
  }
  const choice = policy(view)
  expect(choice.input.startsWith('/act speak ')).toBe(true)
  expect(choice.basis).toContain('已听到')
  expect(choice.input).toContain('真正交由她保管')
  const alone = createEPolicy()
  view.scene!.recipients = [{ id: 'character:rival', name: '塞维恩' }]
  view.history[0]!.text = '我已经备齐材料。'
  expect(alone(view).input).toContain('伊蕾此刻不在这里')
})
