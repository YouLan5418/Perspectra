import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { GameplayRuntime, WorldExecutionEngine, StatusState, type WorldRoundSnapshot } from '@harness-world/application'
import type { StatusSource, SeamProvider, StatusInstance, WorldReader, HostServices } from '@harness-world/plugin-sdk'
import { createWorldCast } from './world-cast.ts'
import {
  createWorldInstanceScope,
  createPluginCallContext,
  callPluginOpen,
  callPluginForValue,
  hostCapability,
} from '@harness-world/runtime-cordis'
import { runtimeManifestFromStored } from '@harness-world/kernel'
import type { WorldHash, WorldJsonObject } from '@harness-world/contracts'
import { readPluginSet } from './plugin-set.ts'
import { assertSavedPackContent, type PackContent } from './pack-content.ts'

/** Uses the same registered core against a read-only prefix. No initialization effects may be persisted here. */
export async function preflightGameplay(
  directory: string,
  recordDirectory: string,
  content: PackContent | undefined,
  availableServices: readonly (keyof HostServices)[],
): Promise<WorldRoundSnapshot | undefined> {
  const saved = readPluginSet(recordDirectory)
  assertSavedPackContent(saved, content?.compatibility ?? {})
  const file = join(directory, 'world.sqlite')
  if (!existsSync(file)) return
  if (!saved) throw new Error('已有世界缺少 plugin-set.json 插件数据兼容记录，当前版本不能自动迁移此实验存档。')
  const db = new DatabaseSync(file, { readOnly: true })
  let snapshot: WorldRoundSnapshot
  try {
    const branch = db
      .prepare('SELECT b.*,h.head_seq,h.tick,h.event_hash FROM branches b JOIN heads h ON b.address_key=h.address_key')
      .all() as Record<string, unknown>[]
    if (branch.length !== 1) throw new Error('玩法读档预检需要唯一世界分支。')
    const record = db
      .prepare(
        'SELECT m.manifest_json,m.manifest_hash FROM branch_activations a JOIN world_manifests m ON m.manifest_hash=a.manifest_hash',
      )
      .get() as { manifest_json: string; manifest_hash: string } | undefined
    if (!record) throw new Error('已有世界缺少已激活的 Manifest。')
    const manifest = runtimeManifestFromStored(JSON.parse(record.manifest_json))
    const events = (
      db.prepare('SELECT seq,tick,event_type,event_version,data_json FROM events ORDER BY seq').all() as {
        seq: number
        tick: number
        event_type: string
        event_version: number
        data_json: string
      }[]
    ).map(row => ({
      seq: row.seq,
      tick: row.tick,
      eventType: row.event_type,
      eventVersion: row.event_version,
      data: JSON.parse(row.data_json),
    }))
    snapshot = {
      head: { headSeq: Number(branch[0]!.head_seq), tick: Number(branch[0]!.tick) } as WorldRoundSnapshot['head'],
      manifest,
      manifestHash: record.manifest_hash as WorldHash,
      events: events as unknown as WorldRoundSnapshot['events'],
      prior: undefined,
    }
    for (const [id, now] of Object.entries(content?.compatibility ?? {})) {
      const hasOwnedData = events.some(
        event =>
          (event.eventType === 'status.updated' &&
            Array.isArray(event.data.changes) &&
            event.data.changes.some((change: { key: string }) =>
              now.record.statuses.some(value => value.key === change.key),
            )) ||
          (event.eventType === 'activity.updated' &&
            now.record.activities.some(value => value.key === event.data.activityKey)),
      )
      if (hasOwnedData && !saved.gameplayData?.[id])
        throw new Error(id + ' 插件已有持久状态，但 plugin-set.json 缺少必要的数据兼容记录。')
    }
  } finally {
    db.close()
  }
  if (!content?.gameplay.length) return snapshot
  const scope = await createWorldInstanceScope(new Context())
  const engine = new WorldExecutionEngine({
    scope,
    characters: snapshot.manifest.characters.map(row => row.characterId),
    settle: async () => undefined,
  })
  const runtime = new GameplayRuntime({
    scope,
    manifest: snapshot.manifest,
    engine,
    availableServices,
    read: async () => snapshot,
    execute: async (_owner, _actor, adjudicate) => {
      adjudicate(snapshot)
      return undefined
    },
  })
  try {
    for (const definition of content.gameplay) runtime.register(definition, content.configs.get(definition) ?? {})
    await runtime.initialize()
  } finally {
    runtime.close()
    engine.close()
    await scope.close()
  }
  return snapshot
}

/** Schema inspection uses the selected capability and a prefix reader, without opening a writable store. */
export async function preflightStatus(
  snapshot: WorldRoundSnapshot | undefined,
  source: StatusSource | undefined,
  provider: SeamProvider<StatusInstance> | undefined,
  directory: string,
): Promise<void> {
  if (!snapshot || !source) return
  if (!provider) throw new TypeError('状态存档需要所选状态机制')
  const scope = await createWorldInstanceScope(new Context())
  const context = createPluginCallContext(scope)
  const prefix = snapshot.events
  const world: WorldReader = {
    head: () => ({ headSeq: snapshot.head.headSeq, tick: snapshot.head.tick }),
    readEvents: (after, through, types) =>
      structuredClone(
        prefix.filter(
          event => event.seq > after && event.seq <= through && (!types || types.includes(event.eventType)),
        ),
      ) as unknown as WorldJsonObject[],
    eventTicks: through =>
      prefix.filter(event => event.seq <= through).map(event => ({ seq: event.seq, tick: event.tick })),
    characterObservations: (id, through) =>
      structuredClone(
        prefix
          .filter(
            event =>
              event.seq <= through &&
              event.eventType === 'observation.upsert' &&
              (event.data as WorldJsonObject).value &&
              ((event.data as WorldJsonObject).value as WorldJsonObject).observerId === id,
          )
          .map(event => (event.data as WorldJsonObject).value as WorldJsonObject),
      ),
    authorizedSources: () => {
      throw new TypeError('Persistent memory sources are unavailable during pure status-schema preflight')
    },
  }
  const player = snapshot.manifest.playerBindings[0]!.characterId
  const reader = Object.fromEntries(
    Object.entries(world).map(([name, work]) => [name, hostCapability(context, work)]),
  ) as unknown as WorldReader
  try {
    const instance = await callPluginOpen(
      context,
      'preflight:status',
      provider.id,
      provider,
      {
        address: snapshot.manifest.address,
        worldVersion: 'status-schema-preflight',
        candidate: true,
        dataDirectory: join(directory, 'plugins', provider.id),
        instanceDirectory: directory,
        cast: createWorldCast(
          snapshot.manifest,
          player,
          snapshot.manifest.characters.filter(row => row.characterId !== player).map(row => row.characterId),
        ),
        world: reader,
        statusSource: source,
      },
      scope.signal,
    )
    const definition = callPluginForValue(context, provider.id, 'definition', () => instance.definition)
    new StatusState(
      definition,
      snapshot.manifest.characters.map(row => row.characterId),
      snapshot.manifest.entities,
      snapshot.manifest.locations.map(row => row.locationId),
    ).validateSnapshot(prefix)
  } finally {
    await scope.close()
  }
}
