import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { compileWorldPackSource } from '@harness-world/world-pack'
import { PackKnowledge } from '../../desktop/host/pack-knowledge.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// A lorebook entry of three paragraphs, the middle one a single long run, against a 200-character budget.
const LORE =
  '黑海岸是一处研究基地。'.repeat(10) + '\n\n' + '潮汐'.repeat(150) + '\n\n' + '基地的灯在夜里亮着。'.repeat(8)
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'split-knowledge-'))
  roots.push(root)
  const path = join(root, 'pack')
  cpSync(resolve('examples/world-packs/prototype-g1'), path, { recursive: true })
  const write = (name: string, value: unknown) => writeFileSync(join(path, name), JSON.stringify(value))
  writeFileSync(join(path, 'lore.md'), LORE)
  writeFileSync(join(path, 'note.md'), '短设定')
  write('documents.json', {
    schemaVersion: 'worldpack-documents/v2',
    documents: [
      { documentId: 'document:lore', contentRef: 'lore.md', usage: 'world_context', audience: 'public' },
      { documentId: 'document:note', contentRef: 'note.md', usage: 'world_context', audience: 'public' },
    ],
  })
  write('knowledge.json', {
    maximumCharacters: 200,
    entries: [
      { documentId: 'document:lore', keywords: ['黑海岸'], constant: false, priority: 20 },
      { documentId: 'document:note', keywords: [], constant: true, priority: 5 },
    ],
  })
  const source = JSON.parse(readFileSync(join(path, 'worldpack.source.json'), 'utf8'))
  write('worldpack.source.json', {
    ...source,
    documentFiles: ['documents.json'],
    markdownFiles: ['lore.md', 'note.md'],
    assetFiles: [...source.assetFiles, 'knowledge.json'],
  })
  return path
}
const compile = (path: string) =>
  compileWorldPackSource(path, createInstalledInteractionPackages().map(interactionPackageDescription))
const run = (...args: string[]) =>
  spawnSync(process.execPath, [resolve('skills/perspectra-creator/scripts/split-knowledge.mjs'), ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })

it('splits an entry the host would refuse into ordered parts that load and rejoin to the original text', async () => {
  const path = fixture()
  await expect(compile(path).then(pack => PackKnowledge.load(path, pack))).rejects.toThrow('document:lore')

  const preview = run(path, '--dry-run')
  expect(preview.status).toBe(0)
  expect(JSON.parse(preview.stdout)).toMatchObject({ written: false, split: [{ documentId: 'document:lore' }] })
  expect(readFileSync(join(path, 'lore.md'), 'utf8')).toBe(LORE)

  const result = run(path)
  expect(result.status, result.stderr).toBe(0)
  const report = JSON.parse(result.stdout)
  const parts = report.split[0].parts as { documentId: string; contentRef: string; length: number }[]
  expect(parts.length).toBeGreaterThan(2)
  expect(parts[0]).toMatchObject({ documentId: 'document:lore', contentRef: 'lore.md' })
  expect(parts[1]).toMatchObject({ documentId: 'document:lore-part-002', contentRef: 'lore.part-002.md' })
  expect(parts.every(part => part.length <= 200)).toBe(true)
  expect(parts.map(part => readFileSync(join(path, part.contentRef), 'utf8')).join('')).toBe(LORE)
  // Paragraph boundaries are kept where they fit: the first part ends where the first paragraph does.
  expect(readFileSync(join(path, 'lore.md'), 'utf8')).toBe('黑海岸是一处研究基地。'.repeat(10) + '\n\n')

  const pack = await compile(path)
  const knowledge = PackKnowledge.load(path, pack)!
  const entries = JSON.parse(readFileSync(join(path, 'knowledge.json'), 'utf8')).entries as WorldJsonObject[]
  expect(entries.map(entry => entry.documentId)).toEqual([...parts.map(part => part.documentId), 'document:note'])
  expect(entries.slice(0, parts.length).every(entry => JSON.stringify(entry.keywords) === '["黑海岸"]')).toBe(true)
  const selected = knowledge.select({
    character: { characterId: 'character:companion' },
    observations: [{ value: { content: { speech: '黑海岸' } } }],
  }).entries as WorldJsonObject[]
  expect(selected.reduce((sum, row) => sum + String(row.content).length, 0)).toBeLessThanOrEqual(200)
  expect(selected[0]?.documentId).toBe('document:lore')

  // Running again changes nothing: every entry already fits.
  const again = JSON.parse(run(path).stdout)
  expect(again).toMatchObject({ split: [], written: false })
})

it('reports instead of splitting a document used outside knowledge, and refuses a part limit above the budget', () => {
  const path = fixture()
  const characters = JSON.parse(readFileSync(join(path, 'characters.json'), 'utf8'))
  writeFileSync(
    join(path, 'characters.json'),
    // Only the quoted ID matters to the script; this file is not compiled in this test.
    JSON.stringify({ ...characters, portrayal: 'document:lore' }),
  )
  const before = readFileSync(join(path, 'knowledge.json'), 'utf8')
  const result = run(path)
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({
    split: [],
    skipped: [{ documentId: 'document:lore' }],
    written: false,
  })
  expect(readFileSync(join(path, 'knowledge.json'), 'utf8')).toBe(before)
  expect(run(path, '--max', '500').status).toBe(1)
})
