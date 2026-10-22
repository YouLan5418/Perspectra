import { afterEach, expect, it } from 'vitest'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { brandId, interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { adaptCompiledWorldPack, compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { currentEntityState } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { WorldHostCore } from '../../desktop/host/world-runtime.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import { PackStatus } from '../../desktop/host/pack-status.ts'

// The market sample takes, drops and hands over its thermos with the author's script template only: the pack
// binds none of the built-in item rules.
const roots: string[] = [],
  runtimes: WorldHostCore[] = []
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'status-market-items-'))
  roots.push(root)
  const pack = join(root, 'pack'),
    data = join(root, 'data')
  cpSync(resolve('examples/world-packs/status-market'), pack, { recursive: true })
  // No usable provider: only the player's adjudicated actions change the world.
  const runtime = await WorldHostCore.create({
    packPath: pack,
    dataDirectory: data,
    provider: 'ollama',
    model: 'unused',
    utilityEndpoint: 'http://127.0.0.1:1/api/chat',
    timeoutMs: 1000,
  })
  runtimes.push(runtime)
  const events = () => {
    const store = new WorldStore(join(data, 'world.sqlite'))
    try {
      return store.readEvents(runtime.address)
    } finally {
      store.close()
    }
  }
  const labels = async () =>
    projectPlayerView(await runtime.state())
      .actions.filter(a => a.target?.kind === 'item')
      .map(a => a.label)
  const option = async (label: string) => projectPlayerView(await runtime.state()).actions.find(a => a.label === label)!
  return { runtime, events, labels, option, packPath: pack }
}

it('offers only the item actions that can succeed, and moves the thermos by the author rules alone', async () => {
  const f = await fixture()
  const thermos = () => currentEntityState(f.events(), 'entity:thermos')!
  expect(await f.labels()).toEqual(['拿起保温杯'])
  await f.runtime.perform((await f.option('拿起保温杯')).action)
  expect(thermos().holderId).toBe('character:player')
  expect(await f.labels()).toEqual(['放下保温杯', '把保温杯交给'])
  const give = await f.option('把保温杯交给')
  expect(give.characterArguments).toEqual(['recipientId'])
  await f.runtime.perform({
    ...give.action,
    parameters: { ...give.action.parameters, arguments: { recipientId: 'character:companion' } },
  })
  expect(thermos().holderId).toBe('character:companion')
  expect(await f.labels()).toEqual([])
  // The bystander saw the hand-over, as with the built-in give.
  const witnessed = f
    .events()
    .filter(e => e.eventType === 'observation.upsert')
    .map(e => (e.data as WorldJsonObject).value as WorldJsonObject)
    .filter(
      v =>
        ((v.content as WorldJsonObject).interaction as WorldJsonObject | undefined)?.toHolderId ===
        'character:companion',
    )
  expect(witnessed.map(v => v.observerId)).toContain('character:friend')
})

it('refuses an item action the policy did not offer, without changing the world', async () => {
  const f = await fixture()
  const before = f.events().length
  // Dropping a thermos nobody holds was never offered; a forged request is refused before the author runs.
  await expect(f.runtime.submit('/status drop@entity:thermos {}')).rejects.toThrow('当前已知条件不允许')
  expect(f.events()).toHaveLength(before)
})

it('tells an actor whose item operation the author refused where the item still is, if it can see it', async () => {
  const f = await fixture()
  const pack = (await compileWorldPackSource(
    f.packPath,
    createInstalledInteractionPackages().map(interactionPackageDescription),
  )) as CompiledWorldPackV5
  const status = PackStatus.load(f.packPath, pack)!
  const refused = (actorId: string, operation: string) =>
    status.executionResult({
      manifest: adaptCompiledWorldPack(pack, {
        address: f.runtime.address,
        principalId: 'principal:test',
        sessionId: brandId('session:test', 'SessionId'),
      }).manifest,
      // The author's refusal as the rulebook records it for the actor.
      events: [
        ...f.events(),
        {
          eventType: 'action.rejected',
          data: { characterId: actorId, reason: 'STATUS_OPERATION_REJECTED', description: '杯盖没拧紧' },
        },
      ],
      actorId: brandId(actorId, 'CharacterId'),
      action: {
        actionType: 'interact',
        parameters: {
          targetRef: { kind: 'entity', id: 'entity:thermos' },
          definitionRef: { id: 'status:' + operation },
        },
      },
      status: 'rejected',
      reason: 'STATUS_OPERATION_REJECTED',
    })?.description
  // On the floor where the friend stands.
  expect(refused('character:friend', 'take')).toBe('杯盖没拧紧。这次没有执行，保温杯仍在原处。')
  await f.runtime.perform((await f.option('拿起保温杯')).action)
  expect(refused('character:player', 'give')).toBe('杯盖没拧紧。这次没有执行，保温杯仍在你手里。')
  // In someone else's hands: the author's reason only, nothing about who holds it.
  expect(refused('character:friend', 'take')).toBe('杯盖没拧紧')
})
