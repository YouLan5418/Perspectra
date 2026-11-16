import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openStageLab, labRenderer } from '../support/activity-stage-fixture.ts'
import { projectPlayerView, FrontendActions } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { defaultFrontendAssets, playerViewPatch, FRONTEND_SDK, type PlayerView } from '@perspectra/frontend'
import { HOST_ACTIVITY_PAGE } from '../../apps/host/src/runtime/host-page.ts'
import { runInNewContext, Script } from 'node:vm'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function open(mode: Parameters<typeof openStageLab>[0] = 'normal') {
  const f = await openStageLab(mode)
  cleanups.push(() => f.close())
  const view = async () => projectPlayerView(await f.runtime.state())
  const perform = async (label: string, args?: Record<string, unknown>) => {
    const current = await view(),
      option = current.actions.find(row => row.label === label || row.label.startsWith(label))!
    if (!option) throw Error('Missing offered ' + label + '; ' + current.actions.map(a => a.label).join(','))
    return new FrontendActions(f.runtime).perform({
      requestId: randomUUID(),
      actionId: randomUUID(),
      operation: 'perform',
      payload: { optionId: option.id, ...(args ? { arguments: args } : {}) },
    })
  }
  await perform('开始 登记实验')
  return { ...f, view, perform }
}
it('second trusted activity uses the same registered module projection, lifecycle and existing actions', async () => {
  const f = await open(),
    before = await f.view()
  expect(before.activityStage).toMatchObject({
    renderer: 'stage-lab.counter',
    moduleId: 'stage-lab',
    payload: { count: 0 },
  })
  expect(JSON.stringify(before.activityStage)).not.toMatch(/INTERNAL_DO_NOT_PROJECT|ownNote|private|internal/)
  const next = await f.perform('增加计数')
  expect(next.activityStage!.payload.count).toBe(1)
  expect(next.activityStage!.activityId).toBe(before.activityStage!.activityId)
  expect(next.activityStage!.revision).toBeGreaterThan(before.activityStage!.revision)
  expect((await f.perform('暂停')).activityStage).toBeNull()
  expect((await f.perform('继续')).activityStage!.payload.count).toBe(1)
  expect((await f.perform('完成实验')).activityStage).toBeNull()
  const again = await f.perform('开始 登记实验')
  expect(again.activityStage!.activityId).not.toBe(before.activityStage!.activityId)
  expect(again.activityStage!.payload.count).toBe(0)
  await f.runtime.escape()
  expect((await f.view()).activityStage).toBeNull()
})
it('projection failure or invalid revision is isolated; generic controls remain usable and no fault detail leaks', async () => {
  for (const mode of ['project-error', 'stale'] as const) {
    const f = await open(mode),
      view = await f.view()
    expect(view.activityStage).toBeNull()
    expect(JSON.stringify(view)).not.toContain('PRIVATE_FAILURE_DO_NOT_EXPOSE')
    expect(view.actions.some(a => a.label === '增加计数')).toBe(true)
    await f.perform('增加计数')
    expect((await f.runtime.state()).activity!.game).toMatchObject({ public: { count: 1 } })
  }
})
it('rejects duplicate renderer IDs and compiles trusted renderers without a gameplay-specific default', () => {
  expect(() => defaultFrontendAssets([labRenderer, labRenderer])).toThrow('REGISTRATION')
  const assets = defaultFrontendAssets([labRenderer])
  expect(() => new Script(assets.script)).not.toThrow()
  expect(assets.script).not.toContain('official-rpg')
  expect(assets.script).toContain('stage-lab.counter')
})
it('clears stage data through server delta, Host second delta, MessagePort and subsequent full fetch', async () => {
  const f = await open(),
    before = await f.view(),
    after = await f.perform('暂停'),
    patch = playerViewPatch(before, after)
  expect(patch!.activityStage).toBeNull()
  const start = HOST_ACTIVITY_PAGE.indexOf('  function applyView('),
    end = HOST_ACTIVITY_PAGE.indexOf('  async function connect()', start),
    sent: any[] = []
  const apply = runInNewContext(
    'let playerView=before;const init={frontend:"custom"};' + HOST_ACTIVITY_PAGE.slice(start, end) + ';applyView',
    { before, post: (v: unknown) => sent.push(v), syncStage() {} },
  )
  apply(after)
  expect(sent[0].changes.activityStage).toBeNull()
  let connect: any
  const parent = { postMessage() {} },
    window: any = {
      addEventListener(_n: string, h: any) {
        connect = h
      },
    }
  runInNewContext(FRONTEND_SDK, { window, parent, setTimeout, clearTimeout })
  const port: any = {
    start() {},
    postMessage(message: any) {
      queueMicrotask(() =>
        port.onmessage({ data: { type: 'response', requestId: message.requestId, ok: true, result: after } }),
      )
    },
  }
  connect({ source: parent, data: { type: 'frontend-connect', apiVersion: 1 }, ports: [port] })
  port.onmessage({ data: { type: 'initialized', view: before } })
  let latest: PlayerView
  window.Perspectra.subscribe((e: any) => {
    latest = e.view
  })
  port.onmessage({ data: sent[0] })
  expect(latest!.activityStage).toBeUndefined()
  await window.Perspectra.getView()
  port.onmessage({ data: { type: 'view-patch', changes: { status: 'ready' } } })
  expect(latest!.activityStage).toBeNull()
})
