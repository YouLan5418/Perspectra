import { isMessageAction } from '@harness-world/contracts'
import type { MemoryRequest } from '@harness-world/plugin-sdk'
import type { CharacterTurnRequest } from '@harness-world/application'
import { characterExecutionResult } from '@harness-world/application'
import type { CharacterId, WorldAddress, WorldJsonObject } from '@harness-world/contracts'
import { RulebookRegistry, type RulebookResolution, type RulebookResolutionContext } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { ActivitiesRuntime } from './activities-runtime.ts'
import { AutonomyRuntime } from './autonomy-runtime.ts'
import { CommunicationRuntime } from './communication-runtime.ts'
import type { PackModules } from './pack-modules.ts'
import type { StatusRuntime } from './status-runtime.ts'
import { KNOWN_STATUS_NOTE, publicStatusChanges } from '@harness-world/application'

/** Host rule and context projections over already assembled execution adapters. No mechanism selection. */
export class WorldAdapters {
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
    if (!this.status) return this.activity?.rulebooks(this.communication?.resolver()) ?? core
    const status = this.status.resolver(
      core.resolve('builtin:speak-move', 2, 'status', this.world.address),
      worldPath,
      this.world.address,
      this.world.playerId,
    )
    if (this.activity) return this.activity.rulebooks(status)
    const registry = new RulebookRegistry()
    registry.register('builtin:speak-move', 2, status)
    return registry
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
        ])
      } finally {
        store.close()
      }
      const updates = events.filter(event => event.eventType === 'status.updated')
      const known = this.status.known(updates, characterId)
      const statusChanges = publicStatusChanges(this.status, updates, events, characterId, known)
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

  projectContext(context: WorldJsonObject, canPerform: boolean, autonomous: boolean): WorldJsonObject {
    const activityContext = this.activity?.projectContext(context, canPerform) ?? context
    const projected = this.communication
      ? { ...activityContext, communicationInstruction: this.communication.instruction }
      : activityContext
    return autonomous
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
