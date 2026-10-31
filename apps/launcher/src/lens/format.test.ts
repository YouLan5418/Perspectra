import { expect, it } from 'vitest'
import type { LensItem } from '../../../../desktop/lens/view.ts'
import { autoStartStatus, conditionRows } from './format.ts'

const base = { activityKey: 'fridge', title: '冰箱', started: false } as const
const condition = (title: string, label?: string): LensItem => ({
  id: `event:fridge/when/${title}`,
  section: 'events',
  title,
  parentId: 'event:fridge',
  fields: [],
  source: { kind: 'script', file: 'scripts/activities/fridge.js', hook: 'autoStart', ...(label ? { label } : {}) },
})

it('says the conditions are all met instead of claiming nothing will start', () => {
  const checks = [{ label: '深夜', met: true }]
  expect(autoStartStatus({ ...base, checks })).toEqual({ ok: true, text: '条件已全部满足（下一回合结束时检查）' })
  expect(autoStartStatus({ ...base, checks: [...checks, { label: '在厨房', met: false }] }).text).toBe('条件未全部满足')
})

it('names why no checks came back', () => {
  expect(autoStartStatus({ ...base, checks: null, skipped: 'running' }).text).toBe('有活动正在进行，此刻不检查自动触发')
  expect(autoStartStatus({ ...base, checks: null, skipped: 'paused' }).text).toContain('暂停')
  expect(autoStartStatus({ ...base, checks: null, skipped: 'none' }).text).toContain('null')
  expect(autoStartStatus({ ...base, checks: null, error: '坏了' }).text).toBe('条件脚本出错')
})

it('keeps condition rows from the view while an activity runs and overlays live checks when present', () => {
  const children = [condition('深夜', '深夜'), condition('条件 2')]
  expect(conditionRows('event:fridge', children, { ...base, checks: null, skipped: 'running' })).toEqual([
    { id: 'event:fridge/when/深夜', title: '深夜', met: undefined, labelled: true, selectable: true },
    { id: 'event:fridge/when/条件 2', title: '条件 2', met: undefined, labelled: false, selectable: true },
  ])
  const live = conditionRows('event:fridge', children, {
    ...base,
    checks: [
      { label: '深夜', met: true },
      { label: null, met: false },
      { label: '新条件', met: true },
    ],
  })
  expect(live.map(row => [row.id, row.met, row.selectable])).toEqual([
    ['event:fridge/when/深夜', true, true],
    ['event:fridge/when/条件 2', false, true],
    ['event:fridge/when/新条件', true, false],
  ])
})
