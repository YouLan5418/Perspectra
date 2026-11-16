import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ScriptedModel } from '../../packages/providers/src/scripted-model/index.ts'
import { WorldHostRuntime } from '../../apps/host/src/runtime/world-runtime.ts'
import { assembleRoleplay } from '../../apps/host/src/official-bundle.ts'
import { rmSync } from 'node:fs'
import { Script, runInNewContext } from 'node:vm'
import { afterEach, expect, it } from 'vitest'
import { frontendActionRequest, playerViewPatch, FRONTEND_SDK, type PlayerView } from '@perspectra/frontend'
import { HOST_ACTIVITY_PAGE } from '../../apps/host/src/runtime/host-page.ts'
import { DEFAULT_SCRIPT } from '../../packages/frontend/src/default-template.ts'
import { FrontendActions, projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { openRpgWorld } from '../support/rpg-fixture.ts'
import { investigationFixture } from '../support/investigation-fixture.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function open(change?: (source: string) => string) {
  const f = investigationFixture(2, change)
  cleanups.push(() => rmSync(f.root, { recursive: true, force: true }))
  const world = await openRpgWorld(f.pack, f.data)
  cleanups.push(() => world.close())
  const actions = new FrontendActions(world.runtime)
  let seq = 0
  const send = (operation: string, payload: unknown) =>
    actions.perform(
      frontendActionRequest({
        requestId: 'r:' + ++seq,
        actionId: 'a:' + seq,
        operation,
        payload,
      }),
    )
  return { ...world, send, view: async () => projectPlayerView(await world.runtime.state()) }
}
const energy = (view: PlayerView) => view.panels?.find(row => row.kind === 'property-table')?.properties?.[0]?.value

it('connects authored labels, open classification, editable parameters, private panels and formally adjudicated controls', async () => {
  const f = await open()
  let view = await f.view()
  const search = view.actions.find(row => row.label === '搜查房间')!
  expect(search.target?.kind).toBe('investigation-site')
  expect(search.group).toBe('调查')
  expect((search.action.parameters.targetRef as { kind: string }).kind).toBe('location')
  expect(energy(view)).toBe(2)
  expect(view.panels?.find(row => row.kind === 'entry-list')).toMatchObject({ entries: [] })
  const control = view.pluginControls![0]!
  expect(control).toMatchObject({
    id: 'example-investigation/search-enabled',
    value: true,
    scope: 'world',
    disabled: false,
  })
  expect(control).not.toHaveProperty('operation')
  const before = f.events().length
  await expect(f.send('setPluginControl', { id: control.id, value: 'false' })).rejects.toThrow('允许范围')
  await expect(f.send('setPluginControl', { id: 'missing', value: true })).rejects.toThrow('不可用')
  expect(f.events()).toHaveLength(before)
  view = await f.send('setPluginControl', { id: control.id, value: false })
  expect(view.pluginControls![0]!.value).toBe(false)
  view = await f.send('perform', { optionId: search.id })
  expect(energy(view)).toBe(2)
  expect(JSON.stringify(f.events())).toContain('SEARCH_PAUSED')
  expect(view.feedback?.message).toContain('已暂停搜查')
  expect(view.feedback?.message).not.toContain('definitionRef')
  await f.send('setPluginControl', { id: control.id, value: true })
  view = await f.send('perform', { optionId: search.id })
  expect(energy(view)).toBe(1)
  expect(view.panels?.find(row => row.kind === 'entry-list')).toMatchObject({ entries: [{ title: '一封信' }] })
  // The observer's cognition sees searching, not the private clue.
  const observed = JSON.stringify(f.inputs)
  expect(observed).toContain('翻找')
  expect(observed).not.toContain('clue:letter')
  await f.send('perform', { optionId: search.id })
  view = await f.send('perform', { optionId: search.id })
  expect(energy(view)).toBe(0)
  expect(JSON.stringify(f.events())).toContain('INSUFFICIENT_ENERGY')
})

it('reports a presentation fault without leaking its details or hiding the rest of the world', async () => {
  const f = await open(
    source =>
      source.slice(0, source.indexOf('  playerView:')) +
      "  playerView: () => { throw new TypeError('SECRET_INTERNAL') } };",
  )
  const view = await f.view()
  expect(view.panels).toEqual([])
  expect(view.actions.some(row => row.label === '搜查房间')).toBe(true)
  expect(JSON.stringify(view)).not.toContain('SECRET_INTERNAL')
  expect(view.feedback?.message).toContain('example-investigation')
})

it('clears removed controls and panels over the actual SDK patch transport', async () => {
  const f = await open(),
    before = await f.view()
  const { panels: _panels, pluginControls: _controls, ...after } = before
  const patch = JSON.parse(JSON.stringify(playerViewPatch(before, after)))
  expect(patch).toMatchObject({ panels: null, pluginControls: null })
  let connect!: (event: unknown) => void
  const parent = { postMessage() {} },
    window: any = {
      addEventListener: (_name: string, handler: typeof connect) => {
        connect = handler
      },
    }
  runInNewContext(FRONTEND_SDK, { window, parent, setTimeout, clearTimeout })
  const port: any = {
    start() {},
    postMessage(message: any) {
      if (message.method === 'view')
        queueMicrotask(() =>
          port.onmessage({ data: { type: 'response', requestId: message.requestId, ok: true, result: after } }),
        )
    },
  }
  connect({ source: parent, data: { type: 'frontend-connect', apiVersion: 1 }, ports: [port] })
  port.onmessage({ data: { type: 'initialized', view: before } })
  let latest: PlayerView | undefined
  window.Perspectra.subscribe((event: { view: PlayerView }) => {
    latest = event.view
  })
  port.onmessage({ data: { type: 'view-patch', changes: patch } })
  expect(latest).not.toHaveProperty('panels')
  expect(latest).not.toHaveProperty('pluginControls')
  expect(() => new Script(DEFAULT_SCRIPT)).not.toThrow()
  // The Host-owned bridge has a second diff before MessagePort delivery: test it too.
  const start = HOST_ACTIVITY_PAGE.indexOf('  function applyView(')
  const end = HOST_ACTIVITY_PAGE.indexOf('  async function connect()', start)
  const sent: unknown[] = []
  const apply = runInNewContext(
    'let playerView=before; const init={frontend:"custom"};' + HOST_ACTIVITY_PAGE.slice(start, end) + ';applyView',
    { before, post: (value: unknown) => sent.push(value), syncStage() {} },
  )
  apply(after)
  expect(sent).toContainEqual({ type: 'view-patch', changes: patch })
  await window.Perspectra.getView()
  // A later unrelated patch must retain the freshly fetched full view, not restore old panels.
  port.onmessage({ data: { type: 'view-patch', changes: { status: 'busy' } } })
  expect(latest).not.toHaveProperty('panels')
})

it('B9 standalone search pack runs through the normal stage action adapter without HTTP or model credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b9-stage-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const model = new ScriptedModel()
  const runtime = await WorldHostRuntime.create({
    packPath: resolve('examples/world-packs/investigation'),
    dataDirectory: root,
    models: model.models,
    composition: assembleRoleplay({ llmTransport: model.provider }),
  })
  cleanups.push(() => runtime.close())
  const actions = new FrontendActions(runtime)
  const view = projectPlayerView(await runtime.state())
  const search = view.actions.find(row => row.label === '搜查房间')!
  const after = await actions.perform(
    frontendActionRequest({
      requestId: 'b9',
      actionId: 'search',
      operation: 'perform',
      payload: { optionId: search.id },
    }),
  )
  expect(energy(after)).toBe(1)
  expect(after.panels?.find(row => row.kind === 'entry-list')).toMatchObject({ entries: [{ title: '一封信' }] })
  expect(model.inputs.some(entry => entry.characterId === 'character:cheng')).toBe(true)
  expect(JSON.stringify(model.inputs)).not.toContain('clue:letter')
})
