import { expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { HOST_ACTIVITY_PAGE } from '../../desktop/host/host-page.ts'
import { stagePreferences } from '../../packages/frontend/src/stage-preferences.ts'
import { playerViewPatch, type PlayerView } from '../../packages/frontend/src/player-view.ts'

it('keeps stored display preferences bounded and excludes unrelated data', () => {
  const normalize = runInNewContext('(' + stagePreferences.toString() + ')') as typeof stagePreferences
  expect(normalize({ fontSize: 24, appearance: 'dark', token: 'secret', volume: -1, lineHeight: Infinity })).toEqual({
    fontSize: 24,
    lineHeight: 1.9,
    autoFollow: true,
    autoSpeed: 1,
    volume: 80,
    muted: false,
    voiceEnabled: false,
    appearance: 'dark',
  })
  expect(normalize({}, { fontSize: 17, volume: 35 })).toMatchObject({ fontSize: 17, volume: 35 })
})

function bridge(frontend: string) {
  const replies: unknown[] = [],
    api = vi.fn(async () => ({ node: { id: 'node-1', title: '窗边' } }))
  const channel = {
    port1: {
      onmessage: null as null | ((event: unknown) => Promise<void>),
      postMessage: (value: unknown) => replies.push(value),
      start() {},
    },
    port2: {},
  }
  const context = {
    connected: false,
    frameLoaded: true,
    frontendReady: true,
    epoch: 1,
    init: { frontend, capabilities: [], canSave: true },
    playerView: {},
    port: null,
    MessageChannel: function () {
      return channel
    },
    frame: { contentWindow: { postMessage() {} } },
    node: () => ({}),
    post: (value: unknown) => replies.push(value),
    panelPresentation() {},
    readPreferences: () => ({}),
    normalizePreferences: stagePreferences,
    localStorage: { setItem: vi.fn() },
    api,
  }
  const start = HOST_ACTIVITY_PAGE.indexOf('  async function connect(){'),
    end = HOST_ACTIVITY_PAGE.indexOf("  window.addEventListener('message'", start)
  runInNewContext(HOST_ACTIVITY_PAGE.slice(start, end) + ';connect()', context)
  return {
    api,
    context,
    replies,
    send: (method: string, payload: unknown) =>
      channel.port1.onmessage!({ data: { type: 'request', requestId: 'request:1', method, payload } }),
  }
}

it('allows only the bundled stage to save or persist local display preferences', async () => {
  const custom = bridge('custom')
  await custom.send('saveProgress', { title: '窗边' })
  await custom.send('stagePreferences', { fontSize: 22 })
  expect(custom.api).not.toHaveBeenCalled()
  expect(custom.context.localStorage.setItem).not.toHaveBeenCalled()
  expect(custom.replies.slice(1)).toEqual([
    expect.objectContaining({ ok: false, error: '仅官方默认舞台可使用此操作' }),
    expect.objectContaining({ ok: false, error: '仅官方默认舞台可使用此操作' }),
  ])
  const bundled = bridge('default')
  await bundled.send('saveProgress', { title: '窗边' })
  expect(bundled.api).toHaveBeenCalledWith('/api/story-save', { title: '窗边' })
  await bundled.send('saveProgress', { title: '窗边', path: 'private' })
  expect(bundled.api).toHaveBeenCalledTimes(1)
  await bundled.send('stagePreferences', { fontSize: 22, token: 'secret' })
  expect(bundled.context.localStorage.setItem).toHaveBeenCalledWith(
    'perspectra.stage.preferences',
    expect.not.stringContaining('secret'),
  )
})

it('forwards changed visible items, known status and responders through both patch steps', () => {
  const before: PlayerView = {
    game: { title: 'test' },
    player: { name: 'you' },
    scene: null,
    status: 'ready',
    history: [],
    actions: [],
    items: [],
  }
  const after: PlayerView = {
    ...before,
    items: [{ id: 'cup', name: '杯子', kind: '杯', where: 'held' }],
    statusBar: [{ key: 'time', label: '时间', holderId: null, value: '18:21', current: true }],
    responders: ['同行者'],
  }
  const changes = playerViewPatch(before, after)
  expect(changes).toMatchObject({ items: after.items, statusBar: after.statusBar, responders: after.responders })
  const post = vi.fn()
  const start = HOST_ACTIVITY_PAGE.indexOf('  function applyView('),
    end = HOST_ACTIVITY_PAGE.indexOf('  async function connect()', start)
  runInNewContext(HOST_ACTIVITY_PAGE.slice(start, end) + ';applyView(next)', {
    playerView: before,
    next: after,
    init: { frontend: 'custom' },
    post,
  })
  expect(post).toHaveBeenCalledWith({ type: 'view-patch', changes })
})
