import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createErrorEnvelope,
  WorldError,
} from '@harness-world/contracts'
import {
  executeWorldPackCli,
  parseWorldPackCliInvocation,
  worldPackCliErrorEnvelope,
} from './creator-cli.ts'
import { failWorldPackContract } from './diagnostics.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'world-pack-cli-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function parsed(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>
}

describe('World Pack creator CLI', () => {
  it.each([
    [['init', '--profile', 'minimal', 'pack'], { command: 'init', profile: 'minimal', directory: 'pack' }],
    [['init', '--profile', 'social', 'pack'], { command: 'init', profile: 'social', directory: 'pack' }],
    [['init', '--profile', 'responsive-social', 'pack'], { command: 'init', profile: 'responsive-social', directory: 'pack' }],
    [['init', '--profile', 'expressive-social', 'pack'], { command: 'init', profile: 'expressive-social', directory: 'pack' }],
    [['validate', 'pack'], { command: 'validate', sourceDirectory: 'pack' }],
    [['compile', 'pack', '--out', 'pack.json'], { command: 'compile', sourceDirectory: 'pack', outputPath: 'pack.json' }],
    [['inspect', 'pack.json'], { command: 'inspect', compiledPackPath: 'pack.json' }],
    [['test', 'pack'], { command: 'test', sourceDirectory: 'pack' }],
    [['activate', 'pack.json', '--data-dir', 'runtime'], { command: 'activate', compiledPackPath: 'pack.json', dataDirectory: 'runtime' }],
  ] as const)('parses the exact local command surface %#', (args, expected) => {
    expect(parseWorldPackCliInvocation(args)).toEqual(expected)
  })

  it.each(([
    [], ['unknown'],
    ['init', '--profile', 'large', 'pack'], ['init', '--wrong', 'minimal', 'pack'], ['init', '--profile', 'minimal', ''],
    ['validate'], ['validate', 'pack', 'extra'], ['validate', ''],
    ['test'], ['test', ''],
    ['compile', 'pack', '--wrong', 'pack.json'], ['compile', '', '--out', 'pack.json'], ['compile', 'pack', '--out', ''],
    ['inspect'], ['inspect', ''],
    ['activate', 'pack.json', '--wrong', 'runtime'], ['activate', '', '--data-dir', 'runtime'], ['activate', 'pack.json', '--data-dir', ''],
  ] as readonly (readonly string[])[]).map(args => [args] as const))('rejects malformed invocation %#', (args) => {
    expect(() => parseWorldPackCliInvocation(args)).toThrow(TypeError)
  })

  it('runs the complete minimal author workflow and reopens activation idempotently', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'minimal')
    const artifact = join(root, 'dist', 'minimal.worldpack.json')
    const runtime = join(root, 'runtime')

    expect(parsed(await executeWorldPackCli(['init', '--profile', 'minimal', source]))).toMatchObject({
      command: 'init', status: 'created', profile: 'minimal', directory: source,
    })
    expect(parsed(await executeWorldPackCli(['validate', source]))).toMatchObject({
      command: 'validate', status: 'valid', packId: 'pack:minimal-world', packVersion: '1.0.0',
    })
    const test = parsed(await executeWorldPackCli(['test', source]))
    expect(test).toMatchObject({ command: 'test', report: { status: 'compiled', assertionsExecuted: 0, assertionIds: [] } })
    expect(parsed(await executeWorldPackCli(['compile', source, '--out', artifact]))).toMatchObject({
      command: 'compile', status: 'compiled', outputPath: artifact,
    })
    expect((await readFile(artifact)).byteLength).toBeGreaterThan(0)
    expect(parsed(await executeWorldPackCli(['inspect', artifact]))).toMatchObject({
      command: 'inspect', status: 'inspected',
      inspection: { title: 'Minimal World', characterCount: 1, locationCount: 1, entityCount: 0, assertionCount: 0 },
    })
    expect(parsed(await executeWorldPackCli(['activate', artifact, '--data-dir', runtime]))).toMatchObject({
      command: 'activate', status: 'activated', dataDirectory: runtime,
    })
    expect(parsed(await executeWorldPackCli(['activate', artifact, '--data-dir', runtime]))).toMatchObject({
      command: 'activate', status: 'already_active', dataDirectory: runtime,
    })
    expect((await readFile(join(runtime, 'data', 'world.sqlite'))).byteLength).toBeGreaterThan(0)

    await writeFile(join(source, 'world.json'), JSON.stringify({
      schemaVersion: 'worldpack-world/v1', title: 'Changed without a Pack version bump',
    }))
    const divergentArtifact = join(root, 'dist', 'divergent.worldpack.json')
    await executeWorldPackCli(['compile', source, '--out', divergentArtifact])
    await expect(executeWorldPackCli(['activate', divergentArtifact, '--data-dir', runtime]))
      .rejects.toMatchObject({ envelope: { errorCode: 'PACK_VERSION_DIVERGED' } })
  })

  it('scaffolds and validates the frozen social reference Pack', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'social')
    expect(parsed(await executeWorldPackCli(['init', '--profile', 'social', source]))).toMatchObject({
      command: 'init', status: 'created', profile: 'social', directory: source,
    })
    expect(parsed(await executeWorldPackCli(['validate', source]))).toMatchObject({
      command: 'validate', status: 'valid', packId: 'pack:tavern-social',
      packHash: 'sha256:515dd41a737d28139548364eefe3c7211c94a0f3a8b43bead4950a32f2f12c6d',
    })
    expect(parsed(await executeWorldPackCli(['test', source]))).toMatchObject({
      command: 'test', report: { status: 'compiled', assertionsExecuted: 0, assertionIds: [
        'assertion:alice-mistake-is-character-scoped',
        'assertion:bob-secret-hidden-from-alice',
        'assertion:bob-secret-hidden-from-visitor',
        'assertion:fork-future-isolated',
        'assertion:recall-differs-by-character',
        'assertion:replay-stable',
        'assertion:reported-speech-does-not-entail',
        'assertion:scene-departure-unschedules',
      ] },
    })
    await expect(executeWorldPackCli(['init', '--profile', 'social', source]))
      .rejects.toThrow('scaffold target already exists')
  })

  it('runs the explicit v2 Pack through the same creator workflow', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'rainy-road')
    const artifact = join(root, 'rainy-road.worldpack.json')
    const runtime = join(root, 'runtime')
    await cp(fileURLToPath(new URL('../../../examples/world-packs/rainy-road-companions/', import.meta.url)), source, { recursive: true })

    expect(parsed(await executeWorldPackCli(['validate', source]))).toMatchObject({
      command: 'validate', status: 'valid', packId: 'pack:rainy-road-companions',
      packHash: 'sha256:76098df56b8a9169861f5094159d41ee7d6ef26c018339c8017615eb4686e0b8',
    })
    expect(parsed(await executeWorldPackCli(['test', source]))).toMatchObject({
      command: 'test', report: {
        status: 'compiled', assertionsExecuted: 0,
        assertionIds: [
          'assertion:alice-mistake-remains-subjective',
          'assertion:bob-secret-hidden-from-alice',
          'assertion:bob-secret-hidden-from-player',
          'assertion:trust-and-distrust-coexist',
        ],
      },
    })
    expect(parsed(await executeWorldPackCli(['compile', source, '--out', artifact]))).toMatchObject({
      command: 'compile', status: 'compiled', outputPath: artifact,
    })
    expect(parsed(await executeWorldPackCli(['inspect', artifact]))).toMatchObject({
      command: 'inspect', status: 'inspected', inspection: {
        title: '雨夜同行', characterCount: 3, locationCount: 2, entityCount: 1, assertionCount: 4,
      },
    })
    expect(parsed(await executeWorldPackCli(['activate', artifact, '--data-dir', runtime]))).toMatchObject({
      command: 'activate', status: 'activated', dataDirectory: runtime,
    })
    expect(parsed(await executeWorldPackCli(['activate', artifact, '--data-dir', runtime]))).toMatchObject({
      command: 'activate', status: 'already_active', dataDirectory: runtime,
    })
  })

  it('scaffolds, compiles, inspects, tests, and activates an explicit responsive v3 Pack', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'responsive-social')
    const artifact = join(root, 'responsive-social.worldpack.json')
    const runtime = join(root, 'runtime')
    expect(parsed(await executeWorldPackCli(['init', '--profile', 'responsive-social', source]))).toMatchObject({
      command: 'init', status: 'created', profile: 'responsive-social', directory: source,
    })
    expect(JSON.parse(await readFile(join(source, 'reaction.json'), 'utf8'))).toEqual({
      schemaVersion: 'worldpack-reaction/v1', mode: 'responsive', profile: 'responsive/v1',
    })
    expect(parsed(await executeWorldPackCli(['validate', source]))).toMatchObject({
      command: 'validate', status: 'valid', packId: 'pack:responsive-social',
    })
    expect(parsed(await executeWorldPackCli(['test', source]))).toMatchObject({
      command: 'test', report: { status: 'compiled', assertionsExecuted: 0 },
    })
    await executeWorldPackCli(['compile', source, '--out', artifact])
    expect(parsed(await executeWorldPackCli(['inspect', artifact]))).toMatchObject({
      command: 'inspect', status: 'inspected', inspection: {
        title: '雨夜同行', reaction: {
          mode: 'responsive', profile: 'responsive/v1', maximumWaves: 3, maximumNpcCalls: 8,
          maximumCallsPerCharacter: 2, maximumActionsPerCall: 1,
          maximumNpcSpeechesPerPlayerInput: 8, deadlineMs: 30_000,
        },
      },
    })
    expect(parsed(await executeWorldPackCli(['activate', artifact, '--data-dir', runtime]))).toMatchObject({
      command: 'activate', status: 'activated', requiredReactionActors: ['character:alice', 'character:bob'],
    })
    expect(parsed(await executeWorldPackCli(['activate', artifact, '--data-dir', runtime]))).toMatchObject({
      command: 'activate', status: 'already_active', requiredReactionActors: ['character:alice', 'character:bob'],
    })
  })

  it('scaffolds, compiles, inspects, and activates an expressive v4 Pack', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'expressive-social')
    const artifact = join(root, 'expressive-social.worldpack.json')
    const runtime = join(root, 'runtime')
    expect(parsed(await executeWorldPackCli(['init', '--profile', 'expressive-social', source]))).toMatchObject({
      command: 'init', status: 'created', profile: 'expressive-social', directory: source,
    })
    expect(JSON.parse(await readFile(join(source, 'manifestation.json'), 'utf8'))).toEqual({
      mode: 'enabled', schemaVersion: 'worldpack-manifestation/v1',
    })
    expect(parsed(await executeWorldPackCli(['validate', source]))).toMatchObject({
      command: 'validate', status: 'valid', packId: 'pack:expressive-social',
    })
    await executeWorldPackCli(['compile', source, '--out', artifact])
    expect(parsed(await executeWorldPackCli(['inspect', artifact]))).toMatchObject({
      command: 'inspect', status: 'inspected', inspection: {
        title: '雨夜同行', manifestation: { schemaVersion: 'worldpack-manifestation/v1', mode: 'enabled' },
        reaction: { mode: 'responsive', profile: 'responsive/v1' },
      },
    })
    expect(parsed(await executeWorldPackCli(['activate', artifact, '--data-dir', runtime]))).toMatchObject({
      command: 'activate', status: 'activated', requiredReactionActors: ['character:alice', 'character:bob'],
    })
  })

  it('fails closed for invalid UTF-8 and a content-diverged compiled artifact', async () => {
    const root = await temporaryRoot()
    const invalid = join(root, 'invalid.worldpack.json')
    await writeFile(invalid, new Uint8Array([0xc3, 0x28]))
    await expect(executeWorldPackCli(['inspect', invalid])).rejects.toThrow('valid UTF-8')

    const source = join(root, 'minimal')
    const artifact = join(root, 'minimal.worldpack.json')
    await executeWorldPackCli(['init', '--profile', 'minimal', source])
    await executeWorldPackCli(['compile', source, '--out', artifact])
    const document = JSON.parse(await readFile(artifact, 'utf8')) as { content: { world: { title: string } } }
    document.content.world.title = 'Tampered'
    await writeFile(artifact, JSON.stringify(document))
    await expect(executeWorldPackCli(['inspect', artifact])).rejects.toThrow('does not match the compiled envelope content')
  })

  it('fails closed for an unknown source schema and exposes a disabled v3 policy without implied limits changes', async () => {
    const root = await temporaryRoot()
    const unknown = join(root, 'unknown')
    await executeWorldPackCli(['init', '--profile', 'minimal', unknown])
    const sourceManifest = JSON.parse(await readFile(join(unknown, 'worldpack.source.json'), 'utf8')) as Record<string, unknown>
    await writeFile(join(unknown, 'worldpack.source.json'), JSON.stringify({ ...sourceManifest, sourceSchemaVersion: 'worldpack-source/v99' }))
    await expect(executeWorldPackCli(['validate', unknown])).rejects.toThrow('source schema version is unsupported')

    const responsive = join(root, 'disabled')
    const artifact = join(root, 'disabled.worldpack.json')
    await executeWorldPackCli(['init', '--profile', 'responsive-social', responsive])
    await writeFile(join(responsive, 'reaction.json'), JSON.stringify({ schemaVersion: 'worldpack-reaction/v1', mode: 'disabled' }))
    await executeWorldPackCli(['compile', responsive, '--out', artifact])
    expect(parsed(await executeWorldPackCli(['inspect', artifact]))).toMatchObject({
      inspection: { reaction: { mode: 'disabled', profile: null } },
    })
  })

  it('normalizes contract, world, usage and unexpected errors without leaking internals', () => {
    let contract: unknown
    try {
      failWorldPackContract(
        'PACK_REFERENCE_INVALID', 'characters.json', '/0', 'missing location', 'declare the location first',
      )
    } catch (error: unknown) {
      contract = error
    }
    expect(worldPackCliErrorEnvelope(contract, ['validate'])).toMatchObject({
      schemaVersion: 1, errorCode: 'PACK_REFERENCE_INVALID', category: 'admission',
      message: 'missing location', correlationId: 'worldpack:validate',
      details: { diagnostics: [{
        file: 'characters.json', jsonPointer: '/0', suggestion: 'declare the location first',
      }] },
    })
    let contractWithoutSuggestion: unknown
    try {
      failWorldPackContract('PACK_SOURCE_INVALID', 'world.json', '', 'invalid source')
    } catch (error: unknown) {
      contractWithoutSuggestion = error
    }
    expect(worldPackCliErrorEnvelope(contractWithoutSuggestion, ['validate'])).toMatchObject({
      details: { diagnostics: [{ message: 'invalid source' }] },
    })

    const envelope = createErrorEnvelope({
      errorCode: 'PACK_VERSION_DIVERGED', category: 'admission', message: 'version conflict',
      retryable: false, correlationId: 'worldpack:activate',
    })
    expect(worldPackCliErrorEnvelope(new WorldError(envelope), ['activate'])).toBe(envelope)
    expect(worldPackCliErrorEnvelope(new TypeError('usage detail'), [])).toMatchObject({
      errorCode: 'INVALID_REQUEST', message: 'usage detail', correlationId: 'worldpack:unknown',
    })
    expect(worldPackCliErrorEnvelope(new Error('D:\\private\\internal.sqlite'), ['activate'])).toMatchObject({
      errorCode: 'INVALID_REQUEST', message: 'worldpack command failed',
    })
  })
})
