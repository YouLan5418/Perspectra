import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  executeWorldPackCli,
  parseWorldPackCliInvocation,
} from './creator-cli.ts'

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
    expect(test).toMatchObject({ command: 'test', report: { status: 'passed', assertionIds: [] } })
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
      command: 'test', report: { status: 'passed', assertionIds: [
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
})
