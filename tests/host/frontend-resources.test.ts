import { mkdtemp, mkdir, writeFile, open, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { FRONTEND_RESOURCE_LIMITS, loadPackWeb } from '../../desktop/host/pack-frontend.ts'
import { frontendAsset } from '../../desktop/host/frontend-server.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('unexpected temporary directory')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'frontend-resources-'))
  roots.push(root)
  const directory = join(root, 'frontend')
  await mkdir(directory)
  await writeFile(join(directory, 'index.html'), '<p>test</p>')
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ apiVersion: 1, capabilities: ['view'] }))
  return { root, directory }
}
it('loads a pack with over 100 files and over 16 MiB of portrait assets', async () => {
  const { root, directory } = await fixture(),
    portrait = Buffer.alloc(3 * 1024 * 1024)
  await Promise.all(Array.from({ length: 7 }, (_, i) => writeFile(join(directory, `portrait-${i}.png`), portrait)))
  await Promise.all(Array.from({ length: 120 }, (_, i) => writeFile(join(directory, `script-${i}.js`), 'export {}')))
  const pack = await loadPackWeb(root)
  expect(pack?.assets.size).toBe(129)
  expect(pack?.assets.get('/frontend/custom/portrait-6.png')?.bytes.length).toBe(3 * 1024 * 1024)
})
it('still rejects oversized individual assets and excessive file counts', async () => {
  const large = await fixture(),
    file = await open(join(large.directory, 'large.wav'), 'w')
  try {
    await file.truncate(FRONTEND_RESOURCE_LIMITS.fileBytes + 1)
  } finally {
    await file.close()
  }
  await expect(loadPackWeb(large.root)).rejects.toThrow('单文件 64 MiB')
  const many = await fixture()
  // index + manifest + these files exceed the total file count by one.
  for (let start = 0; start < FRONTEND_RESOURCE_LIMITS.files - 1; start += 128)
    await Promise.all(
      Array.from({ length: Math.min(128, FRONTEND_RESOURCE_LIMITS.files - 1 - start) }, (_, i) =>
        writeFile(join(many.directory, `f-${start + i}.js`), ''),
      ),
    )
  await expect(loadPackWeb(many.root)).rejects.toThrow('2048')
})
it('restyles the default stage when the pack brings only a theme.css', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frontend-resources-'))
  roots.push(root)
  await mkdir(join(root, 'frontend'))
  await writeFile(join(root, 'frontend', 'theme.css'), ':root{--accent:#7a1f1f}')
  const pack = (await loadPackWeb(root))!
  expect(pack.page).toBeUndefined()
  expect(pack.theme).toBe(true)
  const page = async (query: string) => {
    let body = ''
    const response = {
      statusCode: 200,
      setHeader: () => {},
      end: (bytes: string | Buffer) => (body = String(bytes)),
    } as unknown as ServerResponse
    frontendAsset(
      { method: 'GET', url: '/frontend/default.html' + query, headers: { host: '127.0.0.1:1' } } as IncomingMessage,
      response,
      pack,
      'http://127.0.0.1:1',
      'sandbox',
    )
    return body
  }
  // The theme loads after the stage's own styles, and only when the host asks for it.
  expect(await page('?theme=1')).toContain(
    '<link rel="stylesheet" href="/frontend/default.css"><link rel="stylesheet" href="/frontend/custom/theme.css">',
  )
  expect(await page('')).not.toContain('theme.css')
  // A pack with a page of its own still needs its manifest.
  await writeFile(join(root, 'frontend', 'index.html'), '<p>own</p>')
  await expect(loadPackWeb(root)).rejects.toThrow('manifest.json')
})

it('accepts artwork alone for the default stage, while still rejecting executable pages without a manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frontend-resources-'))
  roots.push(root)
  await mkdir(join(root, 'frontend', 'portraits'), { recursive: true })
  await mkdir(join(root, 'frontend', 'backgrounds'))
  await writeFile(join(root, 'frontend', 'portraits', 'companion.png'), 'portrait-bytes')
  await writeFile(join(root, 'frontend', 'backgrounds', 'library.webp'), 'background-bytes')
  const pack = (await loadPackWeb(root))!
  expect(pack.page).toBeUndefined()
  expect(pack.theme).toBe(false)
  expect(pack.manifest.capabilities).toEqual([])
  let body = ''
  frontendAsset(
    {
      method: 'GET',
      url: '/frontend/custom/portraits/companion.png',
      headers: { host: '127.0.0.1:1' },
    } as IncomingMessage,
    {
      setHeader() {},
      end: (bytes: Buffer) => {
        body = String(bytes)
      },
    } as unknown as ServerResponse,
    pack,
    'http://127.0.0.1:1',
    'sandbox',
  )
  expect(body).toBe('portrait-bytes')
  await writeFile(join(root, 'frontend', 'app.js'), 'window.secret = true')
  await expect(loadPackWeb(root)).rejects.toThrow('manifest.json')
})
it('reads portrait framing from stage.json and refuses a malformed one at load', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frontend-resources-'))
  roots.push(root)
  await mkdir(join(root, 'frontend', 'portraits'), { recursive: true })
  await writeFile(join(root, 'frontend', 'portraits', 'claude.png'), Buffer.from([137, 80, 78, 71]))
  const stage = (value: unknown) => writeFile(join(root, 'frontend', 'stage.json'), JSON.stringify(value))
  await stage({ characters: { 'character:claude': { framing: { top: 0.02, waist: 0.45 } } } })
  expect((await loadPackWeb(root))?.stage).toEqual({
    characters: { 'character:claude': { framing: { top: 0.02, waist: 0.45 } } },
  })
  await stage({ characters: { 'character:claude': { framing: { top: 0.5, waist: 0.4 } } } })
  await expect(loadPackWeb(root)).rejects.toThrow('0 ≤ top < waist ≤ 1')
  await stage({ characters: { 'character:claude': { expressions: {} } } })
  await expect(loadPackWeb(root)).rejects.toThrow('只支持 framing')
})
