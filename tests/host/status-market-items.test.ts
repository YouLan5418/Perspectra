import { createRoleplayCore } from '../support/roleplay-runtime.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { brandId, interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { adaptCompiledWorldPack, compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { currentEntityState } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { WorldHostCore } from '../../desktop/host/world-runtime.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import { loadStatus } from '../support/status-runtime.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'

// The market sample takes, drops and hands over its thermos with the author's script template only: the pack
// binds none of the built-in item rules.
const roots: string[] = [],
  runtimes: WorldHostCore[] = [],
  servers: Awaited<ReturnType<typeof startFakeProvider>>[] = []
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
  for (const server of servers.splice(0)) await server.close()
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'status-market-items-'))
  roots.push(root)
  const pack = join(root, 'pack'),
    data = join(root, 'data')
  cpSync(resolve('examples/world-packs/status-market'), pack, { recursive: true })
  // No usable provider: only the player's adjudicated actions change the world.
  const runtime = await createRoleplayCore({
    packPath: pack,
    dataDirectory: data,
    models: fakeModels('http://127.0.0.1:1/api/chat', 'openai', 'unused'),
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
  const status = loadStatus(f.packPath, pack)!
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

it('marks the statuses the author pinned to the bar and leaves the rest to the status drawer', async () => {
  const f = await fixture()
  const bar = projectPlayerView(await f.runtime.state()).statusBar ?? []
  expect(bar.filter(entry => entry.pinned).map(entry => entry.key)).toEqual(['money', 'time'])
  expect(bar.filter(entry => !entry.pinned).map(entry => entry.key)).toContain('quests')
})

it('lists the items the player can see: on the ground here, in hand, then with whoever it was handed to', async () => {
  const f = await fixture()
  const items = async () =>
    (projectPlayerView(await f.runtime.state()).items ?? []).map(({ id, name, where, holderName }) => ({
      id,
      name,
      where,
      ...(holderName === undefined ? {} : { holderName }),
    }))
  expect(await items()).toEqual([{ id: 'entity:thermos', name: '保温杯', where: 'here' }])
  await f.runtime.perform((await f.option('拿起保温杯')).action)
  expect(await items()).toEqual([{ id: 'entity:thermos', name: '保温杯', where: 'held' }])
  const give = await f.option('把保温杯交给')
  await f.runtime.perform({
    ...give.action,
    parameters: { ...give.action.parameters, arguments: { recipientId: 'character:companion' } },
  })
  // The player saw the handover, so it knows who holds the thermos now.
  expect(await items()).toEqual([{ id: 'entity:thermos', name: '保温杯', where: 'with', holderName: '同行者' }])
})

it('reports a failing author script as a refused request, as activity and communication mechanisms do', async () => {
  const f = await fixture()
  await f.runtime.close()
  const script = join(f.packPath, 'scripts/status.js')
  writeFileSync(
    script,
    readFileSync(script, 'utf8') + `\n;statusScript.resolve = () => { throw new Error('作者脚本出错') }\n`,
  )
  const runtime = await createRoleplayCore({
    packPath: f.packPath,
    dataDirectory: join(f.packPath, '..', 'failing-data'),
    models: fakeModels('http://127.0.0.1:1/api/chat', 'openai', 'unused'),
    timeoutMs: 1000,
  })
  runtimes.push(runtime)
  const take = projectPlayerView(await runtime.state()).actions.find(a => a.label === '拿起保温杯')!
  const failure = await runtime.perform(take.action).catch((error: unknown) => error)
  // The HTTP layer answers a TypeError with its message, and anything else with an opaque 500.
  expect(failure).toBeInstanceOf(TypeError)
  expect((failure as Error).message).toContain('作者脚本出错')
})

describe('a result told to nobody else', () => {
  const quiet = `\n;statusScript.resolve = (truth, actor) => ({ changes: [{ holderId: actor, key: 'money', value: 1 }], reveals: [], description: '悄悄记了一笔。', audience: { characters: [] } })\n`
  async function quietWorld(decide: (input: WorldJsonObject) => WorldJsonObject) {
    const root = mkdtempSync(join(tmpdir(), 'status-quiet-'))
    roots.push(root)
    const packPath = join(root, 'pack')
    cpSync(resolve('examples/world-packs/status-market'), packPath, { recursive: true })
    const script = join(packPath, 'scripts/status.js')
    writeFileSync(script, readFileSync(script, 'utf8') + quiet)
    const server = await startFakeProvider('openai', call => ({ tool: decide(JSON.parse(call.userText)) }))
    servers.push(server)
    const runtime = await createRoleplayCore({
      packPath,
      dataDirectory: join(root, 'data'),
      models: fakeModels(server.endpoint),
      timeoutMs: 5000,
      serialScheduling: true,
    })
    runtimes.push(runtime)
    const events = () => {
      const store = new WorldStore(join(root, 'data', 'world.sqlite'))
      try {
        return store.readEvents(runtime.address)
      } finally {
        store.close()
      }
    }
    const observers = () =>
      events()
        .filter(e => e.eventType === 'observation.upsert')
        .map(e => (e.data as WorldJsonObject).value as WorldJsonObject)
        .filter(v => (v.content as WorldJsonObject).resultDescription === '悄悄记了一笔。')
        .map(v => v.observerId)
    const money = (holderId: string) =>
      events()
        .filter(e => e.eventType === 'status.updated')
        .flatMap(e => (e.data as { changes: { holderId: string | null; key: string; value: unknown }[] }).changes)
        .findLast(c => c.holderId === holderId && c.key === 'money')?.value
    return { runtime, observers, money }
  }

  it('commits a player operation and tells only the player', async () => {
    const f = await quietWorld(() => ({ decision: 'abstain' }))
    const take = projectPlayerView(await f.runtime.state()).actions.find(a => a.label === '拿起保温杯')!
    await f.runtime.perform(take.action)
    expect(f.money('character:player')).toBe(1)
    expect(f.observers()).toEqual(['character:player'])
  })

  it('commits a character operation and tells only that character', async () => {
    let asked = false
    const f = await quietWorld(input => {
      const actor = ((input.context as WorldJsonObject).character as WorldJsonObject).characterId
      if (asked || actor !== 'character:companion') return { decision: 'abstain' }
      asked = true
      return {
        decision: 'perform',
        actionType: 'interact',
        parameters: {
          targetRef: { kind: 'entity', id: 'entity:thermos' },
          bindingId: 'status',
          definitionRef: { id: 'status:take', version: 1 },
          arguments: {},
        },
      }
    })
    await f.runtime.submit('你们随便看看。')
    expect(asked).toBe(true)
    expect(f.money('character:companion')).toBe(1)
    expect(f.observers()).toEqual(['character:companion'])
  })
})
