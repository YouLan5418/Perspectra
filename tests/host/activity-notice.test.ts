import type { SchedulerResult, SchedulerTurnResult } from '@harness-world/plugin-sdk'
import { expect, it } from 'vitest'
import { activityNotice } from '../../desktop/host/round-notices.ts'

function noticeFor(result: SchedulerTurnResult): string | undefined {
  let notice: string | undefined
  const cycle = {
    calls: result.calls,
    wave: 1,
    terminalReason: 'quiescent',
    activations: [{ characterId: 'character:gpt', result }],
  } as unknown as SchedulerResult
  activityNotice({ set: value => void (value === undefined ? undefined : (notice = value)) }, cycle)
  return notice
}

it('does not say nothing was submitted when the character acted and then had nothing to add', () => {
  const notice = noticeFor({
    status: 'abstained',
    calls: 2,
    performResult: { status: 'accepted', reason: null },
  })
  expect(notice).toBe('角色处理已完成。')
})

it('says the turn is kept when the character really did nothing', () => {
  expect(noticeFor({ status: 'abstained', calls: 1 })).toContain('没有提交操作')
})

it('says the turn is kept when the action was refused', () => {
  const notice = noticeFor({
    status: 'abstained',
    calls: 2,
    performResult: { status: 'rejected', reason: 'plugin:门锁着' },
  })
  expect(notice).toContain('没有提交操作')
})
