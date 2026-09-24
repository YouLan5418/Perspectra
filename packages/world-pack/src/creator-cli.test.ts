import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createErrorEnvelope,
  interactionPackageDescription,
  WorldError,
} from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
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

const source = fileURLToPath(new URL('../../../examples/world-packs/hand-in-hand/', import.meta.url))
const installed = [interactionPackageDescription(createBasicInteractionPackage())]

describe('World Pack creator CLI', () => {
  it.each([
    [['validate', 'pack'], { command: 'validate', sourceDirectory: 'pack' }],
    [['compile', 'pack', '--out', 'pack.json'], { command: 'compile', sourceDirectory: 'pack', outputPath: 'pack.json' }],
    [['inspect', 'pack.json'], { command: 'inspect', compiledPackPath: 'pack.json' }],
    [['test', 'pack'], { command: 'test', sourceDirectory: 'pack' }],
    [['activate', 'pack.json', '--data-dir', 'runtime'], { command: 'activate', compiledPackPath: 'pack.json', dataDirectory: 'runtime' }],
  ] as const)('parses a supported command %#', (args, expected) => {
    expect(parseWorldPackCliInvocation(args)).toEqual(expected)
  })

  it.each(([
    [], ['unknown'], ['init', '--profile', 'minimal', 'pack'],
    ['validate'], ['validate', 'pack', 'extra'], ['validate', ''],
    ['test'], ['test', ''],
    ['compile', 'pack', '--wrong', 'pack.json'], ['compile', '', '--out', 'pack.json'],
    ['inspect'], ['inspect', ''],
    ['activate', 'pack.json', '--wrong', 'runtime'], ['activate', '', '--data-dir', 'runtime'],
  ] as readonly (readonly string[])[]).map(args => [args] as const))('rejects an unsupported command %#', args => {
    expect(() => parseWorldPackCliInvocation(args)).toThrow(TypeError)
  })

  it('validates, compiles, inspects, and tests the current v5 Pack', async () => {
    const root = await temporaryRoot()
    const artifact = join(root, 'hand-in-hand.worldpack.json')
    expect(parsed(await executeWorldPackCli(['validate', source], { interactionPackages: installed })))
      .toMatchObject({ command: 'validate', status: 'valid', packId: 'pack:hand-in-hand' })
    expect(parsed(await executeWorldPackCli(['test', source], { interactionPackages: installed })))
      .toMatchObject({ command: 'test', report: { assertionIds: ['assertion:companion-knows-the-umbrella'] } })
    expect(parsed(await executeWorldPackCli(['compile', source, '--out', artifact], { interactionPackages: installed })))
      .toMatchObject({ command: 'compile', status: 'compiled', outputPath: artifact })
    expect(parsed(await executeWorldPackCli(['inspect', artifact])))
      .toMatchObject({ command: 'inspect', status: 'inspected', inspection: { packId: 'pack:hand-in-hand' } })
    await expect(executeWorldPackCli(['validate', source])).rejects.toThrow(/is not installed by the Host/u)

    const document = JSON.parse(await readFile(artifact, 'utf8')) as { content: { world: { title: string } } }
    document.content.world.title = 'Tampered'
    await writeFile(artifact, JSON.stringify(document))
    await expect(executeWorldPackCli(['inspect', artifact])).rejects.toThrow(/does not match the compiled v5 envelope content/u)
  })

  it('rejects an unknown source version and invalid UTF-8', async () => {
    const root = await temporaryRoot()
    const unknown = join(root, 'unknown')
    await cp(source, unknown, { recursive: true })
    const path = join(unknown, 'worldpack.source.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...manifest, sourceSchemaVersion: 'worldpack-source/v99' }))
    await expect(executeWorldPackCli(['validate', unknown], { interactionPackages: installed }))
      .rejects.toThrow('source schema version is unsupported')

    const invalid = join(root, 'invalid.worldpack.json')
    await writeFile(invalid, new Uint8Array([0xc3, 0x28]))
    await expect(executeWorldPackCli(['inspect', invalid])).rejects.toThrow('valid UTF-8')
  })

  it('normalizes contract, world, usage and unexpected errors without leaking internals', () => {
    let contract: unknown
    try {
      failWorldPackContract('PACK_REFERENCE_INVALID', 'characters.json', '/0', 'missing location', 'declare the location first')
    } catch (error: unknown) {
      contract = error
    }
    expect(worldPackCliErrorEnvelope(contract, ['validate'])).toMatchObject({
      schemaVersion: 1, errorCode: 'PACK_REFERENCE_INVALID', category: 'admission',
      message: 'missing location', correlationId: 'worldpack:validate',
      details: { diagnostics: [{ file: 'characters.json', jsonPointer: '/0', suggestion: 'declare the location first' }] },
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
