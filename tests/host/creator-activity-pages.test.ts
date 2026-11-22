import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { activityPages, importActivityPageFile, saveActivityPage } from '../../apps/host/src/editor/activity-pages.ts'
import { previewActivityPage } from '../../apps/host/src/editor/activity-page-preview.ts'
import { exportProject } from '../../apps/host/src/editor/export.ts'
import { EditConflict } from '../../apps/host/src/editor/project.ts'
import { validateExportedPages } from '../../apps/host/src/runtime/activity-page-catalog.ts'
import { loadPackWeb } from '../../apps/host/src/runtime/pack-frontend.ts'

import { activityPageCandidates } from '../../apps/host/src/editor/activity-page-candidates.ts'

const key = 'read-note'
const original = JSON.parse(readFileSync('examples/world-packs/porch-note/frontend/activity-pages.json', 'utf8'))[
  key
] as import('../../apps/host/src/runtime/activity-pages.ts').ActivityPage & { css: string }
let temp: string, source: string
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'perspectra-page-test-'))
  source = join(temp, 'source')
  cpSync('examples/world-packs/porch-note', source, { recursive: true })
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))

it('discovers existing activity keys, preserves imported bytes and resolves bindings per activity', async () => {
  expect((await activityPages('examples/world-packs/hill-ruins')).activities).toContainEqual({
    key: 'rpg-map-ruin-1',
    title: '遗迹一层',
  })
  const book = await activityPages(source)
  expect(book.activities).toContainEqual({ key, title: '读便笺' })
  expect(book.bindings[key]).toEqual(original)
  const html = 'activities/reading/letter.html',
    css = 'activities/reading/纸张.css'
  const files = [
    { path: html, text: '<link rel="stylesheet" href="纸张.css"><main data-activity-actions></main>' },
    { path: css, text: 'body { color: navy; }' },
  ]
  for (const file of files) {
    importActivityPageFile(source, file)
    expect(importActivityPageFile(source, file)).toEqual({ path: file.path })
  }
  await saveActivityPage(source, { key, base: original, page: { html } })
  await expect(saveActivityPage(source, { key, base: original, page: { html, css } })).rejects.toBeInstanceOf(
    EditConflict,
  )
  await saveActivityPage(source, { key, base: { html }, page: { html, css } })
  const { directory } = await exportProject(source, join(temp, 'export'))
  const web = await loadPackWeb(directory)
  expect(web?.activityPages?.[key]).toEqual({ html, css })
  expect(web?.page).toBeUndefined()
  for (const f of files) expect(readFileSync(join(directory, 'frontend', f.path), 'utf8')).toBe(f.text)
  await saveActivityPage(source, { key, base: { html, css }, page: null })
  expect((await activityPages(source)).bindings).toEqual({})
})
it('checks missing resources and stale references, and permits removing an obsolete binding', async () => {
  await expect(
    saveActivityPage(source, { key, base: original, page: { ...original, css: 'activities/missing.css' } }),
  ).rejects.toThrow(/找不到页面资源/)
  expect(() => importActivityPageFile(source, { path: 'activities/../outside.css', text: '' })).toThrow()
  writeFileSync(join(source, 'frontend/activity-pages.json'), JSON.stringify({ obsolete: original }))
  await expect(validateExportedPages(source)).rejects.toThrow(/活动不存在/)
  await saveActivityPage(source, { key: 'obsolete', base: original, page: null })
  await expect(validateExportedPages(source)).resolves.toBeUndefined()
})
it('discovers RPG declarations before a trial and a stable projected HP field in the encounter', async () => {
  const rpg = 'examples/world-packs/hill-ruins',
    request = { key: 'rpg-map-ruin-1' }
  const menu = await activityPageCandidates(rpg, request)
  expect(menu.sampled).toBe(false)
  expect(menu.operations).toContainEqual({ id: 'activity:skill', label: '使用技能' })
  expect(menu.fields[0]?.options).toContain('fighting')
  const sampled = await activityPageCandidates(rpg, {
    ...request,
    trial: true,
    scenes: { 'character:player': 'scene:ruin-1', 'character:cheng': 'scene:ruin-1' },
  })
  expect(sampled.sampled).toBe(true)
  expect(sampled.fields.find(v => v.label.includes('遗迹守卫') && 'relativeTo' in v.field)).toMatchObject({
    field: { source: 'stage', path: ['units', { by: 'id', is: expect.any(String) }, 'hp'], relativeTo: 'maxHp' },
  })
})
it('validates operation and image references and exports conditional assets byte for byte', async () => {
  const image = 'activities/letter.svg'
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><desc>信封</desc></svg>')
  const rule = { field: { source: 'phase' }, compare: 'eq', value: 'choice', effect: { kind: 'image', value: image } }
  const page = { ...original, elements: [{ id: 'leave', operation: 'activity:leave', rules: [rule] }] }
  const save = (p: unknown) => saveActivityPage(source, { key, base: original, page: p })
  await expect(save(page)).rejects.toThrow(/找不到页面资源/)
  importActivityPageFile(source, { path: image, base64: bytes.toString('base64') })
  await expect(save({ ...page, elements: [{ id: 'leave', operation: 'activity:missing' }] })).rejects.toThrow(
    /找不到操作/,
  )
  await save(page)
  const { directory } = await exportProject(source, join(temp, 'export'))
  expect((await loadPackWeb(directory))?.activityPages?.[key]).toEqual(page)
  expect(readFileSync(join(directory, 'frontend', image))).toEqual(bytes)
  writeFileSync(
    join(source, 'frontend/activity-pages.json'),
    JSON.stringify({ [key]: { ...page, elements: [{ id: 'leave', operation: 'activity:removed' }] } }),
  )
  await expect(exportProject(source, join(temp, 'broken'))).rejects.toThrow(/找不到操作/)
})
it('checks raw HTML button references after applying editor overrides', async () => {
  const html = 'activities/custom.html'
  importActivityPageFile(source, {
    path: html,
    text: '<button data-activity-operation="activity:leave">退出</button><button id="changed" data-activity-operation="activity:obsolete">另一选项</button>',
  })
  const page = { html }
  await expect(saveActivityPage(source, { key, base: original, page })).rejects.toThrow(/HTML 按钮操作/)
  const overridden = { html, elements: [{ id: 'changed', operation: 'activity:ask-alin' }] }
  await saveActivityPage(source, { key, base: original, page: overridden })
  await expect(validateExportedPages(source)).resolves.toBeUndefined()
  writeFileSync(join(source, 'frontend/activity-pages.json'), JSON.stringify({ [key]: page }))
  await expect(validateExportedPages(source)).rejects.toThrow(/HTML 按钮操作/)
})
it('serves the bound page and local stylesheet in a real preview and preserves the plain template', async () => {
  const session = await previewActivityPage(source, { key })
  try {
    expect(session.started).toBe(true)
    const url = new URL(session.url),
      headers = { 'x-playtest-token': url.hash.slice('#token='.length) }
    const init = async (query = '') => (await fetch(url.origin + '/frontend-api/v1/init' + query, { headers })).json()
    expect((await init()).view.activity).toMatchObject({ active: true, key })
    expect((await init()).activityPages[key]).toEqual(original)
    expect((await init('?template=default')).activityPages).toBeUndefined()
    const html = await fetch(url.origin + '/frontend/activity/' + original.html)
    expect(html.headers.get('content-security-policy')).toContain("script-src 'none'")
    expect(await html.text()).toBe(readFileSync(join(source, 'frontend', original.html), 'utf8'))
    const css = await fetch(url.origin + '/frontend/activity/' + original.css)
    expect(css.headers.get('content-type')).toMatch(/^text\/css/)
    expect(await css.text()).toBe(readFileSync(join(source, 'frontend', original.css), 'utf8'))
  } finally {
    await session.close()
  }
})
