import { readFileSync } from 'node:fs'

/** The reference rpg.json and the pack ids it refers to, shared by this package's tests. */
export const referenceJson = (): Record<string, any> =>
  JSON.parse(readFileSync(new URL('./reference.rpg.json', import.meta.url), 'utf8'))
export const referencePack = {
  characterIds: ['character:player', 'character:cheng', 'character:other'],
  locationIds: ['location:ruin-1', 'location:ruin-2', 'location:bedroom', 'location:vault', 'location:home'],
  entityIds: ['entity:iron-sword', 'entity:potion', 'entity:potion-2', 'entity:iron-key'],
}
