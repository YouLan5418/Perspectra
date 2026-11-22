import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, it, expect } from 'vitest'
import { stageBook, saveStage, stageCandidates } from '../../apps/host/src/editor/stage.ts'
import { stageArtPreview, importStageArt } from '../../apps/host/src/editor/stage-art.ts'
import { exportProject } from '../../apps/host/src/editor/export.ts'
import { saveGraph, EditConflict } from '../../apps/host/src/editor/project.ts'
import { createWorld } from '../../apps/host/src/editor/workspace.ts'
import { loadPackWeb } from '../../apps/host/src/runtime/pack-frontend.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYRkAAAAASUVORK5CYII='
let temp: string, root: string
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'creator-stage-'))
  root = join(temp, 'pack')
})
afterEach(() => rmSync(temp, { recursive: true, force: true, maxRetries: 3 }))
it('authors art, local sheet references, opening and narrow layout for a fresh world and loads the exported frontend', async () => {
  await createWorld(root, { title: '门廊', player: '玩家', companion: '阿林', location: '门廊' })
  const id = 'character:companion'
  const book = await stageBook(root)
  expect(book.config).toEqual({ characters: {} })
  expect(existsSync(join(root, book.file))).toBe(false)
  for (const [kind, owner, path] of [
    ['cover', '', 'cover.png'],
    ['portrait', id, 'frontend/portraits/companion.png'],
    ['background', 'location:start', 'frontend/backgrounds/start.png'],
    ['layer', '', 'frontend/portraits/alin/blink.png'],
  ] as const) {
    expect(importStageArt(root, { kind, id: owner, name: 'alin/blink.png', base64: png })).toEqual({ path })
    expect(stageArtPreview(root, path).data).toBe('data:image/png;base64,' + png)
  }
  expect(() => importStageArt(root, { kind: 'layer', name: '../../escape.png', base64: png })).toThrow()
  expect(() => importStageArt(root, { kind: 'portrait', id: 'missing', base64: png })).toThrow()
  const preview = stageArtPreview(root, 'cover.png')
  const different = Buffer.concat([Buffer.from(png, 'base64'), Buffer.from('art')]).toString('base64')
  expect(() => importStageArt(root, { kind: 'cover', base64: different })).toThrow(EditConflict)
  expect(importStageArt(root, { kind: 'cover', base: preview.base, base64: different })).toEqual({ path: 'cover.png' })
  saveGraph(root, null, {
    key: 'tea',
    title: '泡茶',
    opening: '水开了',
    choices: [
      { id: 'pour', label: '倒茶', condition: { kind: 'always' }, result: '倒好了。', speech: '', next: 'end' },
    ],
  })
  const image = 'portraits/alin/blink.png'
  const config = {
    characters: {
      [id]: {
        face: [0.1, 0.2, 0.2, 0.3],
        sheets: { eyes: { image, columns: 2, rows: 1 } },
        expressions: { blink: { sheet: 'eyes', cell: 1 }, happy: image },
        defaultExpression: 'blink',
        poses: { stand: image },
      },
    },
    autoplay: { activity: 'tea', operation: 'pour' },
  }
  const opts = async (path: string[], dictionary = false) =>
    (await stageCandidates(root, { path, dictionary, config })).options?.map(o => o.id)
  expect(await opts(['characters'], true)).toContain(id)
  expect(await opts(['characters', id, 'expressions', 'blink', 'sheet'])).toEqual(['eyes'])
  expect(await opts(['characters', id, 'defaultExpression'])).toEqual(['blink', 'happy'])
  expect(await opts(['characters', id, 'poses', 'stand'])).toContain(image)
  expect(await opts(['autoplay', 'operation'])).toEqual(['pour'])
  await expect(
    saveStage(root, { base: book.config, config: { ...config, autoplay: { activity: 'tea', operation: 'wrong' } } }),
  ).rejects.toThrow('推进操作')
  await saveStage(root, { base: book.config, config })
  await expect(saveStage(root, { base: book.config, config: book.config })).rejects.toThrow(EditConflict)
  const b = await stageBook(root, { kind: 'components' }),
    components = {
      version: 1,
      components: { inventory: { anchor: 'toolbar', label: '随身', narrow: { order: 3, size: 'large' } } },
    }
  await expect(
    saveStage(root, {
      kind: 'components',
      base: b.config,
      config: { version: 1, components: { inventory: { anchor: 'waist' } } },
    }),
  ).rejects.toThrow('可选')
  await saveStage(root, { kind: 'components', base: b.config, config: components })
  const out = await exportProject(root, join(temp, 'out')),
    web = await loadPackWeb(out.directory)
  expect(web?.stage).toEqual(config)
  expect(web?.components).toEqual(components.components)
  expect(web?.assets.get('/frontend/custom/backgrounds/start.png')?.bytes).toEqual(Buffer.from(png, 'base64'))
  expect(readFileSync(join(out.directory, 'cover.png')).toString('base64')).toBe(different)
  writeFileSync(
    join(root, 'frontend/stage.json'),
    JSON.stringify({ ...config, autoplay: { activity: 'tea', operation: 'other' } }),
  )
  await expect(exportProject(root, join(temp, 'bad'))).rejects.toThrow('推进操作')
})
it('keeps existing framing and native opening references when a creator adds a sheet', async () => {
  cpSync('examples/world-packs/model-girls-sweet-days', root, { recursive: true })
  const b = await stageBook(root),
    actor = 'character:claude',
    id = b.images[0]!
  expect(b.activityMenus.find(a => a.id === 'prologue')?.operations.some(o => o.id === 'next')).toBe(true)
  const chars = b.config.characters as Record<string, object>
  const config = { ...b.config, characters: { ...chars, [actor]: { ...chars[actor], sheets: { eyes: id } } } }
  const next = await saveStage(root, { base: b.config, config })
  expect(next.config).toEqual(config)
  expect((await stageBook(root)).config).toEqual(config)
  expect((await loadPackWeb(root))?.stage?.characters[actor]?.sheets?.eyes).toEqual({ image: id, columns: 4, rows: 4 })
})
