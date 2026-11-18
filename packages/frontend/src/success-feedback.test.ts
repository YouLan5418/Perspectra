import { expect, it } from 'vitest'
import { createSuccessFeedback } from './success-feedback.ts'

const line = (seq: number) => ({ seq, speaker: '玩家', text: '花 25 买下了东西', player: false })
const view = (...history: ReturnType<typeof line>[]) => ({
  status: 'ready' as const,
  feedback: { message: '状态操作已提交。', phase: '可以输入' },
  history,
})

it('announces exact receipts once by request identity and preserves identical new receipts', () => {
  const feedback = createSuccessFeedback()
  const first = view(line(1))
  feedback.bind({ actionId: 'first', statusOperation: true }, first, false)
  expect(feedback.read(first, true)).toBeNull()
  expect(feedback.read(view(), false)).toBeNull()
  expect(feedback.read(first, false)).toMatchObject({ id: 'first' })
  expect(feedback.announce('first')).toBe(true)
  expect(feedback.announce('first')).toBe(false)
  feedback.clear()

  const second = view(line(1), line(2))
  feedback.bind({ actionId: 'second', statusOperation: true }, second, false)
  expect(feedback.read(second, false)).toMatchObject({ id: 'second' })
  expect(feedback.announce('second')).toBe(true)
  expect(second.history).toEqual([line(1), line(2)])
})

it('keeps an unbound public snapshot inline and yields to the confirmation owned by the check card', () => {
  const feedback = createSuccessFeedback()
  const ordinary = view(line(1))
  expect(feedback.read(ordinary, false)).toEqual({ id: '', text: '状态操作已提交。' })
  expect(feedback.announce('')).toBe(false)
  feedback.bind({ actionId: 'ignored', statusOperation: false }, ordinary, false)
  expect(feedback.read(ordinary, false)).toMatchObject({ id: '' })

  feedback.bind({ actionId: 'checked', statusOperation: true }, ordinary, true)
  expect(feedback.read(ordinary, false)).toBeNull()
  expect(feedback.isRoutineCompletion({ ...ordinary, status: 'error' })).toBe(false)
})
