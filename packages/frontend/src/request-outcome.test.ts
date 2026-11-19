import { expect, it } from 'vitest'
import { actionReplyOutcome } from './request-outcome.ts'

it('only classifies established preflight rejections as not executed', () => {
  expect(
    actionReplyOutcome('perform', undefined, { retryable: false, message: '该操作不在玩家当前可用操作中' }),
  ).toMatchObject({ kind: 'expired' })
  expect(
    actionReplyOutcome('selectCandidate', undefined, {
      retryable: false,
      message: '只能切换当前末端回合的候选。',
    }),
  ).toMatchObject({ kind: 'expired' })
  expect(
    actionReplyOutcome('speak', undefined, {
      retryable: false,
      message: '接收对象已不在当前可见场景，请重新选择',
    }),
  ).toMatchObject({ kind: 'rejected' })
  expect(actionReplyOutcome('perform', undefined, { retryable: false, message: '其它 TypeError' })).toEqual({
    kind: 'unknown',
  })
  expect(
    actionReplyOutcome('perform', undefined, { retryable: true, message: '该操作不在玩家当前可用操作中' }),
  ).toEqual({ kind: 'unknown' })
})

it('preserves an explicitly unsubmitted draft and keeps an ambiguous completion unknown', () => {
  expect(
    actionReplyOutcome('speak', {
      status: 'paused',
      feedback: { message: 'NPC 已暂停：这次输入没有提交。恢复后再试。' },
    }),
  ).toMatchObject({ kind: 'rejected' })
  expect(actionReplyOutcome('speak', { status: 'error', feedback: { message: '后续处理未完成' } })).toEqual({
    kind: 'unknown',
  })
  expect(actionReplyOutcome('perform', undefined, {})).toEqual({ kind: 'unknown' })
  expect(actionReplyOutcome('speak', { status: 'ready' })).toEqual({ kind: 'acknowledged' })
})
