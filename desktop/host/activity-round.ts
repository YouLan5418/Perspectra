import type { CharacterTurn } from '@harness-world/application'
import { brandId, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { CharacterViewBuilder, type WorldStore } from '@harness-world/store-sqlite'
import type { PlaySettings } from '../play-settings.ts'
import type { RoundStatus } from './round-notices.ts'
import type { WorldGameplay } from './world-gameplay.ts'

/** Let the running activity hand opportunities to its participants until it stops, its budget ends or it times out. */
export async function runActivityChain(input: {
  readonly gameplay: WorldGameplay
  readonly status: RoundStatus
  readonly settings: PlaySettings
  readonly address: WorldAddress
  readonly controller: AbortController
  readonly store: WorldStore
  readonly turn: CharacterTurn
  readonly isPaused: () => boolean
  readonly resultUnknown: () => boolean
}): Promise<void> {
  const { gameplay, status, settings, address, controller, store, turn, isPaused, resultUnknown } = input
  const outcome = {
    set notice(value: string) {
      status.set(value, undefined)
    },
    set error(value: boolean) {
      status.set(undefined, value)
    },
  }
  let selected = gameplay.activity?.schedule()
  // Creator selects the next participant; the host bounds the entire chain.
  const activitySignal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(settings.activityDeadlineSeconds * 1000),
  ])
  for (
    let opportunity = 0;
    opportunity < settings.activityOpportunities && selected !== undefined && !activitySignal.aborted && !isPaused();
    opportunity++
  ) {
    const result = await turn.run(brandId(selected, 'CharacterId'), {
      signal: activitySignal,
      maxCalls: 2,
      stimulus: new CharacterViewBuilder(store)
        .rebuildAt(address, brandId(selected, 'CharacterId'), store.head(address).headSeq)
        .observations.toSorted((left, right) => left.sourceSeq - right.sourceSeq)
        .slice(-8)
        .map(o => o.value as WorldJsonObject),
    })
    if (resultUnknown()) return
    outcome.error = result.failure !== undefined
    outcome.notice =
      result.failure === undefined
        ? result.status === 'abstained'
          ? '角色本次没有提交操作，当前轮次保留；可以再次请求处理或逃生。'
          : '角色处理已完成。'
        : result.failure === 'invalid_output'
          ? '角色返回格式无效，当前轮次没有推进；可重试或逃生。'
          : '角色决策处理未完成，当前轮次没有推进；可重试或逃生。'
    selected = activitySignal.aborted ? undefined : gameplay.activity!.outcome(result as unknown as WorldJsonObject)
    if (opportunity === settings.activityOpportunities - 1 && selected !== undefined)
      outcome.notice = '本次活动处理达到宿主预算上限；已提交结果保留，可再次请求处理或逃生。'
  }
  if (activitySignal.aborted) {
    outcome.notice = '活动处理已取消或超时；已提交结果保留，未完成操作没有换手。'
    outcome.error = true
  }
}
