import { WriterLeaseService } from '@perspectra/core/store'
import { WorldStore } from '@perspectra/core/store'
import type { CharacterId, WorldAddress, WorldJsonObject } from '@perspectra/sdk/contracts'
import { brandId } from '@perspectra/sdk/contracts'
import { isPluginFault } from './plugin-runtime.ts'
import type { RoundStatus } from './round-notices.ts'
import type { WorldAdapters } from './world-adapters.ts'

export interface GameplayInputOutcome {
  readonly accepted: boolean
  readonly react: boolean
  readonly speechListeners?: readonly string[]
}

/** `/status <operation>[@<item>] <json>`: a status operation, done to an item when one is named. */
function statusCommand(text: string): { operation: string; targetId?: string; parameters: WorldJsonObject } {
  const match = /^\/status ([a-z][a-z0-9-]*)(?:@(\S+))? (.+)$/su.exec(text)
  if (match === null) throw new TypeError('状态命令格式无效')
  return {
    operation: match[1]!,
    ...(match[2] === undefined ? {} : { targetId: match[2] }),
    parameters: JSON.parse(match[3]!) as WorldJsonObject,
  }
}

/** Input that belongs to the pack's modules: anything during an activity, messages and status commands. Anything else
 * returns undefined and goes to the world as ordinary player input. */
export async function routeGameplayInput(input: {
  readonly gameplay: WorldAdapters
  readonly status: RoundStatus
  readonly worldPath: string
  readonly address: WorldAddress
  readonly playerId: CharacterId
  readonly manifest: Parameters<NonNullable<WorldAdapters['communication']>['send']>[0]['manifest']
  readonly publicationCharacters: number
  readonly text: string
  readonly key: string
  readonly signal?: AbortSignal
  readonly inActivity: boolean
}): Promise<GameplayInputOutcome | undefined> {
  const { gameplay, status, worldPath, address, playerId, manifest, publicationCharacters, text, key, inActivity } =
    input
  if (inActivity) {
    let speechListeners: readonly string[] = []
    // A refusal throws: an activity commits nothing for a rejected player action.
    if (text.startsWith('/act ')) {
      const match = /^\/act (speak|move|interact) (.+)$/u.exec(text)
      if (match === null) throw new TypeError('动作命令格式无效')
      const parameters = JSON.parse(match[2]!) as WorldJsonObject
      speechListeners = await gameplay.activity!.worldAction({ actionType: match[1]!, parameters }, key, input.signal)
    } else if (text.startsWith('/status ')) {
      // During an activity a status operation is an ordinary interaction under the activity's policy.
      const command = statusCommand(text)
      await gameplay.activity!.worldAction(
        {
          actionType: 'interact',
          parameters: {
            targetRef:
              command.targetId === undefined
                ? { kind: 'character', id: playerId }
                : { kind: 'entity', id: command.targetId },
            bindingId: 'status',
            definitionRef: { id: 'status:' + command.operation, version: 1 },
            arguments: command.parameters,
          },
        },
        key,
        input.signal,
      )
    } else speechListeners = await gameplay.activity!.speak(text, key, input.signal)
    status.set('操作已提交；单纯对白不消耗游戏行动回合。', undefined)
    return { accepted: true, react: true, speechListeners }
  }
  if (text.startsWith('/message ')) {
    if (!gameplay.communication) throw new TypeError('本包没有开启短信')
    const message = JSON.parse(text.slice('/message '.length)) as WorldJsonObject
    const recipientId = String(message.recipientId)
    if (typeof message.text !== 'string' || !message.text.trim())
      throw new TypeError(gameplay.communication.medium + '内容不能为空')
    if (message.text.length > publicationCharacters) throw new RangeError(gameplay.communication.medium + '太长了')
    const path = worldPath
    const store = new WorldStore(path),
      leases = new WriterLeaseService(path)
    try {
      // Replays use their committed authority even if the contact is unavailable now.
      if (
        !store.readRoundAuthority(address, brandId('message:' + key, 'TransactionId')) &&
        !gameplay.communication
          .options(store.readEvents(address), playerId)
          .some(option => option.targetRef.id === recipientId)
      )
        throw new TypeError('不能给这个人发' + gameplay.communication.medium)
      const delivery = await gameplay.communication.send({
        store,
        leases,
        address: address,
        manifest: manifest,
        actorId: playerId,
        recipientId,
        text: message.text,
        requestId: key,
        resolver: gameplay
          .rulebooks(worldPath)
          .resolve(manifest.rulebook.rulebookId, manifest.rulebook.version, 'manual-communication', address),
        ...(input.signal ? { signal: input.signal } : {}),
      })
      let description = delivery.status === 'accepted' ? '消息已投递。' : '消息未能投递。'
      try {
        description = gameplay.communication.mechanism.describeDelivery(delivery.status)
      } catch (error) {
        // The guarded formatter already reports the plugin fault. Keep the committed delivery and reaction.
        if (!isPluginFault(error)) throw error
      }
      status.set(description, undefined)
      return { accepted: delivery.status === 'accepted', react: delivery.committed }
    } finally {
      leases.close()
      store.close()
    }
  }
  if (text.startsWith('/status ')) {
    const command = statusCommand(text)
    // A rejection throws with the reason; a retried request returns its original result and starts no round.
    const changed = await gameplay.status!.apply(
      worldPath,
      address,
      playerId,
      command.operation,
      command.parameters,
      key,
      command.targetId,
      input.signal,
    )
    status.set(changed ? '状态操作已提交。' : '已返回原提交结果，没有再次执行。', undefined)
    return { accepted: true, react: changed }
  }
  return undefined
}
