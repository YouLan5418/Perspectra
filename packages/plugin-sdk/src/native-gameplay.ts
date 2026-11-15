import type { JSONSchemaType } from 'ajv'
import type { ActivityState, StatusDefinition, WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import type { ContentGameplay, GeneratedActivity, GeneratedStatusModule } from './content.ts'
import type { OperationDefinition } from './gameplay.ts'
import type { HostServices } from './host.ts'

const jsonResult = {} as JSONSchemaType<WorldJsonValue>
const configSchema = { type: 'object', additionalProperties: true, required: [] } as JSONSchemaType<WorldJsonObject>

/** Expands configuration computations into ordinary registered operations, never a second executor. */
export function nativeGameplay(input: {
  id: string
  version: string
  dataVersion: number
  supportedDataVersions?: readonly number[]
  status?: GeneratedStatusModule
  activities: readonly GeneratedActivity[]
  requiredServices?: readonly (keyof HostServices)[]
}): ContentGameplay {
  const operations: OperationDefinition<WorldJsonObject, WorldJsonObject, WorldJsonValue>[] = []
  const status = input.status
  for (const action of status?.module.definition.actions ?? []) {
    const localId = String(action.id)
    const resolve = status!.module.resolve.bind(status!.module)
    operations.push({
      id: 'status:' + status!.declaration.id + '-' + localId,
      status: { operationId: localId },
      argumentSchema: action.schema as JSONSchemaType<WorldJsonObject>,
      resultSchema: jsonResult,
      resolve: value => {
        const result = resolve(
          value.truth!,
          value.actorId,
          localId,
          value.parameters,
          value.world!,
          value.targetId ?? null,
          null,
        )
        if (typeof result.rejectReason === 'string')
          return { status: 'rejected', rejection: { code: 'STATUS_REJECTED', message: result.rejectReason } }
        return { status: 'accepted', outcome: result, effects: [{ kind: 'status-result', result }] }
      },
      npc: {
        whenToUse: String(action.label ?? localId),
        formatResult: value => String((value.outcome as WorldJsonObject).description ?? ''),
      },
      ui: { label: String(action.label ?? localId) },
    })
  }
  for (const { key, activity } of input.activities) {
    const resolve = activity.resolve.bind(activity)
    const declared = activity.definition.operations as unknown as readonly {
      id: string
      label: string
      schema: WorldJsonObject
    }[]
    for (const action of declared)
      operations.push({
        id: 'activity:' + key + ':' + action.id,
        activity: { key, operationId: action.id },
        argumentSchema: action.schema as JSONSchemaType<WorldJsonObject>,
        resultSchema: jsonResult,
        resolve: value => {
          const result = resolve(
            value.activity!,
            value.actorId,
            action.id,
            value.parameters,
            value.world!,
            value.truth ?? null,
            value.rollDice,
          )
          if (typeof result.rejectReason === 'string')
            return { status: 'rejected', rejection: { code: 'ACTIVITY_REJECTED', message: result.rejectReason } }
          return {
            status: 'accepted',
            outcome: result,
            effects: [{ kind: 'activity-result', activityKey: key, result }],
          }
        },
        ui: { label: action.label },
      })
  }
  return {
    id: input.id,
    version: input.version,
    dataVersion: input.dataVersion,
    ...(input.supportedDataVersions ? { supportedDataVersions: input.supportedDataVersions } : {}),
    requiredServices: [
      ...(input.requiredServices ?? []),
      ...(status ? ['status' as const] : []),
      ...(input.activities.length ? ['activities' as const] : []),
    ],
    configSchema,
    operations,
    states: (status?.module.definition.statuses ?? []) as unknown as readonly StatusDefinition[],
    ...(status
      ? {
          initializeState: (value: { characterIds: readonly string[] }) => status.module.initialize(value.characterIds),
        }
      : {}),
    projectState: value => value.state as unknown as WorldJsonObject,
    ...(status
      ? {
          statusPolicy: {
            characterIds: [...status.declaration.characters],
            operations: status.module.definition.actions,
            policy: status.module.policy.bind(status.module),
          },
        }
      : {}),
    activities: input.activities.map(({ key, activity }) => {
      const { resolve: _resolve, ...behavior } = activity
      return {
        key,
        title: String(activity.definition.title),
        operations: activity.definition.operations as never,
        resultSchema: jsonResult,
        formatResult: value => String((value.outcome as WorldJsonObject).description ?? ''),
        behavior,
        initialize: value => ({
          id: value.activityId ?? 'activity:' + key,
          revision: 1,
          participants: [value.playerId, ...value.participantIds],
          game: activity.initialize(
            {
              playerId: value.playerId,
              npcIds: [...value.participantIds],
              world: value.world ?? {},
              truth: (value.truth as unknown as WorldJsonValue) ?? null,
              previous: value.previous ?? null,
            },
            value.random,
          ) as ActivityState['game'],
        }),
      }
    }),
  }
}

/** Binds configuration-expanded definitions to this world's selected, already guarded service instances.
 * The resulting definition has one Handler per operation; providers propose effects and the core still commits.
 * Pure definitions remain usable for static inspection. This binding never falls back to their raw hooks.
 */
export function bindNativeGameplay(
  definition: ContentGameplay,
  services: {
    readonly status?: import('./status.ts').StatusInstance
    readonly activities?: import('./activities.ts').ActivitiesInstance
  },
): ContentGameplay {
  const object = (value: unknown): WorldJsonObject => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new TypeError('Provider returned an invalid gameplay object')
    return value as WorldJsonObject
  }
  const status = services.status
  if (definition.statusPolicy && !status)
    throw new TypeError('Native status definitions require the selected status provider')
  const keys = new Set((definition.states ?? []).map(state => state.key))
  const owned = (value: unknown): WorldJsonObject =>
    Object.fromEntries(Object.entries(object(value)).filter(([key]) => keys.has(key)))
  const activityEntries = new Map(services.activities?.entries.map(entry => [entry.key, entry]) ?? [])
  for (const activity of definition.activities ?? [])
    if (!activityEntries.has(activity.key)) throw new TypeError('Selected activity provider is missing ' + activity.key)
  const statusIds = new Map(
    definition.operations.flatMap(operation =>
      operation.status ? [[operation.id.slice('status:'.length), operation.status.operationId] as const] : [],
    ),
  )
  return {
    ...definition,
    ...(definition.statusPolicy
      ? {
          initializeState: input => {
            const initialized = object(status!.initialize(input.characterIds))
            const characters = object(initialized.characters)
            return {
              public: owned(initialized.public),
              characters: Object.fromEntries(input.characterIds.map(id => [id, owned(characters[id])])),
              ...(initialized.reveals === undefined
                ? {}
                : {
                    reveals: (
                      initialized.reveals as unknown as import('@harness-world/contracts').StatusReveal[]
                    ).filter(reveal => keys.has(reveal.key)),
                  }),
            }
          },
          statusPolicy: {
            ...definition.statusPolicy,
            policy: (known, actorId, place) => {
              const result = object(status!.policy(known, actorId, place))
              if (!Array.isArray(result.operations) || result.operations.some(id => typeof id !== 'string'))
                throw new TypeError('Selected status provider returned invalid operations')
              const targets = result.targets === undefined ? undefined : object(result.targets)
              return {
                operations: result.operations.flatMap(id =>
                  statusIds.has(String(id)) ? [statusIds.get(String(id))!] : [],
                ),
                ...(targets
                  ? {
                      targets: Object.fromEntries(
                        Object.entries(targets)
                          .filter(([id]) => statusIds.has(id))
                          .map(([id, value]) => [statusIds.get(id)!, value]),
                      ) as Record<string, string[]>,
                    }
                  : {}),
              }
            },
          },
        }
      : {}),
    operations: definition.operations.map(operation => {
      if (operation.status)
        return {
          ...operation,
          resolve: value => {
            const result = object(
              status!.resolve({
                truth: value.truth!,
                actorId: value.actorId,
                operation: operation.id.slice('status:'.length),
                parameters: value.parameters,
                world: value.world!,
                targetId: value.targetId ?? null,
                external: null,
              }),
            )
            return typeof result.rejectReason === 'string'
              ? { status: 'rejected', rejection: { code: 'STATUS_REJECTED', message: result.rejectReason } }
              : { status: 'accepted', outcome: result, effects: [{ kind: 'status-result', result }] }
          },
        }
      if (operation.activity) {
        const binding = operation.activity,
          activity = activityEntries.get(binding.key)!
        return {
          ...operation,
          resolve: value => {
            const result = object(
              activity.resolve(
                value.activity!,
                value.actorId,
                binding.operationId,
                value.parameters,
                value.world!,
                value.truth ?? null,
                value.rollDice,
              ),
            )
            return typeof result.rejectReason === 'string'
              ? { status: 'rejected', rejection: { code: 'ACTIVITY_REJECTED', message: result.rejectReason } }
              : {
                  status: 'accepted',
                  outcome: result,
                  effects: [{ kind: 'activity-result', activityKey: binding.key, result }],
                }
          },
        }
      }
      return operation
    }),
    activities: (definition.activities ?? []).map(original => {
      const entry = activityEntries.get(original.key)!
      const behavior: Omit<import('./activities.ts').ActivityHooks, 'resolve'> = {
        definition: object(entry.definition),
        ...(entry.phases ? { phases: entry.phases } : {}),
        initialize: (input, random) => object(entry.initialize(input, random)),
        policy: (scoped, actor) => object(entry.policy(scoped, actor)),
        schedule: state => object(entry.schedule(state)),
        onOutcome: (result, state) => object(entry.outcome(result, state)),
        onPublished: (state, actor, publication) => {
          const result = entry.published(state, actor, publication)
          return result === null ? null : object(result)
        },
        ...(entry.hasAutoStart
          ? {
              autoStart: (truth, world, previous) => {
                const result = entry.autoStart(truth, world, previous)
                return result === null ? null : object(result)
              },
            }
          : {}),
        ...(entry.hasResume()
          ? {
              resume: (scoped, world) => {
                const result = entry.resume(scoped, world)
                return result === null ? null : object(result)
              },
            }
          : {}),
        simulate: request => {
          const result = entry.simulate(request)
          return result === null ? null : object(result)
        },
      }
      return {
        ...original,
        behavior,
        initialize: input => ({
          id: input.activityId!,
          revision: 1,
          participants: [input.playerId, ...input.participantIds],
          game: behavior.initialize(
            {
              playerId: input.playerId,
              npcIds: [...input.participantIds],
              world: input.world ?? {},
              truth: (input.truth as unknown as WorldJsonValue) ?? null,
              previous: input.previous ?? null,
            },
            input.random,
          ) as ActivityState['game'],
        }),
      }
    }),
  }
}
