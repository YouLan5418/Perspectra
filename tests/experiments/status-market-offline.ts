import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import type { HostState } from '../../desktop/host/http-server.ts'
import { environmentRoleModels } from '../../desktop/model-connections.ts'

// A model-free run of examples/world-packs/status-market: scripted NPC decisions drive a theft, the player
// buys and checks the purse, and the round hook advances time. Only the player's status bar and the
// status values each role was given are saved.
const PLAYER = 'character:player', THIEF = 'character:companion', BYSTANDER = 'character:friend'
const directory = resolve('.tmp', 'status-market-' + Date.now())
mkdirSync(directory, { recursive: true })
const object = (value: unknown) => value as WorldJsonObject
const roleKnown: { actor: string; knownStatus: unknown }[] = []
let stolen = false
const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += String(chunk) })
  request.on('end', () => {
    const messages = JSON.parse(body).messages as { role: string; content: string }[]
    const input = object(JSON.parse(messages.findLast(m => m.role === 'user')!.content))
    const actor = String(object(object(input.context).character).characterId)
    roleKnown.push({ actor, knownStatus: object(input.context).knownStatus })
    // The thief steals from the player once, on its first turn; every other turn abstains.
    const output = actor === THIEF && !stolen && !input.continuation
      ? (stolen = true, { decision: 'perform', actionType: 'interact', parameters: { targetRef: { kind: 'character', id: THIEF },
        bindingId: 'status', definitionRef: { id: 'status:steal', version: 1 }, arguments: { targetId: PLAYER } } })
      : { decision: 'abstain' }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ message: { content: JSON.stringify(output) } }))
  })
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const runtime = await WorldHostRuntime.create({ models: environmentRoleModels({ PERSPECTRA_MODEL_ENDPOINT: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/chat', PERSPECTRA_MODEL: 'scripted-fixture' }), packPath: resolve('examples/world-packs/status-market'),
  dataDirectory: join(directory, 'data'), timeoutMs: 10000})
const bar = (state: HostState) => state.statusBar ?? []
const entry = (state: HostState, key: string) => bar(state).find(e => e.key === key && (key === 'time' || e.self))
const steps: { input: string; error: boolean; notice: string; money: unknown; time: unknown; statusBar: unknown }[] = []
try {
  for (const input of ['/act speak {"text":"今天集市人真多。","scope":"scene_public"}', '/status check-purse {}',
    '/status buy {"price":20}', '/act speak {"text":"买到了，走吧。","scope":"scene_public"}']) {
    const state = await runtime.submit(input)
    steps.push({ input, error: state.error, notice: state.notice, money: entry(state, 'money'), time: entry(state, 'time')?.value,
      statusBar: bar(state) })
  }
} finally {
  await runtime.close()
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
}
const money = steps.map(step => step.money as { value: number; current: boolean } | undefined)
const checks = {
  theftLeavesPlayerStale: money[0]?.value === 100 && money[0]?.current === false,
  checkPurseConfirms: money[1]?.value === 70 && money[1]?.current === true,
  buyConfirms: money[2]?.value === 50 && money[2]?.current === true,
  timeAdvancesTenPerRound: steps.map(step => step.time).join(',') === '10,20,30,40',
  thiefNeverSeesPlayerPurse: roleKnown.filter(r => r.actor === THIEF)
    .every(r => !(r.knownStatus as { holderId: string | null }[]).some(s => s.holderId === PLAYER)),
  // The bystander is never told anyone's purse but its own.
  bystanderSeesOnlyOwnPurse: roleKnown.some(r => r.actor === BYSTANDER) && roleKnown.filter(r => r.actor === BYSTANDER)
    .every(r => (r.knownStatus as { key: string; holderId: string | null }[])
      .every(s => s.key !== 'money' || s.holderId === BYSTANDER)),
  noErrors: steps.every(step => !step.error),
}
const summary = { directory, steps: steps.map(({ statusBar: _, ...step }) => step), checks }
writeFileSync(join(directory, 'summary.json'), JSON.stringify({ ...summary, steps, roleKnown }, null, 2))
process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
if (Object.values(checks).some(ok => !ok)) process.exitCode = 1
