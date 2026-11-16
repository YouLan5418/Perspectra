/** Local browser fixture: real Launcher backend, temporary data, fake model. No native file chooser. */
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { LauncherCore } from '../../apps/launcher/backend/core.ts'
import { copyRpgFixture, openRpgWorld } from '../support/rpg-fixture.ts'
const f = copyRpgFixture()
const core = new LauncherCore(resolve('.'), join(f.root, 'launcher'))
await core.initialize()
await core.handle({ operation: 'load', path: f.pack })
await core.handle({ operation: 'create', packageId: core.snapshot().packs[0]!.id, name: '浏览器整树备份' })
const instance = core.snapshot().instances[0]!
const runtime = await openRpgWorld(f.pack, join(core.root, 'instances', instance.id))
await runtime.runtime.saveNode('浏览器保存节点')
await runtime.close()
const archive = join(f.root, 'browser.perspectra-backup'), bad = join(f.root, 'broken.perspectra-backup')
writeFileSync(bad, '{broken')
const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', 'http://127.0.0.1:1420')
  res.setHeader('access-control-allow-headers', 'content-type')
  if (req.method === 'OPTIONS') { res.end(); return }
  if (req.url === '/fixture') { res.end(JSON.stringify({ archive, bad })); return }
  let body = ''
  for await (const chunk of req) body += chunk
  try { res.end(JSON.stringify({ result: await core.handle(JSON.parse(body)) })) }
  catch (error) { res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })) }
})
server.listen(17341, '127.0.0.1', () => console.log(JSON.stringify({ archive, bad, port: 17341 })))
async function close() { await core.close(); server.close(); rmSync(f.root, { recursive: true, force: true }); process.exit() }
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close())
