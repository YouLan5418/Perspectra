import type { CharacterId, WorldAddress } from '@harness-world/contracts'
import type { AuthorizedSourceStore } from '@harness-world/memory'

/** This character's captured sources mentioning `text`: what they were allowed to experience. */
export function sourcesMatching(
  store: AuthorizedSourceStore,
  address: WorldAddress,
  characterId: CharacterId,
  text: string,
  throughSeq: number,
) {
  store.catchUp(address, characterId, throughSeq)
  return store.sources(address, characterId, throughSeq).filter(source => source.text.includes(text))
}
