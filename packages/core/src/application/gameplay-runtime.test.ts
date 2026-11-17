import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { GameplayScript } from '@perspectra/providers/activities'
import type { ContentGameplay } from '@perspectra/sdk'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  brandId,
  hashWorldJson,
  playerRoundNumber,
  resolutionAuthority,
  type StatusDefinition,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@perspectra/sdk/contracts'
import { createCoreRulebookRegistry, type CompiledWorldSpec } from '@perspectra/core/kernel'
import { WorldStore } from '@perspectra/core/store'
import {
  defineGameplay,
  defineOperation,
  nativeGameplay,
  type ActivityHooks,
  type GameplayComputation,
  type GameplayEffect,
  type OperationResultProjection,
  type GameplayAfterActionInput,
  type GameplayCycleEndInput,
  type OperationResolution,
} from '@perspectra/sdk'
import {
  investigationGameplay,
  searchOperation,
  inspectOperation,
  type SearchOutcome,
  type InvestigationState,
} from '../../../sdk/src/gameplay.example.ts'
import { characterActionExplanations } from '../../../providers/src/chat/character-action-explanations.ts'
import { WorldApplication } from './world-application.ts'
import { createSchedulerRound } from './scheduler-round.ts'
import { statusObject, StatusState } from './status-state.ts'
import { activityProgress } from './activity-state.ts'
import { frozenInteractionWorld, basicInteractionPackage } from '../../../../tests/fixtures/frozen-interaction-world.ts'

const npc = brandId('character:npc', 'CharacterId'),
  player = brandId('character:player', 'CharacterId')
const cleanup: (() => Promise<void>)[] = []

it.each([false, true])(
  'uses the same owner merge for structured and primitive status effects (merge=%s)',
  async merge => {
    const f = await fixture()
    const operation = defineOperation<{ health: number }>()({
      id: 'health:mixed',
      argumentSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      resultSchema: { type: 'null', nullable: true },
      resolve: ({ actorId }) => ({
        status: 'accepted',
        outcome: null,
        effects: [
          {
            kind: 'status-result',
            result: {
              changes: [{ holderId: actorId, key: 'health', value: 4 }],
              reveals: [],
              description: 'four',
              audience: 'self',
            },
          },
          { kind: 'status', changes: [{ holderId: actorId, key: 'health', value: 2 }], reveals: [] },
        ],
      }),
    })
    const definition = defineGameplay<{ health: number }, Empty, null>()({
      id: 'health:owner',
      version: '1',
      dataVersion: 1,
      requiredServices: ['status'],
      configSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      states: [
        {
          key: 'health',
          label: 'health',
          type: 'number',
          owner: 'character',
          schema: { type: 'number' },
          alwaysKnown: false,
          playerTruth: false,
          bar: false,
        },
      ],
      operations: [operation],
      initializeState: ({ characterIds }) => ({
        public: {},
        characters: Object.fromEntries(characterIds.map(id => [id, { health: 5 }])),
      }),
      ...(merge
        ? {
            combineChanges: (input: { changes: readonly import('@perspectra/sdk/contracts').StatusChange[] }) => [
              input.changes.at(-1)!,
            ],
          }
        : {}),
    })
    f.gameplay.register(definition, {})
    await f.gameplay.initialize()
    const before = f.events()
    const run = f.gameplay.executePlayer(f.manifest.playerBindings[0]!.principalId, operation.id, {})
    if (!merge) {
      await expect(run).rejects.toThrow()
      expect(f.events()).toEqual(before)
    } else {
      expect(await run).toMatchObject({ status: 'accepted' })
      expect(
        new StatusState(
          { statuses: definition.states, operations: [] },
          f.manifest.characters.map(row => row.characterId),
          f.manifest.entities,
        ).truth(f.events()).characters[player]?.health,
      ).toBe(2)
    }
  },
)

it('starts official-style definitions through the public activity API with a fresh identity each time', async () => {
  const f = await fixture()
  let startAllowed = false
  const initialized = vi.fn()
  const hooks: ActivityHooks = {
    definition: { title: 'table', npcIds: [npc], operations: [] },
    phases: ['ready'],
    initialize: input => (
      initialized(),
      {
        active: true,
        phase: 'ready',
        turn: player,
        round: 1,
        public: {},
        internal: {},
        private: Object.fromEntries([player, ...(input.npcIds as string[])].map(id => [id, {}])),
      }
    ),
    autoStart: () => ({ when: [['当前条件', startAllowed]] }),
    policy: () => ({
      speech: 'free',
      speechChoices: [],
      narration: true,
      move: false,
      interactions: [],
      operations: [],
    }),
    resolve: () => ({ rejectReason: 'none' }),
    schedule: () => ({ kind: 'wait' }),
    onOutcome: () => ({}),
  }
  f.gameplay.register(
    nativeGameplay({ id: 'test:table', version: '1', dataVersion: 1, activities: [{ key: 'table', activity: hooks }] }),
    {},
  )
  await f.gameplay.initialize()
  const principal = f.manifest.playerBindings[0]!.principalId
  const before = f.events()
  expect(await f.gameplay.startActivity(principal, 'table', [npc])).toMatchObject({ status: 'rejected' })
  expect(f.events()).toEqual(before)
  expect(initialized).not.toHaveBeenCalled()
  startAllowed = true
  expect(await f.gameplay.startActivity(principal, 'table', [npc])).toMatchObject({ status: 'accepted' })
  const first = activityProgress(f.events()).get('table')!
  expect(first.participants).toEqual([player, npc])
  await f.gameplay.controlActivity(principal, 'table', 'escape')
  expect(await f.gameplay.startActivity(principal, 'table', [npc])).toMatchObject({ status: 'accepted' })
  expect(activityProgress(f.events()).get('table')!.id).not.toBe(first.id)
})

it('rechecks native status membership, known policy and real item targets at the public entry', async () => {
  const f = await fixture()
  let allowed = false
  const resolve = vi.fn(() => ({ changes: [], reveals: [], audience: 'self', description: 'done' }))
  const noInput = { type: 'object', properties: {}, required: [], additionalProperties: false } as const
  f.gameplay.register(
    nativeGameplay({
      id: 'test:status',
      version: '1',
      dataVersion: 1,
      activities: [],
      status: {
        declaration: { id: 'test', characters: [player] },
        module: {
          definition: {
            statuses: [],
            actions: [
              { id: 'use', label: 'use', schema: noInput, targets: ['entity:cup'] },
              { id: 'rest', label: 'rest', schema: noInput },
            ],
          },
          initialize: () => ({ public: {}, characters: {} }),
          policy: known => {
            expect(known).toEqual({ public: {}, characters: {}, self: {} })
            return { operations: allowed ? ['use', 'rest'] : [] }
          },
          resolve,
        },
      },
    }),
    {},
  )
  await f.gameplay.initialize()
  const before = f.events()
  expect(f.gameplay.adjudicate(before, npc, 'status:test-rest', {}).status).toBe('rejected')
  expect((await f.gameplay.executePlayer('principal:player', 'status:test-rest', {})).status).toBe('rejected')
  expect(resolve).not.toHaveBeenCalled()
  expect(f.events()).toEqual(before)
  allowed = true
  expect((await f.gameplay.executePlayer('principal:player', 'status:test-use', {}, 'entity:other')).status).toBe(
    'rejected',
  )
  expect((await f.gameplay.executePlayer('principal:player', 'status:test-use', {})).status).toBe('rejected')
  const remote = before.map(event =>
    event.eventType === 'entity.upsert' && statusObject(event.data).entityId === 'entity:cup'
      ? { ...event, data: { ...statusObject(event.data), locationId: 'location:next' } as WorldJsonObject }
      : event,
  )
  expect(f.gameplay.adjudicate(remote, player, 'status:test-use', {}, undefined, 'entity:cup').status).toBe('rejected')
  expect(resolve).not.toHaveBeenCalled()
  expect(f.events()).toEqual(before)
  expect((await f.gameplay.executePlayer('principal:player', 'status:test-use', {}, 'entity:cup')).status).toBe(
    'accepted',
  )
  expect(resolve).toHaveBeenCalledOnce()
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
type Empty = Record<string, never>
const empty = (id: string) =>
  defineGameplay<Empty, Empty, null>()({
    id,
    version: '1.0.0',
    dataVersion: 1,
    requiredServices: [],
    operations: [],
    configSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  })
const config = { cluePrefix: 'clue:', maxEnergy: 3 }
const searchArgs = { locationId: 'location:archive', effort: 1 }

it('uses the same restricted candidate material when validating native targets', async () => {
  const f = await fixture()
  const visit = defineOperation<Empty>()<{ locationId: string }, null>({
    id: 'target:visit',
    argumentSchema: {
      type: 'object',
      properties: { locationId: { type: 'string' } },
      required: ['locationId'],
      additionalProperties: false,
    },
    resultSchema: { type: 'null', nullable: true },
    ui: { label: '候选地点', targetKind: 'location' },
    offer: input =>
      input.candidates.flatMap(candidate =>
        candidate.actionType === 'move'
          ? (candidate.destinations ?? []).map(destination => ({
              id: 'visit:' + destination.locationId,
              label: '候选地点',
              targetId: destination.locationId,
              parameters: { locationId: destination.locationId },
            }))
          : [],
      ),
    resolve: () => ({ status: 'accepted', outcome: null, effects: [] }),
  })
  let locked = false
  f.gameplay.register(
    {
      ...empty('target:owner'),
      operations: [visit],
      restrictions: [
        {
          id: 'rule:no-next',
          operations: ['move'],
          check: input =>
            locked && input.parameters.locationId === 'location:next'
              ? { code: 'LOCKED', message: '不能到下个地点。' }
              : undefined,
        },
      ],
    },
    {},
  )
  await f.gameplay.initialize()
  const rules = f.gameplay.resolver(
    createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }).resolve(
      f.manifest.rulebook.rulebookId,
      f.manifest.rulebook.version,
      'targets',
    ),
  )
  const context = () => ({
    manifest: f.manifest,
    manifestHash: f.manifestHash,
    asOfWorldSeq: f.events().at(-1)!.seq,
    resolutionAuthority: resolutionAuthority('player', 'standard'),
    events: f.events(),
    characterId: player,
  })
  // Public execution may wrap the Host resolver again; it must not duplicate the same proposal.
  expect(f.gameplay.resolver(rules).affordances(context())).toEqual(rules.affordances(context()))
  const parameters = {
    targetRef: { kind: 'location', id: 'location:next' },
    bindingId: 'gameplay',
    definitionRef: { id: visit.id, version: 1 },
    arguments: { locationId: 'location:next' },
  }
  expect(rules.resolve({ ...context(), action: { actionType: 'interact', parameters } }).status).toBe('accepted')
  locked = true
  expect(
    rules
      .affordances(context())
      .flatMap(offer => offer.interactions ?? [])
      .some(option => statusObject(option.definitionRef).id === visit.id),
  ).toBe(false)
  expect(rules.resolve({ ...context(), action: { actionType: 'interact', parameters } })).toMatchObject({
    status: 'rejected',
    events: [],
    rejection: { code: 'GAMEPLAY_OPERATION_TARGET_UNAVAILABLE' },
  })
})

it('retains location and clue offer targets and revalidates them at the formal action entry', async () => {
  const f = await fixture()
  f.gameplay.register(investigationGameplay, config)
  await f.gameplay.initialize()
  const rules = f.gameplay.resolver(
    createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }).resolve(
      f.manifest.rulebook.rulebookId,
      f.manifest.rulebook.version,
      'targets',
    ),
  )
  const context = () => ({
    manifest: f.manifest,
    manifestHash: f.manifestHash,
    asOfWorldSeq: f.events().at(-1)!.seq,
    events: f.events(),
    characterId: player,
    resolutionAuthority: resolutionAuthority('player', 'standard'),
  })
  const choice = (id: string) =>
    rules
      .affordances(context())
      .flatMap(offer => offer.interactions ?? [])
      .find(option => statusObject(option.definitionRef).id === id)!
  const search = choice(searchOperation.id)
  expect(search.targetRef).toEqual({ kind: 'location', id: 'location:archive' })
  const parameters = (option: WorldJsonObject) => ({
    targetRef: option.targetRef!,
    bindingId: option.bindingId!,
    definitionRef: option.definitionRef!,
    arguments: option.arguments!,
  })
  const before = await f.app.head(f.address)
  expect(
    rules.resolve({
      ...context(),
      action: {
        actionType: 'interact',
        parameters: { ...parameters(search), targetRef: { kind: 'location', id: 'location:next' } },
      },
    }),
  ).toMatchObject({
    status: 'rejected',
    events: [],
    rejection: { code: 'GAMEPLAY_OPERATION_TARGET_UNAVAILABLE' },
  })
  expect(await f.app.head(f.address)).toEqual(before)
  expect(
    (
      await f.app.submit(f.address, {
        principalId: 'principal:player',
        idempotencyKey: 'target-search',
        correlationId: 'target-search',
        action: { actionType: 'interact', parameters: parameters(search) },
      })
    ).status,
  ).toBe('accepted')
  const inspect = choice(inspectOperation.id)
  expect(inspect.targetRef).toEqual({ kind: 'entity', id: 'clue:archive-letter' })
  expect(
    rules.resolve({
      ...context(),
      action: {
        actionType: 'interact',
        parameters: { ...parameters(inspect), targetRef: { kind: 'entity', id: 'clue:unknown' } },
      },
    }),
  ).toMatchObject({
    status: 'rejected',
    events: [],
    rejection: { code: 'GAMEPLAY_OPERATION_TARGET_UNAVAILABLE' },
  })
  expect(
    (
      await f.app.submit(f.address, {
        principalId: 'principal:player',
        idempotencyKey: 'target-inspect',
        correlationId: 'target-inspect',
        action: { actionType: 'interact', parameters: parameters(inspect) },
      })
    ).status,
  ).toBe('accepted')
})

it('checks final invariants on activity resume and rolls back the whole transition', async () => {
  const f = await fixture()
  f.gameplay.register(
    {
      ...investigationGameplay,
      validateState(state, activities) {
        if (activities['investigation-site']?.game.active && state.characters[player]!.energy !== 3)
          throw new Error('ACTIVE_REQUIRES_FULL_ENERGY')
      },
    },
    config,
  )
  await f.gameplay.initialize()
  await f.gameplay.startActivity('principal:player', 'investigation-site', [npc])
  await f.gameplay.controlActivity('principal:player', 'investigation-site', 'suspend')
  await f.gameplay.executePlayer('principal:player', searchOperation.id, searchArgs)
  const before = await f.app.head(f.address)
  await expect(f.gameplay.controlActivity('principal:player', 'investigation-site', 'resume')).rejects.toMatchObject({
    origin: 'plugin',
    pluginId: investigationGameplay.id,
    operation: 'validateState',
  })
  expect(await f.app.head(f.address)).toEqual(before)
  expect(
    statusObject(
      statusObject(
        f
          .events()
          .filter(e => e.eventType === 'activity.updated')
          .at(-1)!.data,
      ).state,
    ).game,
  ).toMatchObject({ active: false })
})

it('rejects async native invariant results before commit and observes their rejection', async () => {
  const f = await fixture()
  let asynchronous = false
  const finished = vi.fn()
  f.gameplay.register(
    {
      ...investigationGameplay,
      validateState() {
        if (!asynchronous) return
        return (async () => {
          await Promise.resolve()
          finished()
          throw new Error('ASYNC_INVALID_STATE')
        })()
      },
    },
    config,
  )
  await f.gameplay.initialize()
  asynchronous = true
  const before = await f.app.head(f.address)
  await expect(f.gameplay.executePlayer('principal:player', searchOperation.id, searchArgs)).rejects.toMatchObject({
    origin: 'plugin',
    pluginId: investigationGameplay.id,
    operation: 'validateState',
    invalidResult: true,
  })
  await Promise.resolve()
  expect(finished).toHaveBeenCalledOnce()
  expect(await f.app.head(f.address)).toEqual(before)
})

it('revokes a queued child-owned cycle hook after the engine captured its hook list', async () => {
  const f = await fixture()
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => {
    entered = resolve
  })
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  f.engine.registerCoreCycleEndHook({
    pluginId: 'a:gate',
    hookId: 'wait',
    async resolve() {
      entered()
      await gate
      return undefined
    },
  })
  const hook = vi.fn((): readonly GameplayEffect[] => [
    { kind: 'status', changes: [{ holderId: null, key: 'counter', value: 1 }], reveals: [] },
  ])
  const fiber = f.scope.context.plugin(context => {
    f.gameplay.register(
      {
        ...empty('b:child'),
        onCycleEnd: hook,
        states: [
          {
            key: 'counter',
            label: 'Counter',
            type: 'number',
            schema: { type: 'number' },
            owner: 'public',
            alwaysKnown: false,
            playerTruth: false,
            bar: false,
          },
        ],
        initializeState: input => ({
          public: { counter: 0 },
          characters: Object.fromEntries(input.characterIds.map(id => [id, {}])),
        }),
      },
      {},
      context,
    )
  })
  await fiber
  await f.gameplay.initialize()
  const before = f.events().filter(e => e.eventType === 'status.updated')
  const request = f.engine.beginRequest()
  const completing = request.runCycle(async () => {})
  try {
    await waiting
    await fiber.dispose()
    release()
    expect((await completing).status).toBe('completed')
    expect(hook).not.toHaveBeenCalled()
    expect(f.events().filter(e => e.eventType === 'status.updated')).toEqual(before)
  } finally {
    release()
    await completing
    request.close()
  }
})

it('applies interaction and explicit lifecycle restrictions while retaining forced escape', async () => {
  const f = await fixture()
  let blocked = true
  let forbidInvariant = false
  const rejection = { code: 'LOCKED', message: '不能互动。', details: { why: 'locked' } }
  f.gameplay.register(
    {
      ...investigationGameplay,
      validateState() {
        if (forbidInvariant) throw new Error('NO_TRANSITION')
      },
    },
    config,
  )
  const check = vi.fn(() => (blocked ? rejection : undefined))
  f.gameplay.register(
    { ...empty('rule:lock'), restrictions: [{ id: 'rule:deny', operations: ['interact', 'activity:resume'], check }] },
    {},
  )
  await f.gameplay.initialize()
  const before = await f.app.head(f.address)
  expect(await f.gameplay.startActivity('principal:player', 'investigation-site', [npc])).toMatchObject({
    status: 'rejected',
    rejection,
  })
  expect(check).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'activity:start' }))
  expect(await f.app.head(f.address)).toEqual(before)
  blocked = false
  await f.gameplay.startActivity('principal:player', 'investigation-site', [npc])
  await f.gameplay.controlActivity('principal:player', 'investigation-site', 'suspend')
  blocked = true
  expect(await f.gameplay.controlActivity('principal:player', 'investigation-site', 'resume')).toMatchObject({
    status: 'rejected',
    rejection,
  })
  forbidInvariant = true
  check.mockClear()
  expect(await f.gameplay.controlActivity('principal:player', 'investigation-site', 'escape')).toEqual({
    status: 'accepted',
  })
  expect(check).not.toHaveBeenCalled()
})

it('attributes non-JSON handler effects to their owner and leaves facts unchanged', async () => {
  const f = await fixture()
  f.gameplay.register(
    {
      ...investigationGameplay,
      operations: [
        {
          ...searchOperation,
          resolve: (): OperationResolution<SearchOutcome> => ({
            status: 'accepted' as const,
            outcome: { found: false, clueId: null, remainingEnergy: 3 },
            effects: [undefined as never],
          }),
        },
      ],
    },
    config,
  )
  await f.gameplay.initialize()
  const before = await f.app.head(f.address)
  await expect(f.gameplay.executePlayer('principal:player', searchOperation.id, searchArgs)).rejects.toMatchObject({
    origin: 'plugin',
    pluginId: investigationGameplay.id,
  })
  expect(await f.app.head(f.address)).toEqual(before)
})

it('preserves structured business refusal in native and durable player results including replay', async () => {
  const f = await fixture()
  const rejection = { code: 'STABLE_DENIAL', message: '业务拒绝。', details: { why: 'locked' } }
  f.gameplay.register(
    {
      ...investigationGameplay,
      operations: [
        { ...searchOperation, resolve: (): OperationResolution<SearchOutcome> => ({ status: 'rejected', rejection }) },
      ],
    },
    config,
  )
  await f.gameplay.initialize()
  expect(await f.gameplay.executePlayer('principal:player', searchOperation.id, searchArgs)).toEqual({
    status: 'rejected',
    reason: 'plugin:业务拒绝。',
    rejection,
  })
  const request = {
    principalId: 'principal:player',
    idempotencyKey: 'native-refusal',
    correlationId: 'native-refusal',
    action: {
      actionType: 'interact',
      parameters: {
        definitionRef: { id: searchOperation.id, version: 1 },
        bindingId: 'gameplay',
        targetRef: { kind: 'location', id: 'location:archive' },
        arguments: searchArgs,
      },
    },
  }
  const result = await f.app.submit(f.address, request)
  expect(result).toMatchObject({ status: 'rejected', rejection })
  expect(await f.app.submit(f.address, request)).toEqual(result)
  expect(await f.app.roundResult(f.address, request.idempotencyKey)).toEqual(result)
  expect(
    f
      .events()
      .filter(
        e => e.eventType === 'observation.upsert' && statusObject(statusObject(e.data).value).observerId !== player,
      )
      .some(e => JSON.stringify(e.data).includes('业务拒绝')),
  ).toBe(false)
})

it('projects activity results to remote participants and current scene witnesses separately', async () => {
  const f = await fixture()
  const original = investigationGameplay.activities![0]!
  const { npc: _npc, ...search } = searchOperation
  const projection = vi.fn(() => ({ kind: 'search' as const, clueId: null }))
  f.gameplay.register(
    {
      ...investigationGameplay,
      activities: [{ ...original, projectResult: projection, formatResult: () => 'PUBLIC_ACTIVITY_OUTCOME' }],
      operations: [{ ...search, activity: { key: original.key, operationId: 'search' } }],
    },
    config,
  )
  await f.gameplay.initialize()
  await f.gameplay.startActivity('principal:player', original.key, [npc])
  await f.app.submit(f.address, {
    principalId: 'principal:player',
    idempotencyKey: 'move-apart',
    correlationId: 'move-apart',
    action: { actionType: 'move', parameters: { locationId: 'location:next' } },
  })
  const before = f.events().at(-1)!.seq
  projection.mockClear()
  expect(
    (await f.gameplay.executePlayer('principal:player', searchOperation.id, { locationId: 'location:next', effort: 1 }))
      .status,
  ).toBe('accepted')
  expect(projection).toHaveBeenCalledWith(expect.objectContaining({ recipientId: npc }))
  const delivered = f
    .events()
    .filter(e => e.seq > before && e.eventType === 'observation.upsert')
    .map(e => statusObject(statusObject(e.data).value))
  expect(
    delivered.some(value => value.observerId === npc && JSON.stringify(value).includes('PUBLIC_ACTIVITY_OUTCOME')),
  ).toBe(true)
  // Physical co-location alone does not authorize a non-participant outside the active Scene.
  expect(delivered.some(value => value.observerId === 'character:bob')).toBe(false)
  expect(projection.mock.calls.length).toBe(2)
})

function archiveWorld(observerBinding = false): CompiledWorldSpec {
  const world = JSON.parse(
    JSON.stringify(frozenInteractionWorld()).replaceAll('location:room', 'location:archive'),
  ) as CompiledWorldSpec
  // One actor and the player share the archive; Bob is outside and cannot witness a search.
  const manifest = {
    ...world.manifest,
    playerBindings: observerBinding
      ? [
          ...world.manifest.playerBindings,
          { ...world.manifest.playerBindings[0]!, principalId: 'principal:observer', characterId: npc },
        ]
      : world.manifest.playerBindings,
    characters: world.manifest.characters.map(character =>
      character.characterId === 'character:bob' ? { ...character, locationId: 'location:next' } : character,
    ),
  }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = world.genesisEvents.map(event => {
    const data = statusObject(event.data)
    if (event.eventType === 'world.manifest-locked')
      return { ...event, data: { ...data, manifestHash } as WorldJsonObject }
    if (event.eventType === 'character.created' && data.characterId === 'character:bob')
      return { ...event, data: { ...data, locationId: 'location:next' } as WorldJsonObject }
    if (event.eventType === 'scene.upsert')
      return {
        ...event,
        data: { ...data, value: { ...statusObject(data.value), participantIds: [player, npc] } } as WorldJsonObject,
      }
    return event
  })
  return {
    ...world,
    manifest,
    manifestHash,
    genesisEvents,
    genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
  }
}
async function fixture(observerBinding = false) {
  const root = mkdtempSync(join(tmpdir(), 'native-gameplay-'))
  const path = join(root, 'world.sqlite')
  const app = new WorldApplication({
    worldPath: path,
    sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'),
    interactionPackages: [basicInteractionPackage],
  })
  cleanup.push(async () => {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  })
  const world = archiveWorld(observerBinding)
  app.activate(world)
  const address = world.manifest.address,
    scope = await app.createInstanceScope()
  const engine = await app.createExecutionEngine({ scope, address })
  const gameplay = await app.createGameplayRuntime({
    scope,
    address,
    engine,
    availableServices: ['status', 'activities'],
  })
  const events = () => {
    const store = new WorldStore(path)
    try {
      return store.readEvents(address)
    } finally {
      store.close()
    }
  }
  return { app, scope, engine, gameplay, address, events, manifest: world.manifest, manifestHash: world.manifestHash }
}

it('runs the native search through the public engine and gives only the actor its private clue', async () => {
  const f = await fixture()
  f.gameplay.register(investigationGameplay, config)
  await f.gameplay.initialize()
  const request = f.engine.beginRequest()
  let requestText = '',
    continuation = ''
  try {
    const cycle = await f.app.withExecutionResources({ scope: f.scope, address: f.address }, async resources => {
      const turn = resources.createTurn({
        rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }),
        loop: {
          async run(activation) {
            activation.prepare({ canPerform: true, continuation: false })
            await activation.submit(await activation.decide())
            const next = activation.prepare({ canPerform: false, continuation: true })
            continuation = JSON.stringify(next)
            await activation.submit({ decision: 'abstain' })
            return 'abstained'
          },
        },
        decide: async input => {
          requestText = JSON.stringify(characterActionExplanations(input.context))
          const choices = (input.context.affordances as readonly WorldJsonValue[])
            .flatMap(entry => {
              const interactions = statusObject(entry).interactions
              return Array.isArray(interactions) ? interactions : []
            })
            .map(value => statusObject(value))
          const choice = choices.find(option => statusObject(option.definitionRef).id === 'investigation:search')!
          return {
            decision: 'perform',
            actionType: 'interact',
            parameters: {
              targetRef: choice.targetRef,
              bindingId: choice.bindingId,
              definitionRef: choice.definitionRef,
              arguments: choice.arguments,
            },
          }
        },
      })
      const round = createSchedulerRound({
        store: resources.store,
        address: f.address,
        turn,
        afterSeq: resources.store.head(f.address).headSeq,
        characterIds: [npc],
        signal: request.signal,
        limits: { maximumWaves: 2, maximumNpcCalls: 3, maximumCallsPerCharacter: 2 },
        allowConcurrent: true,
        world: {
          readEvents: () => [],
          characterObservations: () => [],
          head: () => resources.store.head(f.address),
          eventTicks: () => [],
          authorizedSources: () => [],
        },
      })
      return request.runScheduledCycle({
        rounds: [round],
        pluginId: 'test-scheduler',
        scheduler: {
          async run(capabilities) {
            const result = await capabilities.turn(npc, { signal: capabilities.signal, stimulusSeqs: [], maxCalls: 2 })
            return {
              calls: result.calls,
              wave: 1,
              terminalReason: 'quiescent',
              activations: [{ characterId: npc, result }],
            }
          },
        },
      })
    })
    expect(cycle.status).toBe('completed')
    expect(cycle.activations[0]).toMatchObject({ controlledCommitted: true, lastDecision: { decision: 'abstain' } })
    expect(requestText).toContain('需要消耗精力检查当前地点时使用')
    expect(requestText).toContain('argumentSchema')
    expect(continuation).toContain('clue:archive-letter')
    const observations = f
      .events()
      .filter(event => event.eventType === 'observation.upsert')
      .map(event => statusObject(statusObject(event.data).value))
    const own = observations.filter(value => value.observerId === npc),
      witness = observations.filter(value => value.observerId === player)
    expect(JSON.stringify(own)).toContain('clue:archive-letter')
    expect(JSON.stringify(witness)).toContain('目击了一次搜查')
    expect(JSON.stringify(witness)).not.toContain('clue:archive-letter')
    expect(observations.filter(value => value.observerId === 'character:bob')).toEqual([])
    expect(JSON.stringify(await f.gameplay.playerView('principal:player'))).not.toContain('clue:archive-letter')
  } finally {
    request.close()
  }
})

it('diagnoses duplicate handlers and state ownership during assembly without replacing the original registration', async () => {
  const f = await fixture()
  f.gameplay.register(investigationGameplay, config)
  expect(() => f.gameplay.register({ ...investigationGameplay, id: 'other:investigation' }, config)).toThrow(
    'GAMEPLAY_DUPLICATE_STATE',
  )
  expect(() =>
    f.gameplay.register({ ...investigationGameplay, id: 'other:operation', states: [], activities: [] }, config),
  ).toThrow('GAMEPLAY_DUPLICATE_OPERATION')
  await f.gameplay.initialize()
  expect(
    (
      await f.gameplay.executePlayer('principal:player', 'investigation:search', {
        locationId: 'location:archive',
        effort: 1,
      })
    ).status,
  ).toBe('accepted')
})

it('conjoins all applicable restrictions and rechecks them at execution against current state', async () => {
  const f = await fixture()
  const first = vi.fn(() => undefined),
    second = vi.fn(() => ({ code: 'NO_SEARCH', message: '现在不能搜查。' }))
  f.gameplay.register(investigationGameplay, config)
  f.gameplay.register(
    { ...empty('rule:first'), restrictions: [{ id: 'rule:a', operations: ['investigation:search'], check: first }] },
    {},
  )
  f.gameplay.register(
    { ...empty('rule:second'), restrictions: [{ id: 'rule:b', operations: ['investigation:search'], check: second }] },
    {},
  )
  await f.gameplay.initialize()
  const before = await f.app.head(f.address)
  expect(
    await f.gameplay.executePlayer('principal:player', 'investigation:search', {
      locationId: 'location:archive',
      effort: 1,
    }),
  ).toEqual({
    status: 'rejected',
    reason: 'plugin:现在不能搜查。',
    rejection: { code: 'NO_SEARCH', message: '现在不能搜查。' },
  })
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()
  expect(await f.app.head(f.address)).toEqual(before)
})

it('keeps cycle hook input within its owner and revokes registered execution when its instance closes', async () => {
  const f = await fixture()
  const hook = vi.fn(() => [])
  f.gameplay.register(investigationGameplay, config)
  f.gameplay.register({ ...empty('cycle:observer'), onCycleEnd: hook }, {})
  await f.gameplay.initialize()
  const request = f.engine.beginRequest()
  expect((await request.runCycle(async () => {})).status).toBe('completed')
  expect(hook).toHaveBeenCalledOnce()
  expect(JSON.stringify(hook.mock.calls)).not.toContain('energy')
  request.close()
  await f.scope.close()
  await expect(
    f.gameplay.executePlayer('principal:player', 'investigation:search', { locationId: 'location:archive', effort: 1 }),
  ).rejects.toThrow('closed')
})

type Health = { health: number; down: boolean }
function healthModules(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: 'normal' | 'conflict' | 'merge' | 'throw' | 'invariant',
) {
  const status = (key: string, type: 'number' | 'boolean'): StatusDefinition => ({
    key,
    label: key,
    type,
    schema: { type, ...(type === 'number' ? { minimum: 0 } : {}) },
    owner: 'character',
    alwaysKnown: false,
    playerTruth: false,
    bar: false,
  })
  const damage = defineOperation<Health>()<{ amount: number }, { remaining: number }>({
    id: 'health:damage',
    argumentSchema: {
      type: 'object',
      properties: { amount: { type: 'integer', minimum: 0 } },
      required: ['amount'],
      additionalProperties: false,
    },
    resultSchema: {
      type: 'object',
      properties: { remaining: { type: 'integer', minimum: 0 } },
      required: ['remaining'],
      additionalProperties: false,
    },
    resolve: input => {
      const health = Math.max(0, input.state.health - input.parameters.amount)
      return {
        status: 'accepted',
        outcome: { remaining: health },
        effects: [
          {
            kind: 'status',
            changes: [
              { holderId: input.actorId, key: 'health', value: health },
              ...(mode === 'invariant' && input.parameters.amount === 2
                ? []
                : [{ holderId: input.actorId, key: 'down', value: health === 0 }]),
            ],
            reveals: [],
          },
        ],
      }
    },
  })
  const owner = defineGameplay<Health, Empty, null>()({
    id: 'health:owner',
    version: '1.0.0',
    dataVersion: 1,
    requiredServices: ['status'],
    configSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    states: [status('health', 'number'), status('down', 'boolean')],
    operations: [],
    methods: [damage],
    initializeState: input => ({
      public: {},
      characters: Object.fromEntries(input.characterIds.map(id => [id, { health: 5, down: false }])),
    }),
    validateState: state => {
      for (const values of Object.values(state.characters))
        if ((values.health === 0) !== values.down) throw new Error('private health/down invariant')
    },
    ...(mode === 'merge'
      ? {
          combineChanges: (input: {
            readonly state: import('@perspectra/sdk/contracts').StatusTruth
            readonly changes: readonly import('@perspectra/sdk/contracts').StatusChange[]
          }) => {
            const holders = [...new Set(input.changes.map(change => change.holderId))]
            return holders.flatMap(holderId => {
              const before = Number(input.state.characters[holderId!]!.health)
              const contributions = input.changes.filter(
                change => change.holderId === holderId && change.key === 'health',
              )
              const health = Math.max(
                0,
                before - contributions.reduce((total, change) => total + before - Number(change.value), 0),
              )
              return [
                { holderId, key: 'health', value: health },
                { holderId, key: 'down', value: health === 0 },
              ]
            })
          },
        }
      : {}),
  })
  f.gameplay.register(owner, {})
  let saved: GameplayComputation | undefined
  const attack = defineOperation<Empty>()<{ base: number; modifier: number }, { remaining: number }>({
    id: 'combat:attack',
    argumentSchema: {
      type: 'object',
      properties: { base: { type: 'integer', minimum: 0 }, modifier: { type: 'integer', minimum: 0 } },
      required: ['base', 'modifier'],
      additionalProperties: false,
    },
    resultSchema: {
      type: 'object',
      properties: { remaining: { type: 'integer', minimum: 0 } },
      required: ['remaining'],
      additionalProperties: false,
    },
    resolve: input => {
      saved = input.compute
      return input.compute(damage, { amount: input.parameters.base + input.parameters.modifier })
    },
  })
  f.gameplay.register({ ...empty('combat:actions'), operations: [attack] }, {})
  const remaining: number[] = []
  if (mode !== 'normal')
    for (const id of mode === 'conflict' || mode === 'merge' ? ['bonus:a', 'bonus:b'] : ['bonus:a']) {
      f.gameplay.register(
        {
          ...empty(id),
          afterAction: input => {
            if (input.operationId !== 'combat:attack') return []
            if (mode === 'throw') throw new Error('PRIVATE_DERIVATION_CONTEXT')
            const result = input.compute(damage, { amount: mode === 'invariant' ? 2 : 1 })
            if (result.status === 'rejected') throw new Error('unexpected damage rejection')
            remaining.push(result.outcome.remaining)
            return result.effects
          },
        },
        {},
      )
    }
  return { remaining, damage, invokeLate: () => saved!(damage, { amount: 1 }) }
}

it('uses an owner method for cross-module calculation and resolves final damage/down together', async () => {
  const f = await fixture(),
    methods = healthModules(f, 'normal')
  await f.gameplay.initialize()
  expect((await f.gameplay.executePlayer('principal:player', 'combat:attack', { base: 3, modifier: 2 })).status).toBe(
    'accepted',
  )
  const changes = f
    .events()
    .filter(event => event.eventType === 'status.updated')
    .flatMap(event => statusObject(event.data).changes as WorldJsonObject[])
  expect(changes.slice(-2)).toEqual([
    { holderId: player, key: 'health', value: 0 },
    { holderId: player, key: 'down', value: true },
  ])
  expect(methods.invokeLate).toThrow('ended')
})

it.each(['conflict', 'throw', 'invariant'] as const)(
  'abandons the complete main and derived result on %s',
  async mode => {
    const f = await fixture(),
      methods = healthModules(f, mode)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await f.gameplay.initialize()
    const before = await f.app.head(f.address)
    await expect(
      f.gameplay.executePlayer('principal:player', 'combat:attack', { base: 3, modifier: 0 }),
    ).rejects.toMatchObject({ origin: 'plugin' })
    expect(await f.app.head(f.address)).toEqual(before)
    if (mode === 'conflict') expect(methods.remaining).toEqual([1, 1])
  },
)

it('lets the state owner combine competing derived damage and normalize the final down state', async () => {
  const f = await fixture(),
    methods = healthModules(f, 'merge')
  await f.gameplay.initialize()
  await f.gameplay.executePlayer('principal:player', 'combat:attack', { base: 3, modifier: 0 })
  expect(methods.remaining).toEqual([1, 1])
  const changes = f
    .events()
    .filter(event => event.eventType === 'status.updated')
    .flatMap(event => statusObject(event.data).changes as WorldJsonObject[])
  expect(changes.slice(-2)).toEqual([
    { holderId: player, key: 'health', value: 0 },
    { holderId: player, key: 'down', value: true },
  ])
})

it('runs native activity lifecycle and projects each participant private material separately', async () => {
  const f = await fixture()
  const original = investigationGameplay.activities![0]!
  const formatActivity = vi.fn(original.formatResult)
  const derive = vi.fn((_input: GameplayAfterActionInput<InvestigationState, WorldJsonValue>) => [])
  const cycleHook = vi.fn((_input: GameplayCycleEndInput<InvestigationState>) => [])
  const outsideHook = vi.fn((_input: GameplayCycleEndInput<Empty>) => [])
  const { npc: _operationDescription, ...activitySearch } = searchOperation
  const definition = {
    ...investigationGameplay,
    afterAction: derive,
    onCycleEnd: cycleHook,
    activities: [
      {
        ...original,
        formatResult: formatActivity,
        initialize: (input: Parameters<typeof original.initialize>[0]) => {
          const state = original.initialize(input)
          return {
            ...state,
            game: {
              ...state.game,
              private: Object.fromEntries(
                [input.playerId, ...input.participantIds].map(id => [
                  id,
                  { note: id === player ? 'PLAYER_NOTE' : 'NPC_NOTE' },
                ]),
              ),
              internal: { answer: 'INTERNAL_ANSWER' },
            },
          }
        },
      },
    ],
    operations: [
      {
        ...activitySearch,
        activity: { key: original.key, operationId: 'search' },
        resolve: (input: Parameters<typeof activitySearch.resolve>[0]) => {
          const result = activitySearch.resolve(input)
          if (result.status === 'rejected') return result
          const state = input.activity!
          const effect: GameplayEffect = {
            kind: 'activity',
            activityKey: original.key,
            description: '搜查阶段已完成。',
            state: {
              ...state,
              revision: state.revision + 1,
              game: { ...state.game, phase: 'after-search', turn: npc },
            },
          }
          return { ...result, effects: [...result.effects, effect] }
        },
      },
      inspectOperation,
    ] as const,
  }
  f.gameplay.register(definition, config)
  f.gameplay.register({ ...empty('outside:observer'), onCycleEnd: outsideHook }, {})
  await f.gameplay.initialize()
  expect(
    (
      await f.gameplay.executePlayer('principal:player', 'investigation:search', {
        locationId: 'location:archive',
        effort: 1,
      })
    ).status,
  ).toBe('rejected')
  await f.gameplay.startActivity('principal:player', original.key, [npc])
  const cycleRequest = f.engine.beginRequest()
  try {
    await cycleRequest.runCycle(async () => {})
  } finally {
    cycleRequest.close()
  }
  expect(cycleHook.mock.calls[0]![0].activities[original.key]?.game.internal).toEqual({ answer: 'INTERNAL_ANSWER' })
  expect(outsideHook.mock.calls[0]![0].activities).toEqual({})
  const playerContext = JSON.stringify(f.gameplay.projectContext(f.events(), player, {}))
  const npcContext = JSON.stringify(f.gameplay.projectContext(f.events(), npc, {}))
  const outside = JSON.stringify(f.gameplay.projectContext(f.events(), brandId('character:bob', 'CharacterId'), {}))
  expect(playerContext).toContain('PLAYER_NOTE')
  expect(playerContext).not.toContain('NPC_NOTE')
  expect(npcContext).toContain('NPC_NOTE')
  expect(npcContext).not.toContain('PLAYER_NOTE')
  for (const value of [playerContext, npcContext, outside]) expect(value).not.toContain('INTERNAL_ANSWER')
  expect(outside).not.toContain('NPC_NOTE')
  expect(outside).not.toContain('PLAYER_NOTE')
  const rules = f.gameplay.resolver(
    createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }).resolve(
      f.manifest.rulebook.rulebookId,
      f.manifest.rulebook.version,
      'activity-test',
    ),
  )
  const offered = rules
    .affordances({
      manifest: f.manifest,
      manifestHash: f.manifestHash,
      resolutionAuthority: resolutionAuthority('player', 'standard'),
      asOfWorldSeq: f.events().at(-1)!.seq,
      events: f.events(),
      characterId: player,
    })
    .flatMap(offer => offer.interactions ?? [])
    .find(option => statusObject(option.definitionRef).id === 'investigation:search')!
  await f.gameplay.controlActivity('principal:player', original.key, 'suspend')
  expect(
    (
      await f.gameplay.executePlayer('principal:player', 'investigation:search', {
        locationId: 'location:archive',
        effort: 1,
      })
    ).status,
  ).toBe('rejected')
  await f.gameplay.controlActivity('principal:player', original.key, 'resume')
  const beforeStale = await f.app.head(f.address)
  expect(
    rules.resolve({
      manifest: f.manifest,
      events: f.events(),
      characterId: player,
      action: {
        actionType: 'interact',
        parameters: {
          targetRef: offered.targetRef!,
          bindingId: offered.bindingId!,
          definitionRef: offered.definitionRef!,
          arguments: offered.arguments!,
        },
      },
    }),
  ).toMatchObject({
    status: 'rejected',
    events: [],
    rejection: { code: 'GAMEPLAY_OPERATION_BINDING_INVALID' },
  })
  expect(await f.app.head(f.address)).toEqual(beforeStale)
  expect(
    (
      await f.gameplay.executePlayer('principal:player', 'investigation:search', {
        locationId: 'location:archive',
        effort: 1,
      })
    ).status,
  ).toBe('accepted')
  await f.gameplay.controlActivity('principal:player', original.key, 'escape')
  expect(formatActivity).toHaveBeenCalledOnce()
  expect(formatActivity.mock.calls[0]![0]).toMatchObject({
    actorId: player,
    recipientId: player,
    outcome: { kind: 'search', clueId: 'clue:archive-letter' },
  })
  expect(derive.mock.calls.map(([input]) => input.operationId)).toEqual([
    'activity:start',
    'activity:suspend',
    'activity:resume',
    'investigation:search',
  ])
  expect(derive.mock.calls[0]![0].beforeActivities[original.key]).toBeUndefined()
  expect(derive.mock.calls[0]![0].candidateActivities[original.key]?.revision).toBe(1)
  expect(derive.mock.calls[3]![0].beforeActivities[original.key]?.revision).toBe(3)
  expect(derive.mock.calls[3]![0].candidateActivities[original.key]?.revision).toBe(4)
})

it.each(['status', 'event'] as const)(
  'rejects a foreign module write through %s without partial commit',
  async kind => {
    const f = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    f.gameplay.register(investigationGameplay, config)
    const effects: GameplayEffect[] =
      kind === 'status'
        ? [{ kind: 'status', changes: [{ holderId: player, key: 'energy', value: 99 }], reveals: [] }]
        : [
            {
              kind: 'event',
              event: {
                eventType: 'status.updated',
                eventVersion: 1,
                data: {
                  changes: [{ holderId: player, key: 'energy', value: 99 }],
                  reveals: [],
                  source: { kind: 'initial' },
                },
              },
            },
          ]
    f.gameplay.register({ ...empty('illegal:writer'), afterAction: () => effects }, {})
    await f.gameplay.initialize()
    const before = await f.app.head(f.address)
    await expect(
      f.gameplay.executePlayer('principal:player', 'investigation:search', {
        locationId: 'location:archive',
        effort: 1,
      }),
    ).rejects.toMatchObject({ origin: 'plugin', pluginId: 'illegal:writer' })
    expect(await f.app.head(f.address)).toEqual(before)
  },
)

it('isolates two world scopes and refuses a foreign registration context', async () => {
  const a = await fixture(),
    b = await fixture()
  a.gameplay.register(investigationGameplay, config)
  b.gameplay.register(investigationGameplay, { ...config, maxEnergy: 7 })
  expect(() => a.gameplay.register(empty('foreign:context'), {}, b.scope.context)).toThrow('another world')
  await a.gameplay.initialize()
  await b.gameplay.initialize()
  const before = await b.app.head(b.address)
  await a.gameplay.executePlayer('principal:player', 'investigation:search', {
    locationId: 'location:archive',
    effort: 1,
  })
  expect(await b.app.head(b.address)).toEqual(before)
  await a.scope.close()
  expect(
    (
      await b.gameplay.executePlayer('principal:player', 'investigation:search', {
        locationId: 'location:archive',
        effort: 1,
      })
    ).status,
  ).toBe('accepted')
  const after = await b.app.head(b.address)
  await b.gameplay.initialize()
  expect(await b.app.head(b.address)).toEqual(after)
})

it('keeps committed results when an optional result formatter fails', async () => {
  const f = await fixture()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  f.gameplay.register(
    {
      ...investigationGameplay,
      operations: [
        {
          ...searchOperation,
          npc: {
            whenToUse: '搜查',
            formatResult: () => {
              throw new Error('PRIVATE_FORMAT_CONTEXT')
            },
          },
        },
        inspectOperation,
      ] as const,
    },
    config,
  )
  await f.gameplay.initialize()
  expect(
    (
      await f.gameplay.executePlayer('principal:player', 'investigation:search', {
        locationId: 'location:archive',
        effort: 1,
      })
    ).status,
  ).toBe('accepted')
  expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_FORMAT_CONTEXT')
  expect(f.events().some(event => event.eventType === 'action.resolved')).toBe(true)
})

it('applies registered restrictions to the existing application player entrance', async () => {
  const f = await fixture()
  f.gameplay.register(
    {
      ...empty('rule:stay'),
      restrictions: [
        { id: 'rule:stay-in-room', operations: ['move'], check: () => ({ code: 'STAY', message: '当前不能离开。' }) },
      ],
    },
    {},
  )
  await f.gameplay.initialize()
  const result = await f.app.submit(f.address, {
    principalId: 'principal:player',
    idempotencyKey: 'restricted-move',
    correlationId: 'restricted-move',
    action: { actionType: 'move', parameters: { locationId: 'location:next' } },
  })
  expect(result.status).toBe('rejected')
  expect(f.events().some(event => event.eventType === 'character.moved')).toBe(false)
})

it('runs one afterAction layer for ordinary core actions through the existing player entrance', async () => {
  const f = await fixture(),
    { damage } = healthModules(f, 'normal')
  const hook = vi.fn((input: { readonly operationId: string; readonly compute: GameplayComputation }) => {
    if (input.operationId !== 'move') return []
    const result = input.compute(damage, { amount: 1 })
    return result.status === 'accepted' ? result.effects : []
  })
  f.gameplay.register({ ...empty('move:cost'), afterAction: hook }, {})
  await f.gameplay.initialize()
  const result = await f.app.submit(f.address, {
    principalId: 'principal:player',
    idempotencyKey: 'costly-move',
    correlationId: 'costly-move',
    action: { actionType: 'move', parameters: { locationId: 'location:next' } },
  })
  expect(result.status).toBe('accepted')
  expect(hook).toHaveBeenCalledOnce()
  const changes = f
    .events()
    .filter(event => event.eventType === 'status.updated')
    .flatMap(event => statusObject(event.data).changes as WorldJsonObject[])
  expect(changes.slice(-2)).toEqual([
    { holderId: player, key: 'health', value: 4 },
    { holderId: player, key: 'down', value: false },
  ])
})

it('commits owned cycle effects without counting them as player rounds', async () => {
  const f = await fixture()
  const hook = vi.fn(
    (input: {
      readonly state: Readonly<import('@perspectra/sdk/contracts').StatusTruth>
    }): readonly GameplayEffect[] => [
      {
        kind: 'status',
        changes: [{ holderId: null, key: 'clock', value: Number(input.state.public.clock) + 1 }],
        reveals: [],
      },
    ],
  )
  f.gameplay.register(
    defineGameplay<{ clock: number }, Empty, null>()({
      id: 'world:clock',
      version: '1.0.0',
      dataVersion: 1,
      requiredServices: ['status'],
      operations: [],
      configSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      states: [
        {
          key: 'clock',
          label: '时钟',
          type: 'number',
          schema: { type: 'number', minimum: 0 },
          owner: 'public',
          alwaysKnown: true,
          playerTruth: true,
          bar: false,
        },
      ],
      initializeState: input => ({
        public: { clock: 0 },
        characters: Object.fromEntries(input.characterIds.map(id => [id, {}])),
      }),
      onCycleEnd: hook,
    }),
    {},
  )
  await f.gameplay.initialize()
  const before = playerRoundNumber(f.events(), Number.MAX_SAFE_INTEGER, false)
  const request = f.engine.beginRequest()
  try {
    expect((await request.runCycle(async () => {})).status).toBe('completed')
  } finally {
    request.close()
  }
  expect(hook).toHaveBeenCalledOnce()
  expect(playerRoundNumber(f.events(), Number.MAX_SAFE_INTEGER, false)).toEqual(before)
  const last = f.events().findLast(event => event.eventType === 'status.updated')!
  expect(statusObject(last.data).source).toMatchObject({ kind: 'cycle' })
  expect(statusObject(last.data).changes).toEqual([{ holderId: null, key: 'clock', value: 1 }])
})

it('checks recovered status schemas instead of reinitializing incompatible committed values', async () => {
  const f = await fixture()
  f.gameplay.register(investigationGameplay, config)
  await f.gameplay.initialize()
  const before = await f.app.head(f.address)
  await f.scope.close()
  const scope = await f.app.createInstanceScope(),
    engine = await f.app.createExecutionEngine({ scope, address: f.address })
  const next = await f.app.createGameplayRuntime({
    scope,
    engine,
    address: f.address,
    availableServices: ['status', 'activities'],
  })
  next.register(
    {
      ...investigationGameplay,
      states: investigationGameplay.states!.map(state =>
        state.key === 'energy' ? { ...state, schema: { type: 'number', minimum: 100 } } : state,
      ),
    },
    config,
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(next.initialize()).rejects.toMatchObject({ origin: 'plugin', pluginId: investigationGameplay.id })
  expect(await f.app.head(f.address)).toEqual(before)
})

it('formats separately projected outcomes for the actor and a witness', async () => {
  const f = await fixture()
  const format = vi.fn(
    (input: { readonly actorId: string; readonly recipientId: string; readonly outcome: SearchOutcome }) =>
      input.actorId === input.recipientId ? '线索：' + input.outcome.clueId : '看见行动者翻找档案。',
  )
  f.gameplay.register(
    {
      ...investigationGameplay,
      operations: [
        {
          ...searchOperation,
          npc: {
            whenToUse: '搜查当前房间',
            projectResult: (input: OperationResultProjection<SearchOutcome>): SearchOutcome =>
              input.actorId === input.recipientId ? input.outcome : { found: false, clueId: null, remainingEnergy: 0 },
            formatResult: format,
          },
        },
        inspectOperation,
      ] as const,
    },
    config,
  )
  await f.gameplay.initialize()
  await f.gameplay.executePlayer('principal:player', 'investigation:search', {
    locationId: 'location:archive',
    effort: 1,
  })
  expect(format.mock.calls.find(([input]) => input.recipientId === player)?.[0].outcome.clueId).toBe(
    'clue:archive-letter',
  )
  expect(format.mock.calls.find(([input]) => input.recipientId === npc)?.[0].outcome.clueId).toBeNull()
  expect(format.mock.calls.some(([input]) => input.recipientId === 'character:bob')).toBe(false)
})

it('cleans registrations with the owning child Cordis context', async () => {
  const f = await fixture()
  f.gameplay.register(investigationGameplay, config)
  const fiber = f.scope.context.plugin(context => {
    f.gameplay.register(
      {
        ...empty('child:rule'),
        restrictions: [
          {
            id: 'child:no-search',
            operations: ['investigation:search'],
            check: () => ({ code: 'CHILD_RULE', message: '等待。' }),
          },
        ],
      },
      {},
      context,
    )
  })
  await fiber
  await f.gameplay.initialize()
  const parameters = { locationId: 'location:archive', effort: 1 }
  expect((await f.gameplay.executePlayer('principal:player', 'investigation:search', parameters)).status).toBe(
    'rejected',
  )
  await fiber.dispose()
  expect((await f.gameplay.executePlayer('principal:player', 'investigation:search', parameters)).status).toBe(
    'accepted',
  )
})

it('rejects a public method bound to another module activity before opening execution', async () => {
  const f = await fixture()
  f.gameplay.register(investigationGameplay, config)
  const method = defineOperation<Empty>()<Empty, null>({
    id: 'illegal:read-activity',
    argumentSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    resultSchema: { type: 'null', nullable: true },
    activity: { key: 'investigation-site', operationId: 'search' },
    resolve: () => ({ status: 'accepted', outcome: null, effects: [] }),
  })
  f.gameplay.register({ ...empty('illegal:module'), methods: [method] }, {})
  const before = await f.app.head(f.address)
  await expect(f.gameplay.initialize()).rejects.toThrow('GAMEPLAY_ACTIVITY_OPERATION_OWNER_MISMATCH')
  expect(await f.app.head(f.address)).toEqual(before)
})

it('refuses a native handler that shadows an installed manifest interaction', async () => {
  const f = await fixture()
  const operation = defineOperation<Empty>()<Empty, null>({
    id: 'base:take',
    argumentSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    resultSchema: { type: 'null', nullable: true },
    resolve: () => ({ status: 'accepted', outcome: null, effects: [] }),
  })
  expect(() => f.gameplay.register({ ...empty('illegal:shadow'), operations: [operation] }, {})).toThrow(
    'GAMEPLAY_DUPLICATE_OPERATION',
  )
  f.gameplay.register(empty('valid:module'), {})
  await f.gameplay.initialize()
})

it('records cycle stimuli as system results without attributing them to the player', async () => {
  const f = await fixture()
  f.gameplay.register(
    {
      ...empty('system:bell'),
      onCycleEnd: (): readonly GameplayEffect[] => [
        {
          kind: 'event',
          event: {
            eventType: 'observation.upsert',
            eventVersion: 1,
            data: {
              id: 'bell',
              value: { observerId: npc, content: { text: '钟响了。', actorId: 'character:player' } },
            },
          },
        },
      ],
    },
    {},
  )
  await f.gameplay.initialize()
  const request = f.engine.beginRequest()
  try {
    const cycle = await request.runCycle(async () => {})
    expect(cycle.status).toBe('completed')
    const event = f.events().findLast(value => value.eventType === 'observation.upsert')!
    const content = statusObject(statusObject(statusObject(event.data).value).content)
    expect(content).not.toHaveProperty('actorId')
    expect(content.source).toEqual({ kind: 'cycle', cycleId: cycle.cycleId })
  } finally {
    request.close()
  }
})

it.each([npc, brandId('character:bob', 'CharacterId')])(
  'checks the participant and turn before lending activity state to a public method (%s)',
  async actorId => {
    const f = await fixture()
    const resolve = vi.fn()
    const method = defineOperation<InvestigationState>()<Empty, null>({
      id: 'investigation:activity-method',
      argumentSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      resultSchema: { type: 'null', nullable: true },
      activity: { key: 'investigation-site', operationId: 'search' },
      resolve,
    })
    f.gameplay.register({ ...investigationGameplay, methods: [method] }, config)
    const use = defineOperation<Empty>()<Empty, null>({
      id: 'outer:use-method',
      argumentSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      resultSchema: { type: 'null', nullable: true },
      resolve: input => input.compute(method, {}),
    })
    f.gameplay.register({ ...empty('outer:module'), operations: [use] }, {})
    await f.gameplay.initialize()
    await f.gameplay.startActivity('principal:player', 'investigation-site', [npc])
    const result = f.gameplay.adjudicate(f.events(), actorId, 'outer:use-method', {})
    expect(result.status).toBe('rejected')
    expect(resolve).not.toHaveBeenCalled()
  },
)

it('preserves authored refusals and completes stale bindings cleanly without wedging round_inbox', async () => {
  const f = await fixture()
  f.gameplay.register(investigationGameplay, { ...config, maxEnergy: 1 })
  await f.gameplay.initialize()
  const submit = (key: string, parameters: WorldJsonObject) =>
    f.app.submit(f.address, {
      principalId: 'principal:player',
      idempotencyKey: key,
      correlationId: key,
      action: { actionType: 'interact', parameters },
    })
  const searchParams = {
    definitionRef: { id: searchOperation.id, version: 1 },
    bindingId: 'gameplay',
    targetRef: { kind: 'location', id: 'location:archive' },
    arguments: searchArgs,
  }
  expect((await submit('search-spend-energy', searchParams)).status).toBe('accepted')
  // The location remains an authorized target; resource rejection is decided by the Handler.
  const exhausted = await submit('search-exhausted', searchParams)
  expect(exhausted).toMatchObject({
    status: 'rejected',
    rejection: { code: 'INSUFFICIENT_ENERGY', message: '精力不足。' },
  })
  const staleBinding = await submit('search-stale-binding', {
    ...searchParams,
    bindingId: 'stale-revision',
  })
  expect(staleBinding).toMatchObject({
    status: 'rejected',
    rejection: { code: 'GAMEPLAY_OPERATION_BINDING_INVALID' },
  })
  const followUp = await submit('inspect-after-rejections', {
    definitionRef: { id: inspectOperation.id, version: 1 },
    bindingId: 'gameplay',
    targetRef: { kind: 'entity', id: 'clue:archive-letter' },
    arguments: { clueId: 'clue:archive-letter' },
  })
  expect(followUp.status).toBe('accepted')
})

it('registers and revokes gameplay wakeup sources with the owning Cordis fiber', async () => {
  const f = await fixture()
  const fiber = f.scope.context.plugin(child => {
    f.gameplay.register(
      {
        ...empty('wakeup:alarm'),
        wakeupSources: [
          {
            id: 'wakeup:bell',
            nominate: () => [{ characterId: npc, stimulusSeqs: [], opportunities: 2 }],
          },
        ],
      },
      {},
      child,
    )
  })
  await fiber
  await f.gameplay.initialize()
  expect(f.engine.wakeupSources().map(source => source.id)).toEqual(['wakeup:bell'])
  const round = createSchedulerRound({
    store: { head: () => ({ headSeq: 0 }), readEventsRange: () => [] } as unknown as WorldStore,
    address: f.address,
    turn: { run: vi.fn() },
    afterSeq: 0,
    characterIds: [npc],
    signal: new AbortController().signal,
    limits: { maximumWaves: 1, maximumNpcCalls: 2, maximumCallsPerCharacter: 1 },
    allowConcurrent: true,
    world: {} as never,
    wakeupSources: f.engine.wakeupSources(),
  })
  expect(round.wakeups!()).toEqual([
    { characterId: npc, stimulusSeqs: [], opportunities: 2, sourceIds: ['wakeup:bell'] },
  ])
  await fiber.dispose()
  expect(f.engine.wakeupSources()).toEqual([])
})

it('passes the authorized target from a formal request to its native Handler', async () => {
  const f = await fixture()
  const resolve = vi.fn()
  const operation = defineOperation<Empty>()<Empty, null>({
    id: 'target:inspect',
    argumentSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    resultSchema: { type: 'null', nullable: true },
    ui: { label: 'Inspect', targetKind: 'entity' },
    offer: () => [{ id: 'cup', label: 'Cup', targetId: 'entity:cup', parameters: {} }],
    resolve: input => {
      resolve(input)
      return { status: 'accepted', outcome: null, effects: [] }
    },
  })
  f.gameplay.register({ ...empty('target:test'), operations: [operation] }, {})
  await f.gameplay.initialize()
  const result = await f.app.submit(f.address, {
    principalId: 'principal:player',
    idempotencyKey: 'inspect-cup',
    correlationId: 'inspect-cup',
    action: {
      actionType: 'interact',
      parameters: {
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'gameplay',
        definitionRef: { id: operation.id, version: 1 },
        arguments: {},
      },
    },
  })
  expect(result.status).toBe('accepted')
  expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'entity:cup' }))
})

it('rolls back manual activity lifecycle effects when afterAction fails and permits forced escape', async () => {
  const f = await fixture()
  let fail = true
  f.gameplay.register(
    {
      ...investigationGameplay,
      afterAction: () => {
        if (fail) throw new Error('lifecycle failed')
        return []
      },
    },
    config,
  )
  await f.gameplay.initialize()
  const before = f.events()
  await expect(f.gameplay.startActivity('principal:player', 'investigation-site', [npc])).rejects.toMatchObject({
    origin: 'plugin',
    operation: 'afterAction',
  })
  expect(f.events()).toEqual(before)
  fail = false
  await f.gameplay.startActivity('principal:player', 'investigation-site', [npc])
  const started = f.events()
  fail = true
  await expect(f.gameplay.controlActivity('principal:player', 'investigation-site', 'suspend')).rejects.toMatchObject({
    origin: 'plugin',
    operation: 'afterAction',
  })
  expect(f.events()).toEqual(started)
  expect(await f.gameplay.controlActivity('principal:player', 'investigation-site', 'escape')).toMatchObject({
    status: 'accepted',
  })
})

it.each(['accepted', 'rejected'] as const)('checks target eligibility before a %s Handler runs', async status => {
  const f = await fixture()
  const handler = vi.fn(
    (): OperationResolution<null> =>
      status === 'accepted'
        ? { status: 'accepted', outcome: null, effects: [] }
        : { status: 'rejected', rejection: { code: 'HANDLER_REJECT', message: 'private target detail' } },
  )
  const operation = defineOperation<Empty>()<Empty, null>({
    id: 'target:guarded',
    argumentSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    resultSchema: { type: 'null', nullable: true },
    ui: { label: 'Inspect', targetKind: 'entity' },
    offer: () => [{ id: 'cup', label: 'Cup', targetId: 'entity:cup', parameters: {} }],
    resolve: handler,
  })
  f.gameplay.register({ ...empty('target:guard'), operations: [operation] }, {})
  await f.gameplay.initialize()
  const result = await f.app.submit(f.address, {
    principalId: 'principal:player',
    idempotencyKey: 'forged-target',
    correlationId: 'forged-target',
    action: {
      actionType: 'interact',
      parameters: {
        targetRef: { kind: 'entity', id: 'entity:forged-secret' },
        bindingId: 'gameplay',
        definitionRef: { id: operation.id, version: 1 },
        arguments: {},
      },
    },
  })
  expect(result).toMatchObject({ status: 'rejected', rejection: { code: 'GAMEPLAY_OPERATION_TARGET_UNAVAILABLE' } })
  expect(handler).not.toHaveBeenCalled()
  expect(JSON.stringify(result)).not.toContain('private target detail')
})
it.each(['native', 'script'] as const)('B7 common definition search parity through the core (%s)', async mode => {
  const path = new URL('../../../../examples/gameplay/investigation.cjs', import.meta.url)
  const script = mode === 'script' ? new GameplayScript(readFileSync(path, 'utf8')) : undefined
  const definition = script?.definition ?? (createRequire(import.meta.url)(fileURLToPath(path)) as ContentGameplay)
  if (script) cleanup.push(async () => script.close())
  const f = await fixture()
  f.gameplay.register(definition, { energy: 1 })
  await f.gameplay.initialize()
  const accepted = await f.gameplay.executePlayer('principal:player', 'investigation:search', {}, 'location:archive')
  expect(accepted.status).toBe('accepted')
  const changes = f
    .events()
    .filter(event => event.eventType === 'status.updated')
    .flatMap(event => (event.data as any).changes ?? [])
  expect(changes).toContainEqual({ holderId: player, key: 'energy', value: 0 })
  expect(changes).toContainEqual({ holderId: player, key: 'clues', value: ['clue:letter'] })
  const before = f.events()
  expect(
    await f.gameplay.executePlayer('principal:player', 'investigation:search', {}, 'location:archive'),
  ).toMatchObject({
    status: 'rejected',
    rejection: { code: 'INSUFFICIENT_ENERGY' },
  })
  expect(f.events()).toEqual(before)
  const observed = f
    .events()
    .filter(event => event.eventType === 'observation.upsert')
    .map(event => (event.data as any).value)
  expect(observed.some(row => row.observerId === npc && JSON.stringify(row).includes('翻找'))).toBe(true)
  expect(observed.filter(row => row.observerId === npc).some(row => JSON.stringify(row).includes('clue:letter'))).toBe(
    false,
  )
})

it('B8 validates complete execution params and the current offer fixed fields before calling the handler', async () => {
  const f = await fixture(),
    handler = vi.fn(() => ({ status: 'accepted' as const, outcome: null, effects: [] }))
  const operation = defineOperation<Empty>()<{ fixed: string; count: number }, null>({
    id: 'form:configure',
    argumentSchema: {
      type: 'object',
      properties: { fixed: { type: 'string' }, count: { type: 'integer', minimum: 1 } },
      required: ['fixed', 'count'],
      additionalProperties: false,
    },
    resultSchema: { type: 'null', nullable: true },
    offer: () => [{ id: 'config', label: 'Configure', parameters: { fixed: 'bound' } }],
    resolve: handler,
    ui: { label: 'Configure', targetKind: 'custom-display' },
  })
  f.gameplay.register(
    {
      ...empty('form:module'),
      operations: [operation],
      restrictions: [
        {
          id: 'form:positive',
          operations: [operation.id],
          check: ({ parameters }) =>
            parameters.count === 1 ? undefined : { code: 'NEEDS_ONE', message: 'Choose one.' },
        },
      ],
    },
    {},
  )
  await f.gameplay.initialize()
  const rules = f.gameplay.resolver(
    createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }).resolve(
      f.manifest.rulebook.rulebookId,
      f.manifest.rulebook.version,
      'forms',
    ),
  )
  const offers = rules.affordances({
    manifest: f.manifest,
    manifestHash: f.manifestHash,
    asOfWorldSeq: f.events().at(-1)!.seq,
    events: f.events(),
    characterId: player,
    resolutionAuthority: resolutionAuthority('player', 'standard'),
  })
  expect(JSON.stringify(offers)).toContain('form:configure')
  let seq = 0
  const submit = (args: WorldJsonObject) =>
    f.app.submit(f.address, {
      principalId: 'principal:player',
      idempotencyKey: 'b8:' + ++seq,
      correlationId: 'b8:' + seq,
      action: {
        actionType: 'interact',
        parameters: {
          definitionRef: { id: operation.id, version: 1 },
          bindingId: 'gameplay',
          targetRef: { kind: 'character', id: player },
          arguments: args,
        },
      },
    })
  expect((await submit({ fixed: 'bound' })).status).toBe('rejected')
  expect((await submit({ fixed: 'forged', count: 1 })).status).toBe('rejected')
  expect(handler).not.toHaveBeenCalled()
  expect((await submit({ fixed: 'bound', count: 1 })).status).toBe('accepted')
  expect(handler).toHaveBeenCalledOnce()
})

it('B8 isolates one invalid presentation and a control attempting another module operation', async () => {
  const f = await fixture()
  f.gameplay.register(investigationGameplay, config)
  f.gameplay.register(
    {
      ...empty('bad:view'),
      playerView: () => ({
        controls: [
          {
            id: 'foreign',
            kind: 'boolean',
            label: 'Foreign',
            value: true,
            operation: { id: searchOperation.id, argument: 'effort' },
          },
        ],
      }),
    },
    {},
  )
  await f.gameplay.initialize()
  const faults: unknown[] = []
  const view = await f.gameplay.playerView('principal:player', fault => faults.push(fault))
  expect(view.find(row => row.moduleId === investigationGameplay.id)?.view.panels).toHaveLength(2)
  expect(view.find(row => row.moduleId === 'bad:view')?.view).toEqual({})
  expect(faults).toHaveLength(1)
  expect(JSON.stringify(view)).not.toContain('clue:archive-letter')
})

it('activity stages reuse B8 ownership, participant scoping, fault isolation and module disposal', async () => {
  const f = await fixture(true)
  const hooks: ActivityHooks = {
    definition: { title: 'stage', npcIds: [], operations: [] },
    phases: ['ready'],
    initialize: () => ({
      active: true,
      phase: 'ready',
      turn: player,
      round: 1,
      public: { count: 0 },
      private: { [player]: { own: 'OWN_ONLY' } },
      internal: { secret: 'NEVER_PROJECT' },
    }),
    policy: () => ({
      speech: 'free',
      speechChoices: [],
      narration: true,
      move: false,
      interactions: [],
      operations: [],
    }),
    resolve: () => ({ rejectReason: 'none' }),
    schedule: () => ({ kind: 'wait' }),
    onOutcome: () => ({ kind: 'wait' }),
  }
  const seen: unknown[] = []
  const definition = nativeGameplay({
    id: 'stage-owner',
    version: '1',
    dataVersion: 1,
    activities: [{ key: 'stage', activity: hooks }],
  })
  const dispose = f.gameplay.register(
    {
      ...definition,
      playerView: input => {
        seen.push(input.activities)
        const current = input.activities?.[0]
        return current
          ? {
              stage: {
                renderer: 'fixture.counter',
                activityKey: String(current.activityKey),
                activityId: String(current.id),
                revision: Number(current.revision),
                payload: { count: 0 },
              },
            }
          : {}
      },
    },
    {},
  )
  let forged: import('@perspectra/sdk/contracts').ActivityStageView | undefined
  f.gameplay.register({ ...empty('stage-impostor'), playerView: () => (forged ? { stage: forged } : {}) }, {})
  await f.gameplay.initialize()
  await f.gameplay.startActivity('principal:player', 'stage', [])
  const view = await f.gameplay.playerView('principal:player')
  expect(view[0]!.view.stage).toBeTruthy()
  expect(JSON.stringify(seen)).not.toContain('NEVER_PROJECT')
  expect(JSON.stringify(seen)).toContain('OWN_ONLY')
  seen.length = 0
  expect((await f.gameplay.playerView('principal:observer'))[0]!.view.stage).toBeUndefined()
  expect(seen).toEqual([[]])
  forged = view[0]!.view.stage
  const faults: unknown[] = []
  const isolated = await f.gameplay.playerView('principal:player', fault => faults.push(fault))
  expect(isolated[0]!.view.stage).toBeTruthy()
  expect(isolated[1]!.view).toEqual({})
  expect(faults).toHaveLength(1)
  await f.gameplay.controlActivity('principal:player', 'stage', 'suspend')
  expect((await f.gameplay.playerView('principal:player', () => {}))[0]!.view.stage).toBeUndefined()
  dispose()
  expect((await f.gameplay.playerView('principal:player', () => {})).some(row => row.moduleId === 'stage-owner')).toBe(
    false,
  )
})

it('passes only authorized module state into decision projections and copies derived knowledge', async () => {
  const f = await fixture()
  const inputs: any[] = []
  const module = defineGameplay<WorldJsonObject, Empty, null>()({
    id: 'knowledge:owner',
    version: '1',
    dataVersion: 1,
    requiredServices: ['status'],
    operations: [],
    configSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    states: [
      {
        key: 'public-value',
        label: 'Public',
        type: 'string',
        owner: 'public',
        alwaysKnown: true,
        schema: { type: 'string' },
        playerTruth: false,
        bar: false,
      },
      {
        key: 'secret',
        label: 'Secret',
        type: 'string',
        owner: 'character',
        alwaysKnown: false,
        schema: { type: 'string' },
        playerTruth: false,
        bar: false,
      },
    ],
    initializeState: ({ characterIds }) => ({
      public: { 'public-value': 'PUBLIC' },
      characters: Object.fromEntries(
        characterIds.map(id => [
          id,
          { secret: id === player ? 'PLAYER_SECRET' : id === npc ? 'NPC_SECRET' : 'OTHER_SECRET' },
        ]),
      ),
    }),
    projectState: ({ actorId, state }) => {
      inputs.push(structuredClone(state))
      return { ...state, abilities: [{ actorId, effects: ['derived'] }] }
    },
  })
  f.gameplay.register(module, {})
  await f.gameplay.initialize()
  const before = JSON.stringify(f.events())
  const first = f.gameplay.projectContext(f.events(), player, {}) as any
  const value = first.gameplay.find((m: any) => m.moduleId === 'knowledge:owner').state
  expect(value.public).toEqual({ 'public-value': 'PUBLIC' })
  expect(JSON.stringify(inputs)).not.toContain('NPC_SECRET')
  expect(JSON.stringify(first)).not.toContain('NPC_SECRET')
  expect(value.characters[player].secret).toBe('PLAYER_SECRET')
  value.abilities[0].effects.push('tampered')
  value.characters[player].secret = 'TAMPERED'
  const again = f.gameplay.projectContext(f.events(), player, {}) as any
  expect(JSON.stringify(again)).not.toMatch(/tampered|TAMPERED/)
  const npcView = f.gameplay.projectContext(f.events(), npc, {})
  expect(JSON.stringify(npcView)).toContain('NPC_SECRET')
  expect(JSON.stringify(npcView)).not.toContain('PLAYER_SECRET')
  expect(JSON.stringify(f.events())).toBe(before)
})
