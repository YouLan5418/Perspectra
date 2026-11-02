import type { WorldAddress, WorldJsonObject } from '@harness-world/contracts'
import type { WorldReader } from '@harness-world/plugin-sdk'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'

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
  }
}
