import { expect, it } from 'vitest'
import type { PlayerView } from '@perspectra/frontend'
import {
  pageFieldValue,
  pageRuleMatches,
  type PageField,
  type PageRule,
} from '../../apps/host/src/runtime/activity-page-rules.ts'
import { readPageElements, checkPageTargets } from '../../apps/host/src/runtime/activity-page-elements.ts'
import { activityPage } from '../../apps/host/src/runtime/activity-pages.ts'

function player(): PlayerView {
  return {
    game: { title: '遗迹' },
    player: { name: '玩家' },
    scene: null,
    history: [],
    actions: [],
    status: 'ready',
    activity: {
      key: 'ruins',
      id: 'one',
      active: true,
      title: '遗迹',
      phase: 'fighting',
      public: {},
      private: { role: '侦察' },
    },
    items: [{ id: 'opener', name: '拆信刀', kind: 'tool', where: 'here' }],
    statusBar: [
      { key: 'weather', label: '天气', holderId: null, value: '晴', current: false },
      { key: 'weather', label: '天气', holderId: 'other', value: '阴', current: true },
    ],
    statusTruth: [{ key: 'weather', label: '天气', holderId: null, value: '雨' }],
  }
}
it('reads personal, held and current known global fields only during the activity', () => {
  const view = player()
  expect(pageFieldValue({ source: 'personal', path: ['role'] }, view)).toBe('侦察')
  expect(pageFieldValue({ source: 'public', path: ['role'] }, view)).toBeUndefined()
  const held: PageField = { source: 'held', key: 'opener' }
  expect(pageFieldValue(held, view)).toBe(false)
  view.items![0]!.where = 'held'
  expect(pageFieldValue(held, view)).toBe(true)
  const world: PageField = { source: 'world', key: 'weather' }
  const rule: PageRule = { field: world, compare: 'ne', value: '雨', effect: { kind: 'show' } }
  expect(pageRuleMatches(rule, pageFieldValue(world, view))).toBe(false)
  view.statusBar![0]!.current = true
  expect(pageFieldValue(world, view)).toBe('晴')
  view.activity!.active = false
  expect(pageFieldValue(world, view)).toBeUndefined()
})
it('uses a stable unit ID and the current maximum for a strict HP threshold', () => {
  const view = player()
  const units = [
    { id: 'guard', hp: 3, maxHp: 10 },
    { id: 'ally', hp: 1, maxHp: 10 },
  ]
  view.activityStage = {
    moduleId: 'rpg',
    renderer: 'battle',
    activityKey: 'ruins',
    activityId: 'one',
    revision: 1,
    payload: { units },
  }
  const field: PageField = { source: 'stage', path: ['units', { by: 'id', is: 'guard' }, 'hp'], relativeTo: 'maxHp' }
  const rule: PageRule = { field, compare: 'lt', value: 30, effect: { kind: 'show' } }
  const matches = () => pageRuleMatches(rule, pageFieldValue(field, view))
  expect(matches()).toBe(false)
  units.reverse()
  units[1]!.hp = 2
  expect(matches()).toBe(true)
  units[1]!.maxHp = 0
  expect(matches()).toBe(false)
  units.push({ id: 'guard', hp: 1, maxHp: 10 })
  expect(pageFieldValue(field, view)).toBeUndefined()
  expect(() =>
    activityPage({
      html: 'activities/battle.html',
      elements: [{ id: 'guard', rules: [{ ...rule, field: { source: 'internal', path: ['hp'] } }] }],
    }),
  ).toThrow(/玩家可见/)
})
it('only offers unique, live HTML targets and binds clicks to buttons', () => {
  const html =
    '<title id="clash">标题</title><div id="clash"></div><template><button id="action"></button></template><section id="message" data-activity-field="text"><button id="replaced"></button></section><button id="action" aria-label="拆信"></button>'
  const layout = readPageElements(html)
  expect(layout.targets.map(e => e.id)).toEqual(['message', 'action'])
  expect(() => checkPageTargets(layout, [{ id: 'action', operation: 'activity:open' }])).not.toThrow()
  expect(() => checkPageTargets(layout, [{ id: 'message', operation: 'activity:open' }])).toThrow(/button/)
  expect(() => checkPageTargets(layout, [{ id: 'replaced' }])).toThrow(/唯一 id/)
})
