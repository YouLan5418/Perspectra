import { officialPackPlugins } from '../../../apps/host/src/official-pack-metadata.ts'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createErrorEnvelope, interactionPackageDescription, WorldError } from '@perspectra/sdk/contracts'
import { createBasicInteractionPackage } from '@perspectra/plugins/basic-interactions'
import { executeWorldPackCli, parseWorldPackCliInvocation, worldPackCliErrorEnvelope } from './creator-cli.ts'
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

const source = fileURLToPath(new URL('../../../examples/world-packs/hand-in-hand/', import.meta.url))
const installed = [interactionPackageDescription(createBasicInteractionPackage())]

describe('World Pack creator CLI', () => {
  it.each([
    [['--help'], { command: 'help' }],
    [['help'], { command: 'help' }],
    [['validate', 'pack'], { command: 'validate', sourceDirectory: 'pack' }],
    [
      ['compile', 'pack', '--out', 'pack.json'],
      { command: 'compile', sourceDirectory: 'pack', outputPath: 'pack.json' },
    ],
    [['inspect', 'pack.json'], { command: 'inspect', compiledPackPath: 'pack.json' }],
    [['test', 'pack'], { command: 'test', sourceDirectory: 'pack' }],
    [
      ['activate', 'pack.json', '--data-dir', 'runtime'],
      { command: 'activate', compiledPackPath: 'pack.json', dataDirectory: 'runtime' },
    ],
  ] as const)('parses a supported command %#', (args, expected) => {
    expect(parseWorldPackCliInvocation(args)).toEqual(expected)
  })

  it.each(
    (
      [
        [],
        ['unknown'],
        ['init', '--profile', 'minimal', 'pack'],
        ['validate'],
        ['validate', 'pack', 'extra'],
        ['validate', ''],
        ['test'],
        ['test', ''],
        ['compile', 'pack', '--wrong', 'pack.json'],
        ['compile', '', '--out', 'pack.json'],
        ['inspect'],
        ['inspect', ''],
        ['activate', 'pack.json', '--wrong', 'runtime'],
        ['activate', '', '--data-dir', 'runtime'],
        ['activate', 'pack.json', '--data-dir', 'runtime', '--action-groups'],
        ['activate', 'pack.json', '--data-dir', 'runtime', '--interactions', 'catalog.json'],
      ] as readonly (readonly string[])[]
    ).map(args => [args] as const),
  )('rejects an unsupported command %#', args => {
    expect(() => parseWorldPackCliInvocation(args)).toThrow(TypeError)
  })

  it('explains the automated validation boundary in machine-readable help', async () => {
    expect(parsed(await executeWorldPackCli(['--help']))).toMatchObject({
      command: 'help',
      test: expect.stringContaining('assertionsExecuted is 0'),
      validation: expect.stringContaining('no full Host startup'),
      // A creator Skill that does not see lens in --help concludes the program is too old for simulation.
      lens: expect.stringContaining('lens simulate'),
    })
  })

  it('validates, compiles, inspects, and tests the current v5 Pack', async () => {
    const root = await temporaryRoot()
    const artifact = join(root, 'hand-in-hand.worldpack.json')
    expect(
      parsed(
        await executeWorldPackCli(['validate', source], {
          interactionPackages: installed,
          content: officialPackPlugins,
        }),
      ),
    ).toMatchObject({
      command: 'validate',
      status: 'valid',
      packId: 'pack:hand-in-hand',
    })
    expect(
      parsed(
        await executeWorldPackCli(['test', source], { interactionPackages: installed, content: officialPackPlugins }),
      ),
    ).toMatchObject({
      command: 'test',
      report: { assertionIds: ['assertion:companion-knows-the-umbrella'] },
    })
    expect(
      parsed(
        await executeWorldPackCli(['compile', source, '--out', artifact], {
          interactionPackages: installed,
          content: officialPackPlugins,
        }),
      ),
    ).toMatchObject({ command: 'compile', status: 'compiled', outputPath: artifact })
    expect(parsed(await executeWorldPackCli(['inspect', artifact]))).toMatchObject({
      command: 'inspect',
      status: 'inspected',
      inspection: { packId: 'pack:hand-in-hand' },
    })
    expect(
      parsed(
        await executeWorldPackCli(['activate', artifact, '--data-dir', join(root, 'runtime')], {
          interactionImplementations: [createBasicInteractionPackage()],
        }),
      ),
    ).toMatchObject({ command: 'activate', status: 'activated' })
    await expect(executeWorldPackCli(['validate', source])).rejects.toThrow(/is not installed by the Host/u)

    const document = JSON.parse(await readFile(artifact, 'utf8')) as {
      compiledSchemaVersion: string
      content: { world: { title: string } }
    }
    document.compiledSchemaVersion = 'worldpack/v4'
    await writeFile(artifact, JSON.stringify(document))
    await expect(executeWorldPackCli(['inspect', artifact])).rejects.toThrow(/must be worldpack\/v5/u)
    document.compiledSchemaVersion = 'worldpack/v5'
    document.content.world.title = 'Tampered'
    await writeFile(artifact, JSON.stringify(document))
    await expect(executeWorldPackCli(['inspect', artifact])).rejects.toThrow(
      /does not match the compiled v5 envelope content/u,
    )
  })

  it('rejects an unknown source version and invalid UTF-8', async () => {
    const root = await temporaryRoot()
    const unknown = join(root, 'unknown')
    await cp(source, unknown, { recursive: true })
    const path = join(unknown, 'worldpack.source.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...manifest, sourceSchemaVersion: 'worldpack-source/v99' }))
    await expect(
      executeWorldPackCli(['validate', unknown], { interactionPackages: installed, content: officialPackPlugins }),
    ).rejects.toThrow(/must be worldpack-source\/v5/u)

    const invalid = join(root, 'invalid.worldpack.json')
    await writeFile(invalid, new Uint8Array([0xc3, 0x28]))
    await expect(executeWorldPackCli(['inspect', invalid])).rejects.toThrow('valid UTF-8')
  })

  it('normalizes contract, world, usage and unexpected errors without leaking internals', () => {
    let contract: unknown
    try {
      failWorldPackContract(
        'PACK_REFERENCE_INVALID',
        'characters.json',
        '/0',
        'missing location',
        'declare the location first',
      )
    } catch (error: unknown) {
      contract = error
    }
    expect(worldPackCliErrorEnvelope(contract, ['validate'])).toMatchObject({
      schemaVersion: 1,
      errorCode: 'PACK_REFERENCE_INVALID',
      category: 'admission',
      message: 'missing location',
      correlationId: 'worldpack:validate',
      details: {
        diagnostics: [{ file: 'characters.json', jsonPointer: '/0', suggestion: 'declare the location first' }],
      },
    })
    const envelope = createErrorEnvelope({
      errorCode: 'PACK_VERSION_DIVERGED',
      category: 'admission',
      message: 'version conflict',
      retryable: false,
      correlationId: 'worldpack:activate',
    })
    expect(worldPackCliErrorEnvelope(new WorldError(envelope), ['activate'])).toBe(envelope)
    expect(worldPackCliErrorEnvelope(new TypeError('usage detail'), [])).toMatchObject({
      errorCode: 'INVALID_REQUEST',
      message: 'usage detail',
      correlationId: 'worldpack:unknown',
    })
    expect(worldPackCliErrorEnvelope(new Error('D:\\private\\internal.sqlite'), ['activate'])).toMatchObject({
      errorCode: 'INVALID_REQUEST',
      message: 'worldpack command failed',
    })
  })
})

describe('worldpack validate and rpg.json', () => {
  const rpgSource = fileURLToPath(new URL('../../../tests/fixtures/rpg-pack/', import.meta.url))
  const content = officialPackPlugins

  it('validate reports an rpg.json error with its JSON path', async () => {
    const root = await temporaryRoot()
    await cp(rpgSource, root, { recursive: true })
    const config = JSON.parse(await readFile(join(root, 'rpg.json'), 'utf8'))
    config.maps[0].exits[0].to = 'location:nowhere'
    await writeFile(join(root, 'rpg.json'), JSON.stringify(config))
    const failure = await executeWorldPackCli(['validate', root], { interactionPackages: installed, content }).then(
      () => undefined,
      (error: unknown) => error as Error,
    )
    expect(failure).toMatchObject({ code: 'PACK_COMPOSITION_INVALID' })
    expect(failure!.message).toMatch(/rpg\.json.*maps\[0\]\.exits\[0\]\.to/u)
    expect(worldPackCliErrorEnvelope(failure, ['validate', root]).message).toBe(failure!.message)
  })

  it('validates explicit selections and never silently ignores missing gameplay', async () => {
    const root = await temporaryRoot()
    await cp(rpgSource, root, { recursive: true })
    expect(
      parsed(await executeWorldPackCli(['validate', root], { interactionPackages: installed, content })),
    ).toMatchObject({ status: 'valid' })
    await expect(
      executeWorldPackCli(['validate', root], { interactionPackages: installed, content: [] }),
    ).rejects.toThrow('official-rpg')
    await writeFile(join(root, 'rpg.json'), '{')
    await expect(executeWorldPackCli(['validate', root], { interactionPackages: installed, content })).rejects.toThrow(
      'invalid JSON',
    )
    const manifest = JSON.parse(await readFile(join(root, 'worldpack.source.json'), 'utf8'))
    manifest.plugins = {}
    await writeFile(join(root, 'worldpack.source.json'), JSON.stringify(manifest))
    expect(
      parsed(await executeWorldPackCli(['validate', root], { interactionPackages: installed, content: [] })),
    ).toMatchObject({ status: 'valid' })
  })
})
