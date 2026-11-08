import type { RulesInstance } from './rules.ts'
import type { SeamProvider } from './world.ts'

/** A pack module a generator makes, as plugins.json would declare it, with its source instead of a file. */
export interface GeneratedStatusModule {
  readonly declaration: { id: string; entry: string; characters: string[]; capabilities: [] }
  readonly source: string
}

/** What a gameplay plugin makes from a pack's config file: ordinary pack content the existing mechanisms load. The
 * status modules join the pack's plugins.json modules, the activities its scripts/activities, and the rules layer
 * sits inside the rule plugins the player chose. Nothing generated is written into the pack. */
export interface GeneratedContent {
  readonly statusModules?: readonly GeneratedStatusModule[]
  readonly activities?: readonly { key: string; source: string }[]
  readonly rules?: SeamProvider<RulesInstance>
}

/** The pack facts a generator may check its config against and use in the text it generates. */
export interface ContentPackFacts {
  characterIds: string[]
  locationIds: string[]
  entityIds: string[]
  /** Where each entity starts: a location, or null when a character holds it. */
  entityLocations: Record<string, string | null>
  /** The pack's first player slot; absent when the pack has none. */
  playerId?: string
  /** Display names of characters and locations. */
  names: Record<string, string>
}

/** Turns one pack config file into pack content. A pack opts in by registering the file in assetFiles with a
 * top-level `plugin: { id, version }` naming this generator. Generation must be deterministic: a save records a hash
 * of the config and everything generated, and refuses to open when it changes. */
export interface ContentGenerator {
  readonly id: string
  readonly version: string
  /** Pack-relative config file, registered in assetFiles, e.g. 'rpg.json'. */
  readonly configFile: string
  /** Parse and generate; throw a TypeError whose message starts with the JSON path on bad config. */
  generate(config: unknown, pack: ContentPackFacts): GeneratedContent
}

/** `ctx.content`: any number of generators, one per id and per config file. Wrap `register` in `ctx.effect()`. */
export interface ContentApi {
  register(generator: ContentGenerator): () => void
  readonly generators: readonly ContentGenerator[]
}
