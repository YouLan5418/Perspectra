/** Runs the unmodified multi-activity pack on the real Host with a gated, loopback NPC model. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WorldStore } from '@perspectra/core/store'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { createHostServer } from '../../apps/host/src/runtime/http-server.ts'
import { projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { WorldHostRuntime } from '../../apps/host/src/runtime/world-runtime.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'

const root = mkdtempSync(join(tmpdir(), 'perspectra-invitation-'))
let run = 0
let choice = '拒绝'
let answering: string | undefined
let releaseAnswer: (() => void) | undefined
const provider = await startFakeProvider('openai', async call => {
  const input = JSON.parse(call.userText) as WorldJsonObject
  const context = input.context as WorldJsonObject | undefined
  const actor = (context?.character as WorldJsonObject | undefined)?.characterId
  const activity = context?.activity as WorldJsonObject | undefined
  const game = activity?.game as WorldJsonObject | undefined
  if (!activity || typeof actor !== 'string' || game?.phase !== 'invited' || game.turn !== actor || input.continuation)
    return { tool: { decision: 'abstain' } }
  answering = actor
  await new Promise<void>(release => { releaseAnswer = release })
  releaseAnswer = undefined
  return { tool: {
    decision: 'perform',
    actionType: 'interact',
    parameters: {
      targetRef: { kind: 'character', id: actor },
      bindingId: activity.id,
      definitionRef: { id: 'activity:respond', version: 1 },
      arguments: { activityId: activity.id, revision: activity.revision, choice },
    },
  } }
})

const create = (pack = 'multiple-activities') => WorldHostRuntime.create({
  packPath: resolve('examples/world-packs', pack),
  dataDirectory: join(root, String(++run)),
  models: fakeModels(provider.endpoint),
  timeoutMs: 20_000,
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

function fixtureEvidence() {
  // Inspect only this temporary fixture to verify actor, recipients and no implicit movement.
  const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
  try {
    const events = store.readEvents(runtime.address)
    const invite = events.filter(event =>
      event.eventType === 'activity.updated' && (event.data as WorldJsonObject).activityKey === 'invite',
    ).map(event => {
      const data = event.data as WorldJsonObject
      return { operation: data.operation, actorId: data.actorId }
    })
    const resultRecipients = events.flatMap(event => {
      if (event.eventType !== 'observation.upsert') return []
      const value = (event.data as WorldJsonObject).value as WorldJsonObject
      const content = value.content as WorldJsonObject
      return JSON.stringify(content).includes('了约会邀请。') ? [value.observerId] : []
    })
    return { invite, resultRecipients, moves: events.filter(event => event.eventType === 'character.moved').length }
  } finally {
    store.close()
  }
}

process.on('message', async (message: { id: number; command: string }) => {
  try {
    if (message.command === 'reset' || message.command === 'reset-rules') {
      releaseAnswer?.()
      await runtime.close()
      choice = '拒绝'
      answering = undefined
      // The separate legacy battle pack publishes author rules through the generic card.
      runtime = await create(message.command === 'reset-rules' ? 'rpg-turn-battle' : 'multiple-activities')
    }
    if (message.command === 'accept') choice = '接受'
    if (message.command === 'release') releaseAnswer?.()
    if (message.command === 'move') await runtime.submit('/act move {"locationId":"location:back-room"}')
    const state = await runtime.state()
    process.send?.({
      id: message.id,
      answering,
      view: projectPlayerView(state),
      ...(message.command === 'proof' ? { evidence: fixtureEvidence() } : {}),
    })
  } catch (error) {
    process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error) })
  }
})

async function close() {
  releaseAnswer?.()
  host.closeAllConnections()
  host.close()
  await runtime.close()
  await provider.close()
  rmSync(root, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
