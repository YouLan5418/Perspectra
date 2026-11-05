// The creator's read-only queries over one world instance. Nothing here reaches a character or the player.
import { brandId, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import {
  currentCharacterLifecycle,
  currentEntityState,
  currentLocation,
  currentSceneStates,
} from '@harness-world/kernel'
import type { MemoryInstance, SchedulerResult } from '@harness-world/plugin-sdk'
import type { RequestInspector } from '@harness-world/provider-chat'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { resolve } from 'node:path'
import { creatorHistory, creatorHistoryQuery, type CreatorHistoryQuery } from './creator-history.ts'
import {
  creatorInspectionQuery,
  type CreatorInspectionQuery,
  type CreatorInspectionSnapshot,
} from './creator-inspection.ts'
import type { CreatorRecords } from './creator-records.ts'
import type { StatusTruth } from '@harness-world/contracts'
import type { RulebookEvent } from '@harness-world/kernel'

/** What the queries read of the world instance, taken fresh for each query. */
export interface CreatorQueryHost {
  readonly closing: boolean
  readonly busy: boolean
  readonly paused: boolean
  readonly names: ReadonlyMap<string, string>
  readonly locationNames: ReadonlyMap<string, string>
  readonly dataDirectory: string
  readonly address: WorldAddress
  readonly worldVersion: string
  readonly title: string
  readonly packHash: string
  readonly storyParentNodeId: string | null
  readonly activationCycle: SchedulerResult | undefined
  readonly inspector: RequestInspector
  readonly records: CreatorRecords
  statusTruth(events: readonly RulebookEvent[]): StatusTruth | undefined
  activityStates(events: readonly RulebookEvent[]): readonly WorldJsonObject[]
  readonly memory: MemoryInstance | undefined
  readonly memoryIsCore: boolean
}

export function creatorHistorySnapshot(host: CreatorQueryHost, input: CreatorHistoryQuery = {}) {
  if (host.closing) throw new TypeError('运行实例已关闭')
  const query = creatorHistoryQuery(input as Record<string, unknown>)
  if (query.characterId !== undefined && !host.names.has(query.characterId)) throw new TypeError('未知角色')
  const store = new WorldStore(resolve(host.dataDirectory, 'world.sqlite'))
  try {
    if (
      query.entityId !== undefined &&
      currentEntityState(store.readEvents(host.address), query.entityId) === undefined
    )
      throw new TypeError('未知物品')
    return {
      ...creatorHistory(store, host.address, host.worldVersion, query),
      scope: structuredClone(host.records.scope),
    }
  } finally {
    store.close()
  }
}

export function creatorInspectionSnapshot(
  host: CreatorQueryHost,
  input: CreatorInspectionQuery = {},
): CreatorInspectionSnapshot {
  if (host.closing) throw new TypeError('运行实例已关闭')
  const query = creatorInspectionQuery(input as Record<string, unknown>)
  if (query.characterId !== undefined && !host.names.has(query.characterId)) throw new TypeError('未知角色')
  const store = new WorldStore(resolve(host.dataDirectory, 'world.sqlite'))
  try {
    const head = store.head(host.address),
      events = store.readEvents(host.address, head.headSeq)
    if ((query.afterSeq ?? 0) > head.headSeq) throw new TypeError('查询游标超过当前世界时刻')
    const scenes = currentSceneStates(events),
      limit = query.limit ?? 50
    const characters = [...host.names].map(([id, name]) => {
      const locationId = currentLocation(events, id) ?? null
      return {
        id,
        name,
        locationId,
        locationName: locationId === null ? null : (host.locationNames.get(locationId) ?? locationId),
        sceneIds: scenes
          .filter(scene => scene.lifecycle !== 'closed' && scene.participantIds.includes(id))
          .map(scene => scene.sceneId),
        lifecycle: currentCharacterLifecycle(events, id) ?? 'unknown',
        lastMovementSeq:
          events.findLast(
            event => event.eventType === 'character.moved' && (event.data as WorldJsonObject).characterId === id,
          )?.seq ?? null,
        processing: {
          transport: host.inspector.status(id),
          lastActivation:
            host.activationCycle?.activations.findLast(activation => activation.characterId === id)?.result ?? null,
        },
      }
    })
    const entityIds = [
      ...new Set(
        events
          .filter(event => event.eventType === 'entity.upsert')
          .map(event => String((event.data as WorldJsonObject).entityId)),
      ),
    ]
    const entities = entityIds.map(id => {
      const state = currentEntityState(events, id)!
      const holderLocation = characters.find(character => character.id === state.holderId)?.locationId ?? null
      // 状态更新的 upsert 常常只写 kind / locationId，名称取最近一次写明 name 的记录。
      const named = events.findLast(
        event =>
          event.eventType === 'entity.upsert' &&
          (event.data as WorldJsonObject).entityId === id &&
          typeof (event.data as WorldJsonObject).name === 'string',
      )
      return {
        id,
        name: String((named?.data as WorldJsonObject | undefined)?.name ?? id),
        state,
        holderMeaning: 'custody' as const,
        effectiveLocationId: state.locationId ?? holderLocation,
        locationBasis:
          state.locationId !== null
            ? ('entity' as const)
            : holderLocation !== null
              ? ('holder' as const)
              : ('unknown' as const),
        lastChangeSeq: events.findLast(
          event => event.eventType.startsWith('entity.') && (event.data as WorldJsonObject).entityId === id,
        )!.seq,
      }
    })
    const selectedEvents =
      query.afterSeq === undefined
        ? events.slice(-limit)
        : events.filter(event => event.seq > query.afterSeq!).slice(0, limit)
    const nextAfterSeq = selectedEvents.at(-1)?.seq ?? query.afterSeq ?? head.headSeq
    // The creator sees true status values; players and roles only ever get their own known values.
    const truth = host.statusTruth(events)
    const result: CreatorInspectionSnapshot = {
      capturedAt: new Date().toISOString(),
      address: host.address,
      worldVersion: host.worldVersion,
      title: host.title,
      headSeq: head.headSeq,
      tick: head.tick,
      packHash: host.packHash,
      storyParentNodeId: host.storyParentNodeId,
      busy: host.busy,
      paused: host.paused,
      captureEnabled: host.inspector.enabled,
      characters,
      entities,
      statusTruth: truth ? { public: truth.public, characters: truth.characters } : null,
      activities: [...host.activityStates(events)],
      events: { items: selectedEvents, nextAfterSeq, hasMore: nextAfterSeq < head.headSeq },
      limitations: [
        'holderId 表示保管或携带，不证明法律所有权。',
        '物品随保管者的位置是推导值，不表示精确物理位置。',
        '事件中的 observation.upsert 记录实际信息接收者；对白的 addresseeIds 不等于全部观察者。',
        '调用状态是传输证据，lastActivation 是最近已完成周期结果；未采集或正在调度时不推测角色意图。',
        ...(truth ? ['状态为事件日志中的当前真实值；玩家和角色只看到各自上次确认的值。'] : []),
      ],
    }
    if (query.characterId !== undefined) {
      const id = query.characterId
      const archive = host.memory?.inspect?.(id, query.memoryOffset ?? 0, limit)
      result.character = {
        id,
        currentView: new CharacterViewBuilder(store).rebuildAt(host.address, brandId(id, 'CharacterId'), head.headSeq),
        latestRequest: host.inspector.latest(id),
        contextNotice:
          'currentView 是当前授权视图；latestRequest 是启用采集后该角色最近一次实际请求，时刻可能早于当前世界。每角色保留最近一次，超出总容量会淘汰。',
        memory: {
          mode: host.memoryIsCore ? 'core' : 'none',
          // The shape an implementation reports; the creator page only displays it.
          archivePrefix: (archive?.archivePrefix ?? null) as number | null,
          sections: (archive?.sections ?? {}) as never,
          maintenance: (archive?.maintenance ?? null) as WorldJsonObject | null,
          notice: host.memoryIsCore
            ? '已安装档案分页，不触发整理或召回。本次实际召回见 latestRequest.contextParts 的 memories。'
            : '当前没有长期记忆档案；授权经历见 currentView。',
        },
      }
    }
    return structuredClone(result)
  } finally {
    store.close()
  }
}
