/** Model-free inventory preview using the market pack's real item rules and a fresh temporary world. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHostServer } from '../../desktop/host/http-server.ts'
import { WorldHostCore } from '../../desktop/host/world-runtime.ts'
import { environmentRoleModels } from '../../desktop/model-connections.ts'

const dataDirectory = mkdtempSync(join(tmpdir(), 'perspectra-inventory-'))
const runtime = await WorldHostCore.create({
  models: environmentRoleModels({ PERSPECTRA_MODEL_ENDPOINT: 'http://127.0.0.1:1/api/chat', PERSPECTRA_MODEL: 'unused' }),
  packPath: resolve('examples/world-packs/status-market'),
  dataDirectory,
  timeoutMs: 1000,
})
const token = 'f'.repeat(64)
const server = createHostServer(runtime, token)
server.listen(8081, '127.0.0.1', () => console.log(`Inventory preview: http://127.0.0.1:8081/#token=${token}`))
const close = async () => {
  server.closeAllConnections()
  server.close()
  await runtime.close()
}
process.once('SIGINT', close)
process.once('SIGTERM', close)
