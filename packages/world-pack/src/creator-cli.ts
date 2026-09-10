import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorldApplication } from '@harness-world/application'
import {
  brandId,
  canonicalizeWorldJson,
  compareWorldText,
  createErrorEnvelope,
  deterministicId,
  WorldError,
  type ErrorEnvelope,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  adaptCompiledWorldPack,
  canonicalCompiledWorldPackBytes,
  compileWorldPackSource,
  WorldPackInspector,
  WorldPackTestRunner,
  readCompiledPack,
  readStrictJson,
} from './tooling.ts'
import { WorldPackContractError } from './diagnostics.ts'
import { worldPackErrorCode } from './schema.ts'
import { WORLD_PACK_COMPILED_SCHEMA_VERSION_V3, WORLD_PACK_COMPILED_SCHEMA_VERSION_V4 } from './contracts.ts'

export type WorldPackCliInvocation =
  | { readonly command: 'init'; readonly profile: 'minimal' | 'social' | 'responsive-social' | 'expressive-social'; readonly directory: string }
  | { readonly command: 'validate'; readonly sourceDirectory: string }
  | { readonly command: 'compile'; readonly sourceDirectory: string; readonly outputPath: string }
  | { readonly command: 'inspect'; readonly compiledPackPath: string }
  | { readonly command: 'test'; readonly sourceDirectory: string }
  | { readonly command: 'activate'; readonly compiledPackPath: string; readonly dataDirectory: string; readonly actionGroups?: 'bounded/v1'; readonly interactionsPath?: string }

const USAGE = 'usage: worldpack init --profile minimal|social|responsive-social|expressive-social <dir> | validate <dir> | compile <dir> --out <worldpack.json> | inspect <worldpack.json> | test <dir> | activate <worldpack.json> --data-dir <dir> [--action-groups | --interactions <catalog.json>]'

function value(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new TypeError(`${name} is required; ${USAGE}`)
  return value
}

export function parseWorldPackCliInvocation(args: readonly string[]): WorldPackCliInvocation {
  const command = args[0]
  if (command === 'init' && args.length === 4 && args[1] === '--profile') {
    const profile = args[2]
    if (profile !== 'minimal' && profile !== 'social' && profile !== 'responsive-social' && profile !== 'expressive-social') {
      throw new TypeError(`worldpack profile must be minimal, social, responsive-social, or expressive-social; ${USAGE}`)
    }
    return { command, profile, directory: value(args[3], 'directory') }
  }
  if ((command === 'validate' || command === 'test') && args.length === 2) {
    return { command, sourceDirectory: value(args[1], 'source directory') }
  }
  if (command === 'compile' && args.length === 4 && args[2] === '--out') {
    return { command, sourceDirectory: value(args[1], 'source directory'), outputPath: value(args[3], 'output path') }
  }
  if (command === 'inspect' && args.length === 2) {
    return { command, compiledPackPath: value(args[1], 'compiled Pack path') }
  }
  if (command === 'activate' && args.length === 4 && args[2] === '--data-dir') {
    return { command, compiledPackPath: value(args[1], 'compiled Pack path'), dataDirectory: value(args[3], 'data directory') }
  }
  if (command === 'activate' && args.length === 5 && args[2] === '--data-dir' && args[4] === '--action-groups') {
    return { command, compiledPackPath: value(args[1], 'compiled Pack path'), dataDirectory: value(args[3], 'data directory'), actionGroups: 'bounded/v1' }
  }
  if (command === 'activate' && args.length === 6 && args[2] === '--data-dir' && args[4] === '--interactions') {
    return { command, compiledPackPath: value(args[1], 'compiled Pack path'), dataDirectory: value(args[3], 'data directory'), interactionsPath: value(args[5], 'interaction catalog') }
  }
  throw new TypeError(USAGE)
}

function referenceSocialDirectory(): string {
  return fileURLToPath(new URL('../../../examples/world-packs/tavern-social/', import.meta.url))
}

function assertAbsent(path: string): void {
  if (!existsSync(path)) return
  throw new Error(`scaffold target already exists: ${path}`)
}

async function writeJson(root: string, path: string, document: WorldJsonValue): Promise<void> {
  const target = join(root, ...path.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, canonicalizeWorldJson(document))
}

async function scaffoldMinimal(directory: string): Promise<void> {
  await mkdir(directory)
  const documents: Readonly<Record<string, WorldJsonValue>> = {
    'worldpack.source.json': {
      sourceSchemaVersion: 'worldpack-source/v1', packId: 'pack:minimal-world', packVersion: '1.0.0',
      worldFile: 'world.json', characterFiles: ['characters.json'], locationFiles: ['locations.json'],
      entityFiles: ['entities.json'], sceneFiles: ['scenes.json'], playerSlotFiles: ['player-slots.json'],
      presentationFiles: ['presentation.json'], markdownFiles: [], assetFiles: [], assertionFiles: ['assertions.json'],
    },
    'world.json': { schemaVersion: 'worldpack-world/v1', title: 'Minimal World' },
    'locations.json': { schemaVersion: 'worldpack-locations/v1', locations: [{ locationId: 'location:room', name: 'Room' }] },
    'entities.json': { schemaVersion: 'worldpack-entities/v1', entities: [] },
    'characters.json': { schemaVersion: 'worldpack-characters/v1', characters: [{
      characterId: 'character:player', displayName: 'Player', initialLocationId: 'location:room',
    }] },
    'scenes.json': { schemaVersion: 'worldpack-scenes/v1', scenes: [{
      sceneId: 'scene:room', participantIds: ['character:player'],
    }] },
    'player-slots.json': { schemaVersion: 'worldpack-player-slots/v1', playerSlots: [{
      slotId: 'slot:player', characterId: 'character:player', controlMode: 'manual',
    }] },
    'presentation.json': { schemaVersion: 'worldpack-presentation/v1', locale: 'en', style: 'plain' },
    'assertions.json': { schemaVersion: 'worldpack-assertions/v1', assertions: [] },
  }
  await Promise.all(Object.entries(documents).map(([path, document]) => writeJson(directory, path, document)))
}

async function scaffoldResponsiveSocial(target: string): Promise<void> {
  await cp(fileURLToPath(new URL('../../../examples/world-packs/rainy-road-companions/', import.meta.url)), target, {
    recursive: true, errorOnExist: true, force: false,
  })
  await writeJson(target, 'worldpack.source.json', {
    sourceSchemaVersion: 'worldpack-source/v3', packId: 'pack:responsive-social', packVersion: '1.0.0',
    worldFile: 'world.json', characterFiles: ['characters.json'], locationFiles: ['locations.json'],
    entityFiles: ['entities.json'], sceneFiles: ['scenes.json'], playerSlotFiles: ['player-slots.json'],
    presentationFiles: ['presentation.json'], cognitionFiles: ['cognition.json'], memoryFiles: ['memory.json'],
    documentFiles: [], markdownFiles: [], assetFiles: [], assertionFiles: ['assertions.json'], reactionFile: 'reaction.json',
  })
  await writeJson(target, 'reaction.json', {
    schemaVersion: 'worldpack-reaction/v1', mode: 'responsive', profile: 'responsive/v1',
  })
}

async function scaffoldExpressiveSocial(target: string): Promise<void> {
  await scaffoldResponsiveSocial(target)
  const manifest = JSON.parse(await readFile(join(target, 'worldpack.source.json'), 'utf8')) as WorldJsonObject
  await writeJson(target, 'worldpack.source.json', {
    ...manifest,
    sourceSchemaVersion: 'worldpack-source/v4',
    packId: 'pack:expressive-social',
    manifestationFile: 'manifestation.json',
  })
  await writeJson(target, 'manifestation.json', {
    schemaVersion: 'worldpack-manifestation/v1', mode: 'enabled',
  })
}

async function scaffold(profile: 'minimal' | 'social' | 'responsive-social' | 'expressive-social', targetInput: string): Promise<string> {
  const target = resolve(targetInput)
  assertAbsent(target)
  if (profile === 'minimal') await scaffoldMinimal(target)
  else if (profile === 'social') await cp(referenceSocialDirectory(), target, { recursive: true, errorOnExist: true, force: false })
  else if (profile === 'responsive-social') await scaffoldResponsiveSocial(target)
  else await scaffoldExpressiveSocial(target)
  return target
}

function output(value: WorldJsonObject): string {
  return `${new TextDecoder().decode(canonicalizeWorldJson(value))}\n`
}

function localAddress(packId: string, packVersion: string) {
  return {
    tenantId: brandId('tenant:local-world-pack', 'TenantId'),
    worldId: brandId(`world:${deterministicId('local-world-pack', { packId, packVersion })}`, 'WorldId'),
    branchId: brandId('branch:main', 'BranchId'),
  }
}

async function activate(compiledPackPath: string, dataDirectoryInput: string, actionGroups?: 'bounded/v1', interactionsPath?: string): Promise<WorldJsonObject> {
  const pack = await readCompiledPack(compiledPackPath)
  const dataDirectory = resolve(dataDirectoryInput)
  const databaseDirectory = join(dataDirectory, 'data')
  await mkdir(databaseDirectory, { recursive: true })
  const paths = {
    worldPath: join(databaseDirectory, 'world.sqlite'),
    sessionPath: join(databaseDirectory, 'session.sqlite'),
    memoryPath: join(databaseDirectory, 'memory.sqlite'),
  }
  const address = localAddress(pack.packId, pack.packVersion)
  const compiled = adaptCompiledWorldPack(pack, {
    address,
    principalId: 'principal:local-player',
    sessionId: brandId('session:local-player', 'SessionId'),
    ...(actionGroups === undefined ? {} : { actionGroups }),
    ...(interactionsPath === undefined ? {} : { interactionCatalog: await readStrictJson(interactionsPath) }),
  })
  const application = new WorldApplication(paths)
  try {
    const result = application.activate(compiled)
    const requiredReactionActors = (pack.compiledSchemaVersion === WORLD_PACK_COMPILED_SCHEMA_VERSION_V3
      || pack.compiledSchemaVersion === WORLD_PACK_COMPILED_SCHEMA_VERSION_V4)
      && pack.reaction.mode === 'responsive'
      ? pack.content.characters
        .filter(character => character.lifecycle === 'active' && character.controllerClass !== 'manual')
        .map(character => character.characterId)
        .sort(compareWorldText)
      : []
    return {
      command: 'activate', status: result.status, address, manifestHash: compiled.manifestHash,
      requiredReactionActors, dataDirectory, ...paths,
    }
  } finally {
    await application.close()
  }
}

/** Execute one local creator command and return one canonical JSON line. */
export async function executeWorldPackCli(args: readonly string[]): Promise<string> {
  const invocation = parseWorldPackCliInvocation(args)
  if (invocation.command === 'init') {
    const directory = await scaffold(invocation.profile, invocation.directory)
    return output({ command: 'init', status: 'created', profile: invocation.profile, directory })
  }
  if (invocation.command === 'validate') {
    const pack = await compileWorldPackSource(invocation.sourceDirectory)
    return output({ command: 'validate', status: 'valid', packId: pack.packId, packVersion: pack.packVersion, packHash: pack.packHash })
  }
  if (invocation.command === 'compile') {
    const pack = await compileWorldPackSource(invocation.sourceDirectory)
    const outputPath = resolve(invocation.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, canonicalCompiledWorldPackBytes(pack))
    return output({ command: 'compile', status: 'compiled', outputPath, packId: pack.packId, packVersion: pack.packVersion, packHash: pack.packHash })
  }
  if (invocation.command === 'inspect') {
    return output({ command: 'inspect', status: 'inspected', inspection: await new WorldPackInspector().inspect(invocation.compiledPackPath) })
  }
  if (invocation.command === 'test') {
    return output({ command: 'test', report: await new WorldPackTestRunner().run(invocation.sourceDirectory) })
  }
  return output(await activate(invocation.compiledPackPath, invocation.dataDirectory, invocation.actionGroups, invocation.interactionsPath))
}

/** Normalize creator-facing failures to the same canonical ErrorEnvelope used by other local entrypoints. */
export function worldPackCliErrorEnvelope(error: unknown, args: readonly string[]): ErrorEnvelope {
  if (error instanceof WorldError) return error.envelope
  const correlationId = `worldpack:${args[0] ?? 'unknown'}`
  if (error instanceof WorldPackContractError) {
    const diagnostic = error.diagnostics[0]
    const diagnostics: readonly WorldJsonObject[] = error.diagnostics.map(item => ({
      severity: item.severity, code: item.code, file: item.file,
      jsonPointer: item.jsonPointer, message: item.message,
      ...(item.suggestion === undefined ? {} : { suggestion: item.suggestion }),
    }))
    return createErrorEnvelope({
      errorCode: worldPackErrorCode(diagnostic.code), category: 'admission',
      message: diagnostic.message, retryable: false, correlationId,
      details: { diagnostics },
    })
  }
  return createErrorEnvelope({
    errorCode: 'INVALID_REQUEST', category: 'admission',
    message: error instanceof TypeError ? error.message : 'worldpack command failed',
    retryable: false, correlationId,
  })
}
