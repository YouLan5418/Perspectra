import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// A source template, generated only on request. No dependency on repository code or global tooling.
try {
  const args = process.argv.slice(2)
  if (args.length !== 3) throw new Error('usage: create-world.mjs <new-directory> <pack:id> <title>')
  const [directory, packId, title] = args
  if (!directory || !/^pack:[a-z][a-z0-9-]{0,63}$/u.test(packId) || !title.trim() || title.length > 200) {
    throw new Error(
      'A new directory, pack:id (lowercase letters/digits/hyphens) and a title of 1-200 characters are required',
    )
  }
  const characterIds = ['character:player', 'character:companion']
  const documents = {
    'worldpack.source.json': {
      sourceSchemaVersion: 'worldpack-source/v5',
      packId,
      packVersion: '1.0.0',
      worldFile: 'world.json',
      characterFiles: ['characters.json'],
      locationFiles: ['locations.json'],
      entityFiles: ['entities.json'],
      sceneFiles: ['scenes.json'],
      playerSlotFiles: ['player-slots.json'],
      presentationFiles: ['presentation.json'],
      cognitionFiles: ['cognition.json'],
      memoryFiles: ['memory.json'],
      documentFiles: [],
      markdownFiles: [],
      assetFiles: [],
      assertionFiles: ['assertions.json'],
      reactionFile: 'reaction.json',
      manifestationFile: 'manifestation.json',
      interactionFile: 'interactions.json',
    },
    'world.json': {
      schemaVersion: 'worldpack-world/v1',
      title,
      description: '',
      timeMode: 'TURN_DRIVEN',
      roundQueueLimit: 16,
      coreProfiles: {
        rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
        sceneDecision: { pluginId: 'builtin:scene-decision', version: '2.0.0' },
        agentContext: { pluginId: 'builtin:agent-context', version: '2.0.0' },
        presentation: { profileId: 'builtin:deterministic-presentation', version: '1.0.0' },
      },
      initialFacts: [],
      playerInputPolicy: { version: 'player-intent/v1' },
    },
    'characters.json': {
      schemaVersion: 'worldpack-characters/v3',
      characters: [
        {
          characterId: characterIds[0],
          displayName: '玩家',
          controllerClass: 'manual',
          pronouns: '你',
          initialLocationId: 'location:start',
          portrayal: { summary: '由玩家决定身份与表达。', speakingStyle: '由玩家决定。' },
        },
        {
          characterId: characterIds[1],
          displayName: '同行者',
          controllerClass: 'scripted',
          pronouns: 'ta',
          initialLocationId: 'location:start',
          portrayal: { summary: '有自己的想法，会自己决定如何回应。', speakingStyle: '自然、简短。' },
        },
      ],
    },
    'locations.json': {
      schemaVersion: 'worldpack-locations/v1',
      locations: [{ locationId: 'location:start', name: '起始地点' }],
    },
    'entities.json': { schemaVersion: 'worldpack-entities/v2', entities: [] },
    'scenes.json': {
      schemaVersion: 'worldpack-scenes/v2',
      scenes: [
        { sceneId: 'scene:start', lifecycle: 'active', locationId: 'location:start', participantIds: characterIds },
      ],
    },
    'player-slots.json': {
      schemaVersion: 'worldpack-player-slots/v1',
      playerSlots: [{ slotId: 'slot:player', characterId: characterIds[0], controlMode: 'manual' }],
    },
    'presentation.json': { schemaVersion: 'worldpack-presentation/v1', locale: 'zh-CN', style: 'plain' },
    'cognition.json': {
      schemaVersion: 'worldpack-cognition/v2',
      characters: characterIds.map(characterId => ({
        characterId,
        observations: [],
        goals: [],
      })),
    },
    'memory.json': {
      schemaVersion: 'worldpack-memory/v2',
      characters: characterIds.map(characterId => ({
        characterId,
        profile: 'standard',
        attentionTopics: [],
      })),
    },
    'reaction.json': { schemaVersion: 'worldpack-reaction/v1', mode: 'responsive', profile: 'responsive/v2' },
    'manifestation.json': { schemaVersion: 'worldpack-manifestation/v1', mode: 'enabled' },
    'interactions.json': {
      schemaVersion: 'worldpack-interactions/v1',
      packages: [{ id: 'package:interactions-basic', version: 1 }],
      definitions: [],
    },
    'assertions.json': { schemaVersion: 'worldpack-assertions/v1', assertions: [] },
  }
  const output = resolve(directory)
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output) // EEXIST prevents overwriting any existing work.
  for (const [name, value] of Object.entries(documents)) {
    await writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  }
  process.stdout.write(
    JSON.stringify({ status: 'created', sourceDirectory: output, packId, files: Object.keys(documents) }) + '\n',
  )
} catch (error) {
  process.stderr.write(
    JSON.stringify({ status: 'failed', message: error instanceof Error ? error.message : 'creation failed' }) + '\n',
  )
  process.exitCode = 1
}
