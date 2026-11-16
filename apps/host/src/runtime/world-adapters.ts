import { isMessageAction } from '@perspectra/sdk/contracts'
import type { MemoryRequest } from '@perspectra/sdk'
import type { CharacterTurnRequest } from '@perspectra/core'
import { characterExecutionResult } from '@perspectra/core'
import type { CharacterId, WorldAddress, WorldJsonObject } from '@perspectra/sdk/contracts'
import { RulebookRegistry, type RulebookResolution, type RulebookResolutionContext } from '@perspectra/core/kernel'
import { WorldStore } from '@perspectra/core/store'
import { ActivitiesRuntime } from './activities-runtime.ts'
import { AutonomyRuntime } from './autonomy-runtime.ts'
import { CommunicationRuntime } from './communication-runtime.ts'
import type { PackModules } from './pack-modules.ts'
import type { StatusRuntime } from './status-runtime.ts'
import { KNOWN_STATUS_NOTE, publicStatusChanges } from '@perspectra/core'

/** The events that place a character, which `StatusState.known` reads for statuses limited to locations. */
const LOCATION_EVENTS: readonly string[] = ['character.created', 'character.upsert', 'character.moved']

/** Host rule and context projections over already assembled execution adapters. No mechanism selection. */
export class WorldAdapters {
  native: import('@perspectra/core').GameplayRuntime | undefined
  activity: ActivitiesRuntime | undefined
  modules: PackModules | undefined
  autonomy: AutonomyRuntime | undefined
  communication: CommunicationRuntime | undefined
  pacing: import('./pacing-runtime.ts').PacingRuntime | undefined
  status: StatusRuntime | undefined

  constructor(
    private readonly world: {
      readonly address: WorldAddress
      readonly playerId: CharacterId
      readonly worldPath: string
      readonly coreRules: () => RulebookRegistry
    },
  ) {}

  /** Resolver chain: core, then the pack's SMS, then status operations, then the running activity's permissions. */
  rulebooks(worldPath: string): RulebookRegistry {
    const core = this.communication?.registry() ?? this.world.coreRules()
    if (!this.status) return this.#permissions(this.activity?.rulebooks(this.communication?.resolver()) ?? core)
    const status = this.status.resolver(
      core.resolve('builtin:speak-move', 2, 'status', this.world.address),
      worldPath,
      this.world.address,
      this.world.playerId,
    )
    if (this.activity) return this.#permissions(this.activity.rulebooks(status))
    const registry = new RulebookRegistry()
    registry.register('builtin:speak-move', 2, status)
    return this.#permissions(registry)
  }

  #permissions(registry: RulebookRegistry): RulebookRegistry {
    if (this.native) {
      const wrapped = new RulebookRegistry()
      wrapped.register(
        'builtin:speak-move',
        2,
        this.native.resolver(registry.resolve('builtin:speak-move', 2, 'native-gameplay', this.world.address)),
      )
      registry = wrapped
    }
    return (
      this.autonomy?.rulebooks(registry.resolve('builtin:speak-move', 2, 'role-permissions', this.world.address)) ??
      registry
    )
  }

  /** What this character knows of the pack's state and author knowledge, ahead of a decision. */
  statusContext<T extends MemoryRequest>(request: T, characterId: string): T {
    if (this.status) {
      const store = new WorldStore(this.world.worldPath)
      let events
      try {
        events = store.readEventsRange(this.world.address, 0, store.head(this.world.address).headSeq, [
          'status.updated',
          'action.resolved',
          ...LOCATION_EVENTS,
        ])
      } finally {
        store.close()
      }
      const updates = events.filter(event => event.eventType === 'status.updated')
      // A status shown only at some locations needs to know where she is now.
      const known = this.status.known(
        events.filter(event => event.eventType !== 'action.resolved'),
        characterId,
      )
      const statusChanges = publicStatusChanges(
        this.status,
        updates,
        events.filter(event => !LOCATION_EVENTS.includes(event.eventType)),
        characterId,
        known,
      )
      request = {
        ...request,
        context: {
          ...request.context,
          knownStatus: known as unknown as WorldJsonObject[],
          knownStatusNote: KNOWN_STATUS_NOTE,
          ...(statusChanges.length ? { statusChanges: statusChanges as unknown as WorldJsonObject[] } : {}),
        },
      }
    }
    return request
  }

  projectContext(context: WorldJsonObject, canPerform: boolean): WorldJsonObject {
    const activityContext = this.activity?.projectContext(context, canPerform) ?? context
    const projected = this.communication
      ? { ...activityContext, communicationInstruction: this.communication.instruction }
      : activityContext
    const character = context.character as WorldJsonObject | undefined
    return this.autonomy?.roles.some(role => role.characterId === character?.characterId)
      ? {
          ...projected,
          autonomy: {
            instruction: this.autonomy!.instruction,
          },
        }
      : projected
  }

  /** The turn options that only exist when a pack has the module behind them. */
  turnOptions(worldPath: string) {
    return {
      ...(this.modules
        ? {
            resolveAction: (
              context: RulebookResolutionContext,
              signal: AbortSignal,
              adjudicate: () => RulebookResolution,
            ) => this.modules!.resolveAction(context, worldPath, this.world.address, signal, adjudicate),
          }
        : {}),
      ...(this.activity === undefined
        ? {}
        : {
            validateDecision: (decision: WorldJsonObject, request: CharacterTurnRequest) =>
              this.activity!.validateDecision(decision, request),
          }),
      ...(this.activity === undefined && this.status === undefined && this.communication === undefined
        ? {}
        : {
            executionResult: (input: Parameters<typeof characterExecutionResult>[0]) =>
              isMessageAction(input.action.parameters) && this.communication !== undefined
                ? this.communication!.executionResult(input)
                : (this.status?.executionResult(input) ??
                  (this.activity?.executionResult ?? characterExecutionResult)(input)),
          }),
    }
  }
}
