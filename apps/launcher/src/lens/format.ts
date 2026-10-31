import type { LensRequestState, LensRequestView } from '../../../../desktop/lens/store.ts'
import type { AutoStartEvaluation } from '../../../../desktop/host/pack-activities.ts'
import type { LensField, LensItem, LensSection, LensSource } from '../../../../desktop/lens/view.ts'
import { conditionItems } from '../../../../desktop/lens/ids.ts'

export const SECTION_LABEL: Record<LensSection, string> = {
  characters: '角色',
  knowledge: '谁知道什么',
  places: '地点与场景',
  statuses: '状态',
  items: '物品',
  events: '事件与活动',
  rules: '规则与钩子',
  presets: '预设与记忆',
}

export const REQUEST_STATE_LABEL: Record<LensRequestState, string> = {
  open: '待改',
  changed: '已改动，待确认',
  removed: '已删除',
  closed: '已关闭',
}

/** 字段值的游戏内写法：列表用顿号连起来，真假写成是／否。 */
export function showValue(value: LensField['value'] | null): string {
  if (value === null) return '（无）'
  if (Array.isArray(value)) return value.length ? value.join('、') : '（无）'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return value === '' ? '（空）' : String(value)
}

/** 源码位置：JSON 文件加 JSON Pointer，或脚本文件、hook 名和条件标签。 */
export function showSource(source: LensSource): string {
  if (source.kind === 'json') return `${source.file} ${source.pointer || '/'}`
  return `${source.file} · ${source.hook}${source.label === undefined ? '' : ' · ' + source.label}`
}

export const fieldValue = (fields: readonly LensField[], key: string) => fields.find(field => field.key === key)?.value

/** 事件页“自动触发”一行：按“此刻”的检查结果说明，不说“会不会触发”——真正的检查发生在下一回合结束时。 */
export function autoStartStatus(evaluation: AutoStartEvaluation): { readonly ok: boolean; readonly text: string } {
  if (evaluation.error !== undefined) return { ok: false, text: '条件脚本出错' }
  if (evaluation.checks === null)
    return {
      ok: false,
      text:
        evaluation.skipped === 'running'
          ? '有活动正在进行，此刻不检查自动触发'
          : evaluation.skipped === 'paused'
            ? '这个活动有暂停的进度，不会自动开始'
            : '条件脚本此刻返回 null，不检查',
    }
  return evaluation.checks.every(check => check.met)
    ? { ok: true, text: '条件已全部满足（下一回合结束时检查）' }
    : { ok: false, text: '条件未全部满足' }
}

/** 一个条件行：条目来自透视结果（开场时算出的条件），此刻的 ✔/✘ 有就叠上去；met 为 undefined 表示此刻没有检查。
 * 此刻多出来、透视结果里没有的条件也列出，但没有条目可选。 */
export interface ConditionRow {
  readonly id: string
  readonly title: string
  readonly met: boolean | undefined
  readonly labelled: boolean
  readonly selectable: boolean
}
export function conditionRows(
  eventId: string,
  children: readonly LensItem[],
  evaluation: AutoStartEvaluation | undefined,
): ConditionRow[] {
  const checks = evaluation?.checks ?? []
  const live = new Map(
    conditionItems(eventId, checks).map((row, position) => [row.id, { ...row, ...checks[position]! }]),
  )
  const rows: ConditionRow[] = children.map(child => ({
    id: child.id,
    title: child.title,
    met: live.get(child.id)?.met,
    labelled: child.source.kind === 'script' && child.source.label !== undefined,
    selectable: true,
  }))
  const known = new Set(children.map(child => child.id))
  for (const [id, row] of live)
    if (!known.has(id))
      rows.push({ id, title: row.title, met: row.met, labelled: row.label !== null, selectable: false })
  return rows
}

/** “复制给 AI”的文本：只含待改和已改动待确认的条目，每条带作者原话、条目叫法、源码位置、创建时的值和状态。 */
export function requestsForAi(requests: readonly LensRequestView[]): string {
  const pending = requests.filter(request => request.state === 'open' || request.state === 'changed')
  return [
    `以下是作者在 Perspectra 包透视里圈出的待改条目（${pending.length} 条）。`,
    '你可以按清单修改世界包源文件，但不能关闭、删除或修改清单条目；改完由作者在透视里核对后自己关闭。',
    ...pending.map((request, position) =>
      [
        '',
        `${position + 1}. ${request.id}（${REQUEST_STATE_LABEL[request.state]}）`,
        `   作者原话：${request.note}`,
        `   条目叫法：${request.itemTitle}（${request.itemId}）`,
        `   源码位置：${showSource(request.source)}`,
        '   创建时的值：',
        ...(request.valueAtCreation.length
          ? request.valueAtCreation.map(field => `     - ${field.label}：${showValue(field.value)}`)
          : ['     （无字段）']),
      ].join('\n'),
    ),
  ].join('\n')
}
