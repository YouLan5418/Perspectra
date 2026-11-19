/** Browser driver for the unmodified 雨夜来信 world pack. IPC actions represent another authorized local client. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorldHostRuntime } from '../../apps/host/src/runtime/world-runtime.ts'
import { createHostServer } from '../../apps/host/src/runtime/http-server.ts'
import { FrontendActions, projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'

const root = mkdtempSync(join(tmpdir(), 'perspectra-narrative-'))
// The ordinary lines on either side may invoke the local stub. The author script should make zero calls.
const provider = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
let run = 0
const create = () => WorldHostRuntime.create({
  packPath: resolve('examples/world-packs/scripted-performance'),
  dataDirectory: join(root, String(++run)),
  models: fakeModels(provider.endpoint),
  timeoutMs: 1000,
})
let runtime = await create()
const host = createHostServer({
  state: () => runtime.state(),
  submit: (...args) => runtime.submit(...args),
  perform: (...args) => runtime.perform(...args),
  activityAction: (...args) => runtime.activityAction(...args),
  escape: () => runtime.escape(),
  pause: () => runtime.pause(),
  resume: () => runtime.resume(),
  close: () => runtime.close(),
}, 'f'.repeat(64))
host.listen(0, '127.0.0.1', () => {
  const address = host.address()
  if (address && typeof address === 'object') console.log('Preview ready on port ' + address.port)
})

process.on('message', async (message: { id: number; command: string }) => {
  try {
    if (message.command === 'reset') {
      await runtime.close()
      runtime = await create()
    }
    if (message.command === 'before' || message.command === 'after') {
      const text = message.command === 'before' ? '我先把钥匙放在手边，等一等。' : '演出结束后，我们回到刚才的话题。'
      await runtime.submit('/act speak ' + JSON.stringify({ text, scope: 'scene_public', addresseeIds: [] }))
    }
    if (message.command === 'start-performance') {
      const client = new FrontendActions(runtime)
      const { actions } = await client.view()
      const option = actions.find(option => option.action.parameters.definitionRef &&
        (option.action.parameters.definitionRef as { id?: string }).id === 'host:activity-start')
      if (!option) throw new Error('No authorized performance start')
      await client.perform({ requestId: randomUUID(), actionId: randomUUID(), operation: 'perform', payload: { optionId: option.id } })
    }
    const state = await runtime.state()
    process.send?.({ id: message.id, view: projectPlayerView(state), providerCalls: state.debug.providerCalls })
  } catch (error) {
    process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error) })
  }
})
async function close() {
  host.closeAllConnections()
  host.close()
  await runtime.close()
  await provider.close()
  rmSync(root, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
