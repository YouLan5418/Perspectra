import { readFileSync } from 'node:fs'

/** The reference rpg.json and the pack ids it refers to, shared by this package's tests.
 * The ids match the fixture pack at tests/fixtures/rpg-pack. */
export const referenceJson = (): Record<string, any> =>
  JSON.parse(readFileSync(new URL('./reference.rpg.json', import.meta.url), 'utf8'))
export const referencePack = {
  characterIds: ['character:player', 'character:cheng', 'character:aru'],
  locationIds: ['location:living-room', 'location:bedroom', 'location:ruin-1', 'location:ruin-2', 'location:vault'],
  entityIds: ['entity:iron-sword', 'entity:potion', 'entity:potion-2', 'entity:iron-key'],
  entityLocations: {
    'entity:iron-sword': 'location:living-room',
    'entity:potion': 'location:living-room',
    'entity:potion-2': 'location:ruin-2',
    'entity:iron-key': 'location:vault',
  } as Record<string, string | null>,
}
