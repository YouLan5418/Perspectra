import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { WorldApplication } from '@harness-world/application'
import {
  brandId,
  canonicalizeWorldJson,
  compareWorldText,
  createErrorEnvelope,
  deterministicId,
  type InteractionPackageDescription,
  WorldError,
  type ErrorEnvelope,
  type WorldJsonObject,
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
  | { readonly command: 'validate'; readonly sourceDirectory: string }
  | { readonly command: 'compile'; readonly sourceDirectory: string; readonly outputPath: string }
  | { readonly command: 'inspect'; readonly compiledPackPath: string }
  | { readonly command: 'test'; readonly sourceDirectory: string }
  | { readonly command: 'activate'; readonly compiledPackPath: string; readonly dataDirectory: string; readonly actionGroups?: 'bounded/v1'; readonly interactionsPath?: string }

const USAGE = 'usage: worldpack validate <dir> | compile <dir> --out <worldpack.json> | inspect <worldpack.json> | test <dir> | activate <worldpack.json> --data-dir <dir> [--action-groups | --interactions <catalog.json>]'

function value(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new TypeError(`${name} is required; ${USAGE}`)
  return value
}

export function parseWorldPackCliInvocation(args: readonly string[]): WorldPackCliInvocation {
  const command = args[0]
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

/**
 * The Host's installed interaction packages, which a `worldpack-source/v5` Pack selects from. They are a
 * parameter rather than a constant because only the Host knows what it installs: this library compiles a
 * selection against whatever it is handed, and the process entry hands it the default install.
 */
export interface WorldPackCliOptions {
  readonly interactionPackages?: readonly InteractionPackageDescription[]
}

/** Execute one local creator command and return one canonical JSON line. */
export async function executeWorldPackCli(args: readonly string[], options: WorldPackCliOptions = {}): Promise<string> {
  const invocation = parseWorldPackCliInvocation(args)
  if (invocation.command === 'validate') {
    const pack = await compileWorldPackSource(invocation.sourceDirectory, options.interactionPackages)
    return output({ command: 'validate', status: 'valid', packId: pack.packId, packVersion: pack.packVersion, packHash: pack.packHash })
  }
  if (invocation.command === 'compile') {
    const pack = await compileWorldPackSource(invocation.sourceDirectory, options.interactionPackages)
    const outputPath = resolve(invocation.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, canonicalCompiledWorldPackBytes(pack))
    return output({ command: 'compile', status: 'compiled', outputPath, packId: pack.packId, packVersion: pack.packVersion, packHash: pack.packHash })
  }
  if (invocation.command === 'inspect') {
    return output({ command: 'inspect', status: 'inspected', inspection: await new WorldPackInspector().inspect(invocation.compiledPackPath) })
  }
  if (invocation.command === 'test') {
    return output({ command: 'test', report: await new WorldPackTestRunner()
      .run(invocation.sourceDirectory, options.interactionPackages) })
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
