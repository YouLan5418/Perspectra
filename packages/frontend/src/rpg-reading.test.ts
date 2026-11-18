import { expect, it } from 'vitest'
import { createRpgReading } from './rpg-reading.ts'
import type { PlayerView } from './player-view.ts'

function view(phase: string, visit = 1, said: number[] = [], sequences = [1]): PlayerView {
  const active = phase === 'fighting'
  return {
    status: 'ready',
    activityStage: active
      ? {
          moduleId: 'official-rpg',
          renderer: 'official-rpg.battle',
          activityKey: 'map',
          activityId: 'instance',
          revision: 4,
          payload: { skills: [{ name: '怒击', targets: ['守卫'] }] },
        }
      : null,
    activities: [
      {
        key: 'map',
        active: active || phase === 'aftermath',
        suspended: false,
        phase,
        public: { visit, arrivedAtSeq: 8, said, pending: [] },
      },
    ],
    history: sequences.map(seq => ({ seq, speaker: '旁白', text: '相同文案', player: false })),
  } as unknown as PlayerView
}
it('holds only the authorized ending batch, and releases before subsequent narration', () => {
  const r = createRpgReading(),
    before = view('fighting'),
    after = view('victory', 1, [], [1, 2])
  r.update(before, after, 'instance', false)
  expect(r.boundary(2)).toBe(2)
  r.update(after, view('victory', 1, [], [1, 2, 3]), null, false)
  expect(r.boundary(3)).toBeUndefined()
})
it('hands authored aftermath, missing evidence, other visits, scene inspection and replaced history back to ordinary playback', () => {
  const before = view('fighting'),
    r = createRpgReading()
  for (const after of [
    view('aftermath', 1, [], [1, 2]),
    view('victory', 1, [4], [1, 2]),
    view('victory', 2, [], [1, 2]),
    view('defeat'),
    view('victory', 1, [], [2]),
  ]) {
    r.update(before, after, 'instance', false)
    expect(r.boundary(2)).toBeUndefined()
  }
  const after = view('defeat', 1, [], [1, 2])
  r.update(before, after, null, false)
  expect(r.boundary(2)).toBeUndefined()
  r.update(before, after, 'instance', false)
  expect(r.boundary(2)).toBe(2)
  r.update(after, view('defeat', 1, [], [1, 3]), null, false)
  expect(r.boundary(2)).toBeUndefined()
  r.update(before, after, 'instance', true)
  expect(r.boundary(2)).toBeUndefined()
})
it('names only an authorized skill from the submitted offer for the same activity revision', () => {
  const r = createRpgReading(),
    v = view('fighting')
  const option = (revision: number): PlayerView['actions'][number] => ({
    id: 'cast',
    label: '使用技能',
    kind: 'activity',
    action: {
      actionType: 'interact',
      parameters: {
        definitionRef: { id: 'activity:skill' },
        bindingId: 'instance',
        arguments: { activityId: 'instance', revision },
      },
    },
  })
  const args = { skill: '怒击', target: '守卫' }
  expect(r.submittedSkill(v, option(4), args)?.name).toBe('怒击')
  expect(r.submittedSkill(v, option(3), args)).toBeUndefined()
  expect(r.submittedSkill(v, option(4), { ...args, skill: '未公开技能' })).toBeUndefined()
  expect(r.submittedSkill(v, option(4), { ...args, target: '未知对象' })).toBeUndefined()
})
