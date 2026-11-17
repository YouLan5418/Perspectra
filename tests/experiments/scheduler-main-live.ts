/** Fresh synthetic world, bounded real calls through the B11 local gateway. No player saves or credentials. */
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorldHostRuntime } from '../../apps/host/src/runtime/world-runtime.ts'
import { FrontendActions } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { environmentRoleModels } from '../../apps/host/src/model-connections.ts'
import { playSettings } from '../../apps/host/src/play-settings.ts'

const root = resolve('.tmp/scheduler-main-live-' + Date.now())
mkdirSync(root, { recursive: true })
const pack = join(root, 'pack')
cpSync(resolve('examples/world-packs/character-autonomy'), pack, { recursive: true })
const endpoint = 'http://127.0.0.1:8025/v1/chat/completions'
const model = 'opencode-go/deepseek-v4.1-flash'
const originalFetch = globalThis.fetch
let calls = 0
globalThis.fetch = async (input, init) => {
  if (String(input instanceof Request ? input.url : input) !== endpoint) throw new Error('Unexpected live endpoint')
  if (++calls > 16) throw new Error('Live call limit reached')
  return originalFetch(input, init)
}
const runtime = await WorldHostRuntime.create({
  packPath: pack, dataDirectory: join(root, 'data'),
  models: environmentRoleModels({ PERSPECTRA_MODEL_ENDPOINT: endpoint, PERSPECTRA_MODEL: model }),
  playSettings: playSettings({
    maximumWaves: 2, maximumNpcCalls: 6, maximumCallsPerCharacter: 1,
    publicationCharacters: 400, modelTimeoutSeconds: 60, activationTimeoutSeconds: 90,
    reactionDeadlineSeconds: 90, autonomyOpportunities: 1, autonomyNpcCalls: 2,
    autonomyReactionCalls: 2, autonomyReactionWaves: 1,
  }),
})
const actions = new FrontendActions(runtime)
const results: unknown[] = []
async function step(operation: 'speak' | 'perform', payload: Record<string, unknown>) {
  const actionId = randomUUID(), started = performance.now(), before = calls
  let committedMs: number | undefined
  const pending = actions.perform({ operation, payload, actionId, requestId: actionId })
  const timer = setInterval(() => {
    void actions.view().then(view => {
      if (view.inputProgress?.actionId === actionId && committedMs === undefined)
        committedMs = Math.round(performance.now() - started)
    })
  }, 50)
  try {
    const view = await pending
    const result = { operation, payload, committedMs, totalMs: Math.round(performance.now() - started),
      calls: calls - before, status: view.status, scene: view.scene, history: view.history }
    results.push(result)
    console.log(JSON.stringify(result))
  } finally { clearInterval(timer) }
}
try {
  await step('speak', { text: '我准备去后室看看。你按自己的打算做就好。', scope: 'scene_public' })
  const move = (await actions.view()).actions.find(option => option.id === 'move:location:back-room')
  if (!move) throw new Error('Expected back-room move')
  await step('perform', { optionId: move.id })
  await step('speak', { text: '我刚到这里。你刚才在做什么？', scope: 'scene_public' })
} finally {
  await runtime.close()
  globalThis.fetch = originalFetch
  writeFileSync(join(root, 'summary.json'), JSON.stringify({ model, calls, results }, null, 2))
  console.log(JSON.stringify({ evidence: root, calls }))
}
