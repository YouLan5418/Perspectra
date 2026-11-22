import { randomUUID } from 'node:crypto'
import type { StatusTruth } from '@perspectra/sdk/contracts'
import type { PlayerView } from '@perspectra/frontend'
import type { LensSimulation, LensStep, LensStepTrace } from '../simulation/simulation.ts'
import { FrontendActions } from '../runtime/frontend-adapter.ts'

export function assertStep(step: LensStepTrace) {
  if (step.error || step.fault) throw new TypeError(step.error ?? '插件执行失败：' + step.fault!.pluginId)
  const rejected = step.lines.find(line => line.kind === 'rejected' && line.actorId === step.lines[0]?.actorId)
  if (rejected) throw new TypeError(rejected.text)
}

export const op = (a: PlayerView['actions'][number]) =>
  (a.action.parameters.definitionRef as { id?: string } | undefined)?.id
export function playerControls(sim: LensSimulation, player: string, signal?: AbortSignal) {
  const api = new FrontendActions(sim.previewRuntime)
  async function step(input: LensStep) {
    signal?.throwIfAborted()
    const trace = await sim.step(input)
    assertStep(trace)
    return trace
  }
  async function perform(option: PlayerView['actions'][number] | undefined, missing: string) {
    if (!option) throw new Error(missing)
    const trace = await step({ kind: 'action', action: option.action })
    const resolution = trace.resolutions?.find(r => r.actorId === player && r.actionType === option.action.actionType)
    if (resolution?.accepted !== true) throw new Error(String(resolution?.reason ?? '操作缺少成功裁定'))
  }
  async function itemAction(id: string, operation: string, missing: string) {
    const view = await api.view()
    const option = view.actions.find(a => a.target?.id === id && op(a) === operation)
    await perform(option, missing)
    return option!
  }
  const own = async () => ((await sim.statusTruth()) as unknown as StatusTruth).characters[player] ?? {}
  async function performOption(option: PlayerView['actions'][number]) {
    signal?.throwIfAborted()
    return api.perform({
      requestId: randomUUID(),
      actionId: randomUUID(),
      operation: 'perform',
      payload: { optionId: option.id },
    })
  }
  return { view: () => api.view(), step, perform, itemAction, own, performOption }
}
