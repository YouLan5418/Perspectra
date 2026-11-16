import { expect, it } from 'vitest'
import { createActivityStage, activityStageRendererSource } from './activity-stage.ts'
import type { ActivityStageRenderContext, ActivityStageRenderer } from '@perspectra/sdk/contracts'
import type { PlayerView } from './player-view.ts'
const view = (id = 'activity:1', revision = 1, renderer = 'fixture.counter', moduleId = 'fixture'): PlayerView =>
  ({
    activityStage: {
      moduleId,
      renderer,
      activityKey: 'counter',
      activityId: id,
      revision,
      payload: { count: revision },
    },
    actions: [
      { id: 'perform', label: '加一', kind: 'activity', target: { kind: 'activity', id: 'counter' } },
      { id: 'other', label: '别的活动', kind: 'activity', target: { kind: 'activity', id: 'other' } },
    ],
  }) as unknown as PlayerView
const root = () => ({ replaceChildren() {}, className: 'activity-stage' }) as unknown as HTMLElement
it('binds callbacks to activity/revision/candidate, current operation and busy state; disposes on change/clear', () => {
  const contexts: ActivityStageRenderContext[] = [],
    sent: unknown[] = [],
    disposed: string[] = []
  const renderer: ActivityStageRenderer = {
    id: 'fixture.counter',
    moduleId: 'fixture',
    style: '',
    create: () => ({
      update(_payload, context) {
        contexts.push(context)
      },
      dispose() {
        disposed.push('disposed')
      },
    }),
  }
  const stage = createActivityStage(
    root(),
    [renderer],
    (id, args) => sent.push([id, args]),
    () => {},
  )
  stage.update(view(), false, false, '', '')
  const first = contexts.at(-1)!
  expect(first.actions.map(a => a.id)).toEqual(['perform'])
  first.perform('other')
  expect(sent).toEqual([])
  first.perform('perform')
  first.perform('perform')
  expect(sent).toHaveLength(1)
  stage.update(view('activity:1', 2), true, false, '', '')
  contexts.at(-1)!.perform('perform')
  expect(sent).toHaveLength(1)
  stage.update(view('activity:1', 2), false, false, '', '')
  first.perform('perform')
  expect(sent).toHaveLength(1)
  const second = contexts.at(-1)!
  stage.update(view('activity:2', 1), false, false, '', '')
  second.perform('perform')
  expect(sent).toHaveLength(1)
  expect(disposed).toHaveLength(1)
  contexts.at(-1)!.perform('perform')
  expect(sent).toHaveLength(2)
  const cleared = contexts.at(-1)!
  stage.clear()
  cleared.perform('perform')
  expect(sent).toHaveLength(2)
  expect(disposed).toHaveLength(2)
  stage.update(view('activity:2', 1), false, false, '', '')
  cleared.perform('perform')
  expect(sent).toHaveLength(2)
})
it('unknown/mismatched modules and rendering exceptions clear the previous renderer and cannot issue stale actions', () => {
  let context: ActivityStageRenderContext | undefined,
    disposed = 0,
    sent = 0
  const renderer: ActivityStageRenderer = {
    id: 'fixture.counter',
    moduleId: 'fixture',
    style: '',
    create: () => ({
      update(payload, c) {
        context = c
        if (payload.count === 9) throw Error('bad')
      },
      dispose() {
        disposed++
      },
    }),
  }
  const stage = createActivityStage(
    root(),
    [renderer],
    () => {
      sent++
    },
    () => {},
  )
  stage.update(view(), false, false, '', '')
  const old = context!
  expect(() => stage.update(view('activity:2', 1, 'unknown'), false, false, '', '')).toThrow()
  old.perform('perform')
  expect(sent).toBe(0)
  expect(disposed).toBe(1)
  expect(() => stage.update(view('activity:3', 1, 'fixture.counter', 'impostor'), false, false, '', '')).toThrow()
  expect(() => stage.update(view('activity:4', 9), false, false, '', '')).toThrow()
  expect(disposed).toBe(2)
  context!.perform('perform')
  expect(sent).toBe(0)
  stage.clear()
  context!.perform('perform')
  expect(sent).toBe(0)
  expect(() => activityStageRendererSource([renderer, renderer])).toThrow()
})
