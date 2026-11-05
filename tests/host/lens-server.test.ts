import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { startLensServer, type LensServer } from '../../desktop/lens/server.ts'
import type { LensSnapshot } from '../../desktop/lens/session.ts'

import { sweetWithoutPacing } from '../support/sweet-without-pacing.ts'
const SWEET = sweetWithoutPacing()
const roots: string[] = []
const servers: LensServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function pack() {
  const root = await mkdtemp(join(tmpdir(), 'lens-server-'))
  roots.push(root)
  const path = join(root, 'pack')
  await cp(SWEET, path, { recursive: true, filter: source => !source.includes('.perspectra-lens') })
  return path
}
async function serve(path: string, assets?: URL | null) {
  const server = await startLensServer(path, assets === undefined ? {} : { assets })
  servers.push(server)
  const { origin, hash } = new URL(server.url)
  const token = hash.slice('#token='.length)
  const call = async (operation: string, data: Record<string, unknown> = {}) => {
    const response = await fetch(origin + '/api/lens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lens-token': token },
      body: JSON.stringify({ operation, ...data }),
    })
    return { status: response.status, body: (await response.json()) as LensSnapshot & { error?: string } }
  }
  const ok = async (operation: string, data: Record<string, unknown> = {}) => {
    const { status, body } = await call(operation, data)
    expect(body.error).toBeUndefined()
    expect(status).toBe(200)
    return body
  }
  const stale = async () => {
    const response = await fetch(origin + '/api/lens/status', { headers: { 'x-lens-token': token } })
    return ((await response.json()) as { stale: boolean }).stale
  }
  return { server, origin, token, call, ok, stale }
}

it('binds to loopback and refuses requests without the token', async () => {
  const { server, origin, token } = await serve(await pack())
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/lens\/#token=[a-f0-9]{64}$/)
  const post = (headers: Record<string, string>) =>
    fetch(origin + '/api/lens', { method: 'POST', headers, body: JSON.stringify({ operation: 'lens-seen' }) })
  expect((await post({})).status).toBe(401)
  expect((await post({ 'x-lens-token': 'a'.repeat(64) })).status).toBe(401)
  expect((await fetch(origin + '/api/lens/status')).status).toBe(401)
  expect((await fetch(origin + '/api/lens', { headers: { 'x-lens-token': token } })).status).toBe(405)
})

it('serves only the built page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lens-assets-'))
  roots.push(root)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<title>透视</title>')
  await writeFile(join(root, 'assets', 'page.js'), 'export {}')
  await writeFile(join(root, 'secret.txt'), 'no')
  const { origin } = await serve(await pack(), pathToFileURL(root + '/'))
  expect(await (await fetch(origin + '/lens/')).text()).toBe('<title>透视</title>')
  expect((await fetch(origin + '/lens/assets/page.js')).status).toBe(200)
  expect((await fetch(origin + '/lens/secret.txt')).status).toBe(404)
  expect((await fetch(origin + '/lens/assets/../secret.txt')).status).toBe(404)
  expect((await fetch(origin + '/other')).status).toBe(404)
  const missing = await serve(await pack(), null)
  expect((await fetch(missing.origin + '/lens/')).status).toBe(503)
})

it('a pack that does not compile still gets a page that says why, and works once fixed', async () => {
  const path = await pack()
  const file = join(path, 'worldpack.source.json')
  const manifest = await readFile(file, 'utf8')
  await writeFile(file, '{broken')
  const { call, ok } = await serve(path)
  const failed = await call('lens-open')
  expect(failed.status).toBe(400)
  expect(failed.body.error).toBeTruthy()
  expect((await call('lens-seen')).body.error).toBe('世界包还没有读取成功。')
  await writeFile(file, manifest)
  expect((await ok('lens-reload')).view.items.length).toBeGreaterThan(10)
}, 120_000)

it('reports a pack edit as stale until it is read again, and ignores its own files', async () => {
  const path = await pack()
  const { ok, stale } = await serve(path)
  await ok('lens-open')
  expect(await stale()).toBe(false)
  // 已看过 writes .perspectra-lens, which is not an edit to the pack.
  await ok('lens-seen')
  await new Promise(done => setTimeout(done, 300))
  expect(await stale()).toBe(false)

  const file = join(path, 'characters.json')
  const edited = JSON.parse(await readFile(file, 'utf8'))
  edited.characters[0].displayName += '改'
  await writeFile(file, JSON.stringify(edited))
  await vi.waitFor(async () => expect(await stale()).toBe(true), { timeout: 5000, interval: 100 })
  const reloaded = await ok('lens-reload')
  expect(reloaded.changes.length).toBeGreaterThan(0)
  await new Promise(done => setTimeout(done, 300))
  expect(await stale()).toBe(false)
}, 180_000)

it('only 已看过 moves the baseline', async () => {
  const path = await pack()
  const { ok } = await serve(path)
  await ok('lens-open')
  const seen = await ok('lens-seen')
  expect(seen.baseline).toEqual({ kind: 'seen' })
  expect(seen.changes).toEqual([])
  const file = join(path, 'characters.json')
  const edited = JSON.parse(await readFile(file, 'utf8'))
  edited.characters[0].displayName += '改'
  await writeFile(file, JSON.stringify(edited))
  const reloaded = await ok('lens-reload')
  expect(reloaded.changes.length).toBeGreaterThan(0)
  expect((await ok('lens-reload')).changes).toEqual(reloaded.changes)
  expect((await ok('lens-seen')).changes).toEqual([])
}, 180_000)

it('a reload whose start the edited pack rejects keeps the old view', async () => {
  const path = await pack()
  const { call, ok } = await serve(path)
  await ok('lens-open')
  await ok('lens-restart', { start: { skipAutoStart: ['midnight-fridge'] } })
  const file = join(path, 'worldpack.source.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  manifest.assetFiles = manifest.assetFiles.filter((asset: string) => !asset.endsWith('midnight-fridge.js'))
  await writeFile(file, JSON.stringify(manifest))
  expect((await call('lens-reload')).body.error).toContain('midnight-fridge')
  const after = await ok('lens-baseline', { baseline: { kind: 'seen' } })
  expect(after.view.items.some(item => item.id === 'event:midnight-fridge')).toBe(true)
  expect(after.simulation.start).toEqual({ skipAutoStart: ['midnight-fridge'] })
}, 180_000)

it('steps append to the trace; requests are added by item id and closed', async () => {
  const { call, ok } = await serve(await pack())
  const opened = await ok('lens-open')
  expect(opened.baseline).toEqual({ kind: 'none' })
  const one = await ok('lens-step', { step: { kind: 'wait' } })
  const two = await ok('lens-step', { step: { kind: 'wait' } })
  expect(one.simulation.trace).toHaveLength(1)
  expect(two.simulation.trace.map(trace => trace.index)).toEqual([0, 1])
  expect((await call('lens-request-add', { itemId: 'no-such-item', note: '改一下' })).body.error).toContain(
    '找不到设置项',
  )
  const added = await ok('lens-request-add', { itemId: opened.view.items[0]!.id, note: '改一下' })
  expect(added.requests).toHaveLength(1)
  const closed = await ok('lens-request-close', { id: added.requests[0]!.id })
  expect(closed.requests[0]!.state).toBe('closed')
  expect((await ok('lens-restart', { start: {} })).simulation.trace).toEqual([])
  expect((await call('no-such-operation')).body.error).toBe('未知的透视操作。')
}, 180_000)

it('two pages at once share one session', async () => {
  const { ok } = await serve(await pack())
  const [a, b] = await Promise.all([ok('lens-open'), ok('lens-open')])
  expect(a.view.items.length).toBe(b.view.items.length)
  await ok('lens-step', { step: { kind: 'wait' } })
  expect((await ok('lens-open')).simulation.trace).toHaveLength(1)
}, 120_000)

it('close ends the page and removes nothing from the pack', async () => {
  const path = await pack()
  const { server, origin, ok } = await serve(path)
  await ok('lens-open')
  await server.close()
  await server.close()
  await expect(fetch(origin + '/lens/')).rejects.toThrow()
  expect((await readFile(join(path, 'worldpack.source.json'), 'utf8')).length).toBeGreaterThan(0)
}, 120_000)
