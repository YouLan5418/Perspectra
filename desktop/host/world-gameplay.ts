import type { MemoryRequest } from '@harness-world/plugin-sdk'
import type { CharacterTurnRequest } from '@harness-world/application'
import { characterExecutionResult } from '@harness-world/application'
import type { CharacterId, WorldAddress, WorldJsonObject } from '@harness-world/contracts'
import { RulebookRegistry, type RulebookResolution, type RulebookResolutionContext } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import type { CapabilitySession } from '../host-capabilities.ts'
import { PackActivities } from './pack-activities.ts'
import { PackAutonomy } from './pack-autonomy.ts'
import { communicationInstruction, CrossSceneCommunication, loadCommunicationConfig } from './pack-communication.ts'
import type { PackModules } from './pack-modules.ts'
import type { StatusRuntime } from './status-runtime.ts'
import { KNOWN_STATUS_NOTE, publicStatusChanges } from '@harness-world/application'

export interface LoadedPack {
  readonly packPath: string
  readonly pack: Parameters<typeof PackAutonomy.load>[1]
  readonly modules: PackModules | undefined
  readonly status: StatusRuntime | undefined
  readonly capabilities: CapabilitySession | undefined
}

/** Transitional host assembly of gameplay adapters; script computation is provided by mechanisms. */
export class WorldGameplay {
  activity: PackActivities | undefined
  modules: PackModules | undefined
  autonomy: PackAutonomy | undefined
  communication: CrossSceneCommunication | undefined
  status: StatusRuntime | undefined

  constructor(
    private readonly world: {
      readonly address: WorldAddress
      readonly playerId: CharacterId
      readonly worldPath: string
      readonly coreRules: () => RulebookRegistry
    },
  ) {}

  /** What has to exist before the world is activated. */
  prepare(
    packPath: string,
    pack: LoadedPack['pack'],
    manifest: ConstructorParameters<typeof CrossSceneCommunication>[1],
  ): void {
    const input = { packPath }
    this.autonomy = PackAutonomy.load(input.packPath, pack, this.world.playerId)
    const communication = loadCommunicationConfig(input.packPath, pack)
    if (communication !== undefined)
      this.communication = new CrossSceneCommunication(
        communication,
        manifest,
        this.world.coreRules().resolve('builtin:speak-move', 2, 'communication', this.world.address),
      )
  }

  /** The rest, once the world is active. */
  async load(input: LoadedPack): Promise<void> {
    const { pack, modules } = input
    this.status = input.status
    if (modules) {
      modules.bind(this.status!, input.capabilities!)
      this.status!.externalActions = modules
    }
    await this.status?.ensureInitial(this.world.worldPath, this.world.address, this.world.playerId)
    this.activity = PackActivities.load(
      input.packPath,
      pack,
      this.world.worldPath,
      this.world.address,
      this.world.playerId,
      this.status,
      this.world.coreRules(),
    )
    if (modules)
      this.activity?.setActionResolver((context, adjudicate) =>
        modules.resolveAction(
          context,
          this.world.worldPath,
          this.world.address,
          AbortSignal.any([AbortSignal.timeout(10000), this.activity!.signal]),
          adjudicate,
        ),
      )
  }

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
    const projected = this.communication ? { ...activityContext, communicationInstruction } : activityContext
    return autonomous
      ? {
          ...projected,
          autonomy: {
            instruction:
              '现在是你自主处理自身目标的机会。依据自己的目标、经历和眼前情况决定是否行动；可以表达或 abstain。没有新消息不代表发生了你不知道的事；但 context.statusChanges 里的变化已经发生，例如时间已经推进，请按现在的时段与处境行动，不要接着已经过去的对话收尾。',
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
              (input.action.parameters as WorldJsonObject).bindingId === 'experiment:message'
                ? this.communication!.executionResult(input)
                : (this.status?.executionResult(input) ??
                  (this.activity?.executionResult ?? characterExecutionResult)(input)),
          }),
    }
  }
}
