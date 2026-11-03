import { rejectionReasonText } from '@harness-world/application'
import { PlayerInputJobs } from '@harness-world/store-sqlite'
import type { WorldAddress, WorldJsonObject } from '@harness-world/contracts'
import type { SchedulerResult } from '@harness-world/plugin-sdk'
import type { ChatCallObservation } from '@harness-world/provider-chat'
import { WorldStore } from '@harness-world/store-sqlite'

export const SCHEDULER_FAILED_NOTICE = '调度器插件出错，本轮角色反应已停止；玩家输入保留，可以继续行动。'

/**
 * The endpoint's own refusal text may echo the request, so it never reaches the notice. The HTTP status
 * class is enough to name the likely cause, which is what a creator debugging their own preset needs.
 */
export function providerFailureNotice(httpStatus: number | undefined): string {
  if (httpStatus === undefined) return '角色模型服务未完成请求'
  if (httpStatus === 400 || httpStatus === 422) {
    return `角色模型请求被服务拒绝（HTTP ${httpStatus}）；请检查预设中的生成参数（如 frequencyPenalty、presencePenalty、stop）与模型标识是否被该服务支持`
  }
  if (httpStatus === 401 || httpStatus === 403)
    return `角色模型服务拒绝认证（HTTP ${httpStatus}）；请在模型设置中检查该实例的凭证`
  if (httpStatus === 404) return `角色模型服务找不到该模型（HTTP ${httpStatus}）；请检查模型标识`
  if (httpStatus === 429) return `角色模型服务限流（HTTP ${httpStatus}）；请稍后重试或降低调用预算`
  return `角色模型服务未完成请求（HTTP ${httpStatus}）`
}

/** Where a round's outcome goes. `undefined` leaves that part as it is. */
export interface RoundStatus {
  set(notice: string | undefined, error: boolean | undefined): void
}

export function reactionNotice(
  status: RoundStatus,
  cycle: SchedulerResult,
  roleCalls: ReadonlyMap<string, ChatCallObservation>,
  pluginFailures: ReadonlyMap<string, string>,
): void {
  const terminal = cycle.terminalReason
  if (terminal === 'plugin_failed') {
    status.set(undefined, true)
    status.set(SCHEDULER_FAILED_NOTICE, undefined)
    return
  }
  if (terminal === 'failed' || terminal === 'interrupted') {
    const failureStatus = terminal === 'interrupted' ? 'interrupted' : 'failed'
    const activation =
      cycle.activations.find(activation => activation.result.status === failureStatus) ?? cycle.activations.at(-1)
    const relevant = activation?.result
    const failedCall = activation === undefined ? undefined : roleCalls.get(String(activation.characterId))
    const committed = relevant?.performResult !== undefined
    const failedPlugin = activation === undefined ? undefined : pluginFailures.get(String(activation.characterId))
    const cause =
      terminal === 'interrupted'
        ? '角色处理被打断或超时'
        : failedPlugin !== undefined
          ? `插件 ${failedPlugin} 出错，详情见游戏进程的输出`
          : relevant?.failure === 'invalid_output'
            ? '角色返回格式无效'
            : relevant?.failure === 'preset_failed'
              ? '角色预设处理失败，请检查提示节点与文本规则'
              : relevant?.failure === 'provider_failed'
                ? providerFailureNotice(failedCall?.status === 'failed' ? failedCall.httpStatus : undefined)
                : '角色处理失败'
    status.set(undefined, true)
    status.set(
      `玩家输入已提交；${cause}。${
        committed
          ? '交互结果已提交，后续表达未完成；请看转录中的实际结果。可以继续行动，无需重发上一句。'
          : '已经发表的回应保留；尚未完成的角色行动或表达没有提交。可以继续行动，无需重发上一句。'
      }`,
      undefined,
    )
  } else if (terminal === 'call_limit' || terminal === 'wave_limit' || terminal === 'character_limit') {
    status.set(
      '玩家输入已提交；本轮角色反应达到预算上限，剩余反应没有继续执行。可以继续行动，无需重发上一句。',
      undefined,
    )
  } else {
    status.set('本轮角色处理已结束，可以继续行动；角色也可以选择不回应。', undefined)
  }
}

export function autonomyNotice(status: RoundStatus, reason: string): void {
  if (reason === 'failed' || reason === 'interrupted') {
    status.set(undefined, true)
    status.set('玩家输入及已提交的角色行动保留；自主处理失败或超时，未完成的机会已丢弃，可以继续行动。', undefined)
  } else if (reason === 'plugin_failed') {
    status.set(undefined, true)
    status.set(SCHEDULER_FAILED_NOTICE, undefined)
  } else if (reason === 'call_limit' || reason === 'wave_limit' || reason === 'character_limit') {
    status.set('自主行动或后续反应达到预算上限；已提交结果保留，未使用机会不积攒，可以继续行动。', undefined)
  }
}

export function playerResolutionNotice(
  worldPath: string,
  address: WorldAddress,
  idempotencyKey: string,
  headSeq: number,
): string | undefined {
  const jobs = new PlayerInputJobs(worldPath)
  const world = new WorldStore(worldPath)
  try {
    const validated = jobs.read(address, idempotencyKey)?.records.validated as
      | {
          sourceText?: string
          actions?: readonly { actionId: string; actionType: string }[]
          sourceSpans?: readonly { actionId: string; endUtf16: number; text: string }[]
        }
      | undefined
    if (validated?.actions === undefined) return undefined
    const resolutions = new Map(
      world
        .readEvents(address, headSeq)
        .filter(
          event => event.eventType === 'action.resolved' && (event.data as WorldJsonObject).sourceRole === 'player',
        )
        .map(event => {
          const data = event.data as WorldJsonObject
          return [data.actionId, data] as const
        }),
    )
    const failed = validated.actions.filter(action => resolutions.get(action.actionId)?.accepted !== true)
    const accepted = validated.actions.length - failed.length
    const details = failed
      .map(action => {
        const quote = validated.sourceSpans
          ?.filter(span => span.actionId === action.actionId)
          .map(span => span.text)
          .join('')
        const reason = resolutions.get(action.actionId)?.reason
        // Players read the shared plain-language wording; raw rejection codes stay out of the notice.
        const explained = typeof reason === 'string' ? rejectionReasonText(reason)?.replace(/。$/u, '') : undefined
        return `“${quote || action.actionType}”未执行${explained === undefined ? '' : `：${explained}`}`
      })
      .join('；')
    const lastEnd = Math.max(0, ...(validated.sourceSpans ?? []).map(span => span.endUtf16))
    const trailing = validated.sourceText?.slice(lastEnd).replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '') ?? ''
    const omitted =
      trailing === ''
        ? ''
        : `句尾“${trailing.length > 80 ? `${trailing.slice(0, 80)}…` : trailing}”没有映射到本次动作或表达。`
    if (failed.length === 0 && omitted === '') return undefined
    const rejected =
      failed.length === 0 ? '' : `${accepted > 0 ? '玩家输入已部分提交' : '玩家动作未成功'}：${details}。`
    return `${rejected}${omitted}请以转录和当前场景为准。`
  } finally {
    world.close()
    jobs.close()
  }
}
