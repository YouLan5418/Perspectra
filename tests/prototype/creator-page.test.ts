import { afterEach, expect, it } from 'vitest'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPlaytestServer, type PlaytestRuntime } from '../experiments/playtest-server.ts'

const token = 'a'.repeat(64)
const meta = { title: '晚餐', storyline: '支线', characters: [{ id: 'npc:a', name: '甲' }] }
const roots: string[] = [], servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(missing = false) {
  const root = await mkdtemp(join(tmpdir(), 'creator-page-')); roots.push(root)
  const directory = join(root, 'creator')
  await mkdir(join(directory, 'assets'), { recursive: true })
  await writeFile(join(directory, 'index.html'), '<html>creator</html>')
  await writeFile(join(directory, 'assets/app.js'), 'export const app = true')
  await writeFile(join(root, 'secret.txt'), 'PRIVATE')
  await writeFile(join(root, 'secret.js'), 'PRIVATE')
  // Windows junctions need no symlink privilege; real paths must still stay in the build.
  await symlink(root, join(directory, 'assets/outside'), process.platform === 'win32' ? 'junction' : 'dir')
  const server = createPlaytestServer({ creatorMeta: () => meta } as PlaytestRuntime, token, undefined, undefined, undefined, missing ? null : pathToFileURL(directory + '/'))
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  return { origin, get: (path: string, headers: Record<string, string> = {}) => fetch(origin + path, { headers, redirect: 'manual' }) }
}
it('serves index with custom page CSP and redirects the directory entry', async () => {
  const f = await fixture(), response = await f.get('/creator/')
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('creator')
  const csp = response.headers.get('content-security-policy')!
  expect(csp).toContain("script-src 'self';")
  expect(csp.match(/script-src[^;]*/u)![0]).not.toContain('unsafe-inline')
  const redirect = await f.get('/creator')
  expect(redirect.status).toBe(301); expect(redirect.headers.get('location')).toBe('/creator/')
})
it('serves asset with js content type', async () => {
  const response = await (await fixture()).get('/creator/assets/app.js')
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/javascript')
})
it('blocks traversal, malformed encoding, backslashes and directory junction escape', async () => {
  const { origin } = await fixture()
  for (const path of ['/creator/assets/..%2f..%2fsecret.txt', '/creator/assets/..\\x.js', '/creator/assets/%2e%2e/secret.txt', '/creator/assets/%5csecret.js', '/creator/assets/%ZZ.js', '/creator/assets/outside/secret.js', '/creator/assets/app.json']) {
    // Raw HTTP preserves paths that URL/fetch would normalize before sending.
    const status = await new Promise<number>((done, reject) => {
      request(origin, { path }, response => { response.resume(); done(response.statusCode!) }).on('error', reject).end()
    })
    expect(status, path).toBe(404)
  }
})
it('reports missing build', async () => {
  const response = await (await fixture(true)).get('/creator/')
  expect(response.status).toBe(503)
  expect(await response.text()).toContain('创作者页面未构建')
})
it('creator-meta requires token and stays outside the public frontend API', async () => {
  const f = await fixture()
  expect((await f.get('/api/creator-meta')).status).toBe(401)
  expect((await f.get('/api/creator-meta', { 'x-playtest-token': token, origin: 'null' })).status).toBe(403)
  const response = await f.get('/api/creator-meta', { 'x-playtest-token': token })
  expect(response.status).toBe(200); expect(await response.json()).toEqual(meta)
  expect((await f.get('/frontend-api/v1/creator-meta', { 'x-playtest-token': token })).status).toBe(404)
})
