import type { PlayerView } from '@perspectra/frontend'
import { FrontendActions } from '../runtime/frontend-adapter.ts'
import { assertStep } from './export.ts'
import { openPageTrial, previewActivityPage } from './activity-page-preview.ts'
import { rpgBook } from './rpg.ts'

export function trialRequest(source: string, body: Record<string, unknown>, book = rpgBook(source)) {
  const map = book.activities.find(m => m.location === body.location)
  if (!map) throw new TypeError('请选择已启用 RPG 的地图入口')
  const scenes = body.scenes ?? {}
  if (!scenes || typeof scenes !== 'object' || Array.isArray(scenes))
    throw new TypeError('试玩起点需要角色到场景的映射')
  for (const [actor, scene] of Object.entries(scenes)) {
    if (!book.characters.some(c => c.id === actor) || !book.scenes.some(s => s.id === scene))
      throw new TypeError('无效的试玩起点')
  }
  const scene = book.scenes.find(s => s.location === map.location)
  return { key: map.key, scenes: { ...(scene ? { [book.player]: scene.id } : {}), ...scenes } }
}
export async function previewRpg(source: string, body: Record<string, unknown>, signal?: AbortSignal) {
  return previewActivityPage(source, trialRequest(source, body), signal, false)
}
function snapshot(view: PlayerView, key: string) {
  const activity = view.activities?.find(a => a.key === key) ?? (view.activity?.key === key ? view.activity : undefined)
  return {
    phase: activity?.phase,
    active: activity?.active ?? false,
    result: activity?.public.lastResult,
    status: view.statusBar
      ?.filter(s => s.self && s.current && typeof s.value === 'number')
      .map(({ key, label, value }) => ({ key, label, value })),
    stage: view.activityStage?.activityKey === key ? view.activityStage.payload : null,
    choices: view.actions
      .filter(a => a.kind === 'activity' && a.target?.id === key)
      .map(a => ({
        operation: String((a.action.parameters.definitionRef as { id: string }).id).replace(/^activity:/, ''),
        label: a.label,
        arguments: a.argumentSchema,
      })),
  }
}
export async function playRpg(source: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const request = trialRequest(source, body),
    turns = body.turns ?? []
  if (!Array.isArray(turns) || turns.length > 64) throw new TypeError('一次试玩最多提交 64 步')
  const { sim, view } = await openPageTrial(source, request, signal)
  try {
    const api = new FrontendActions(sim.previewRuntime),
      initial = snapshot(view, request.key)
    if (!initial.phase || initial.phase === 'not-started') throw new TypeError('未进入所选地图，请检查玩家起点')
    const steps = []
    let current = view
    for (const turn of turns) {
      signal?.throwIfAborted()
      const before = snapshot(current, request.key),
        activity = current.activity
      if (
        !turn ||
        typeof turn.operation !== 'string' ||
        !before.choices.some(o => o.operation === turn.operation) ||
        !activity?.active ||
        activity.key !== request.key ||
        !activity.id ||
        activity.revision === undefined
      )
        throw new TypeError('第 ' + (steps.length + 1) + ' 步不是玩家当前可用的操作')
      const parameters = turn.arguments ?? {}
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))
        throw new TypeError('技能参数需要是对象')
      const trace = await sim.step({
        kind: 'activity',
        request: {
          activityKey: request.key,
          activityId: activity.id,
          revision: activity.revision,
          operation: turn.operation,
          parameters,
        },
      })
      assertStep(trace)
      current = await api.view()
      steps.push({
        operation: turn.operation as string,
        results: trace.lines.filter(l => l.kind === 'activity' && l.activityKey === request.key).map(l => l.text),
        after: snapshot(current, request.key),
      })
    }
    return { key: request.key, initial, steps }
  } finally {
    await sim.close()
  }
}
