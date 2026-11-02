import type { WorldAddress, WorldJsonObject } from '@harness-world/contracts'
import type { WorldReader } from '@harness-world/plugin-sdk'
import { AuthorizedSourceStore } from '@harness-world/memory'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { dirname, join } from 'node:path'

/** The read access plugins get. Each call opens its own handle, so none outlives the call. */
export function createWorldReader(worldPath: string, address: WorldAddress): WorldReader {
  const withStore = <T>(read: (store: WorldStore) => T): T => {
    const store = new WorldStore(worldPath)
    try {
      return read(store)
    } finally {
      store.close()
    }
  }
  return {
    readEvents: (afterSeq, throughSeq, types) =>
      withStore(store =>
        store.readEventsRange(address, afterSeq, throughSeq, types === undefined ? undefined : [...types]),
      ) as unknown as readonly WorldJsonObject[],
    characterObservations: (characterId, throughSeq) =>
      withStore(store =>
        new CharacterViewBuilder(store)
          .rebuildAt(address, characterId, throughSeq)
          .observations.map(observation => observation.value as WorldJsonObject),
      ),
    head: () =>
      withStore(store => {
        const { headSeq, tick } = store.head(address)
        return { headSeq, tick }
      }),
    eventTicks: throughSeq => withStore(store => store.readEventTicks(address, throughSeq)),
    authorizedSources: (characterId, throughSeq, options) =>
      withStore(store => {
        const sources = new AuthorizedSourceStore(join(dirname(worldPath), 'memory.sqlite'), store)
        try {
          if (options?.catchUp !== false) sources.catchUp(address, characterId, throughSeq, 'authorized-sources')
          return sources.sources(address, characterId, throughSeq)
        } finally {
          sources.close()
        }
      }),
  }
}
