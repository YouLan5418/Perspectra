import type { WorldJsonObject } from '@harness-world/contracts'
import type { HostAction, HostState } from '../host/http-server.ts'
import { LensSimulation, type LensNpcPlan, type LensStart, type LensStep, type LensStepTrace } from './simulation.ts'

export interface LensScenarioExpect {
  readonly started?: string
  readonly notStarted?: string
  /** `"slot"` for a public status, `"character:deepseek.mood-note"` for a character's own. */
  readonly status?: Record<string, unknown>
}
/** Player actions are written the way the game names them; the runner matches them against what is offered now. */
export type LensScenarioStep = (
  | { readonly say: string }
  | { readonly move: string }
  | { readonly interact: string; readonly target?: string; readonly arguments?: WorldJsonObject }
  | { readonly activity: string; readonly operation: string; readonly parameters?: WorldJsonObject }
  | { readonly wait: true }
) & { readonly expect?: LensScenarioExpect }
export interface LensScenario {
  readonly title: string
  readonly start?: LensStart
  readonly npcPlans?: Record<string, readonly LensNpcPlan[]>
  readonly steps: readonly LensScenarioStep[]
}
export interface LensExpectation {
  readonly text: string
  readonly ok: boolean
}
export interface LensScenarioResult {
  readonly title: string
  readonly steps: readonly (LensStepTrace & { readonly expectations?: readonly LensExpectation[] })[]
}

type Json = Record<string, unknown>
const fail = (path: string, problem: string): never => {
  throw new TypeError(`${path}：${problem}`)
}
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const record = (value: unknown, path: string): Json => (isObject(value) ? value : fail(path, '需要是对象'))
const text = (value: unknown, path: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fail(path, '需要是非空字符串')
const only = (value: Json, path: string, keys: readonly string[]) => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, '不认识的字段')
}

function parseStart(value: unknown): LensStart {
  const start = record(value, 'start')
  only(start, 'start', ['status', 'scenes', 'skipAutoStart'])
  if (start.status !== undefined) {
    const status = record(start.status, 'start.status')
    only(status, 'start.status', ['public', 'characters'])
    if (status.public !== undefined) record(status.public, 'start.status.public')
    if (status.characters !== undefined)
      for (const [id, values] of Object.entries(record(status.characters, 'start.status.characters')))
        record(values, `start.status.characters.${id}`)
  }
  if (start.scenes !== undefined)
    for (const [id, scene] of Object.entries(record(start.scenes, 'start.scenes'))) text(scene, `start.scenes.${id}`)
  if (start.skipAutoStart !== undefined) {
    if (!Array.isArray(start.skipAutoStart)) fail('start.skipAutoStart', '需要是数组')
    ;(start.skipAutoStart as unknown[]).forEach((key, i) => text(key, `start.skipAutoStart[${i}]`))
  }
  return start as LensStart
}

function parsePlan(value: unknown, path: string): LensNpcPlan {
  const plan = record(value, path)
  if (plan.kind === 'abstain') only(plan, path, ['kind'])
  else if (plan.kind === 'say') {
    only(plan, path, ['kind', 'text'])
    text(plan.text, `${path}.text`)
  } else if (plan.kind === 'perform') {
    only(plan, path, ['kind', 'action'])
    const action = record(plan.action, `${path}.action`)
    if (action.actionType !== 'move' && action.actionType !== 'interact')
      fail(`${path}.action.actionType`, '需要是 move 或 interact')
    record(action.parameters, `${path}.action.parameters`)
  } else fail(`${path}.kind`, '需要是 abstain、say 或 perform')
  return plan as unknown as LensNpcPlan
}

const STEP_KINDS = ['say', 'move', 'interact', 'activity', 'wait'] as const
function parseStep(value: unknown, path: string): LensScenarioStep {
  const step = record(value, path)
  const kinds = STEP_KINDS.filter(kind => step[kind] !== undefined)
  if (kinds.length !== 1) fail(path, `需要恰好写明一种行动：${STEP_KINDS.join('、')}（现在有 ${kinds.length} 种）`)
  const kind = kinds[0]!
  const extra: Record<(typeof STEP_KINDS)[number], readonly string[]> = {
    say: [],
    move: [],
    interact: ['target', 'arguments'],
    activity: ['operation', 'parameters'],
    wait: [],
  }
  only(step, path, [kind, ...extra[kind], 'expect'])
  if (kind === 'wait') {
    if (step.wait !== true) fail(`${path}.wait`, '需要是 true')
  } else text(step[kind], `${path}.${kind}`)
  if (kind === 'activity') text(step.operation, `${path}.operation`)
  if (step.target !== undefined) text(step.target, `${path}.target`)
  for (const key of ['arguments', 'parameters'] as const)
    if (step[key] !== undefined) record(step[key], `${path}.${key}`)
  if (step.expect !== undefined) {
    const expect = record(step.expect, `${path}.expect`)
    only(expect, `${path}.expect`, ['started', 'notStarted', 'status'])
    if (expect.started !== undefined) text(expect.started, `${path}.expect.started`)
    if (expect.notStarted !== undefined) text(expect.notStarted, `${path}.expect.notStarted`)
    if (expect.status !== undefined) record(expect.status, `${path}.expect.status`)
  }
  return step as unknown as LensScenarioStep
}

/** Throws a TypeError whose message starts with the JSON path of the first problem. */
export function parseScenario(value: unknown): LensScenario {
  const scenario = record(value, '$')
  only(scenario, '$', ['title', 'start', 'npcPlans', 'steps'])
  text(scenario.title, 'title')
  if (scenario.start !== undefined) parseStart(scenario.start)
  if (scenario.npcPlans !== undefined)
    for (const [id, plans] of Object.entries(record(scenario.npcPlans, 'npcPlans'))) {
      if (!Array.isArray(plans)) fail(`npcPlans.${id}`, '需要是数组')
      ;(plans as unknown[]).forEach((plan, i) => parsePlan(plan, `npcPlans.${id}[${i}]`))
    }
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) fail('steps', '需要至少一步')
  ;(scenario.steps as unknown[]).forEach((step, i) => parseStep(step, `steps[${i}]`))
  return scenario as unknown as LensScenario
}

class Unmatched extends Error {}

/** Finds the offered option for a step in the current state; throws Unmatched, listing what is offered. */
function resolve(step: LensScenarioStep, state: HostState): LensStep {
  const actions = state.availableActions ?? []
  if ('say' in step) return { kind: 'say', text: step.say }
  if ('wait' in step) return { kind: 'wait' }
  if ('move' in step) {
    const destinations = actions.filter(a => a.actionType === 'move').flatMap(a => a.destinations ?? [])
    if (!destinations.some(d => d.locationId === step.move))
      throw new Unmatched(
        `找不到可去的地点 ${step.move}；当前可去：${destinations.map(d => d.locationId).join('、') || '（无）'}`,
      )
    return { kind: 'action', action: { actionType: 'move', parameters: { locationId: step.move } } }
  }
  if ('interact' in step) {
    const options = actions.filter(a => a.actionType === 'interact').flatMap(a => a.interactions ?? [])
    const idOf = (option: WorldJsonObject) => (option.definitionRef as WorldJsonObject | undefined)?.id
    const targetOf = (option: WorldJsonObject) => (option.targetRef as WorldJsonObject | undefined)?.id
    const found = options.find(
      option => idOf(option) === step.interact && (step.target === undefined || targetOf(option) === step.target),
    )
    if (!found) {
      const ids = [...new Set(options.map(option => String(idOf(option))))]
      throw new Unmatched(
        `找不到交互 ${step.interact}${step.target === undefined ? '' : `（目标 ${step.target}）`}；当前可用的交互：${ids.join('、') || '（无）'}`,
      )
    }
    const action: HostAction = {
      actionType: 'interact',
      parameters: {
        targetRef: found.targetRef!,
        bindingId: found.bindingId!,
        definitionRef: found.definitionRef!,
        arguments: step.arguments ?? found.arguments ?? {},
      },
    }
    return { kind: 'action', action }
  }
  const view = (state.activities ?? []).find(a => a.activityKey === step.activity)
  if (!view)
    throw new Unmatched(
      `找不到活动 ${step.activity}；当前活动：${(state.activities ?? []).map(a => String(a.activityKey)).join('、') || '（无）'}`,
    )
  return {
    kind: 'activity',
    request: {
      activityKey: step.activity,
      activityId: typeof view.id === 'string' ? view.id : null,
      revision: typeof view.revision === 'number' ? view.revision : 0,
      operation: step.operation,
      parameters: step.parameters ?? {},
    },
  }
}

const show = (value: unknown) => JSON.stringify(value)
function statusValue(truth: WorldJsonObject, key: string): unknown {
  if (key.startsWith('character:')) {
    const dot = key.indexOf('.')
    if (dot < 0) return undefined
    return (truth.characters as Record<string, WorldJsonObject> | undefined)?.[key.slice(0, dot)]?.[key.slice(dot + 1)]
  }
  return (truth.public as WorldJsonObject | undefined)?.[key]
}

async function check(
  sim: LensSimulation,
  expect: LensScenarioExpect,
  trace: LensStepTrace,
): Promise<LensExpectation[]> {
  const startedKeys = new Set([
    ...trace.autoStart.filter(e => e.started).map(e => e.activityKey),
    ...trace.lines.filter(l => l.kind === 'activity').map(l => /（([^（）]+)）：/u.exec(l.text)?.[1] ?? ''),
  ])
  const results: LensExpectation[] = []
  if (expect.started !== undefined)
    results.push({ text: `活动 ${expect.started} 开始了`, ok: startedKeys.has(expect.started) })
  if (expect.notStarted !== undefined)
    results.push({ text: `活动 ${expect.notStarted} 没有开始`, ok: !startedKeys.has(expect.notStarted) })
  if (expect.status !== undefined) {
    const truth = await sim.statusTruth()
    for (const [key, wanted] of Object.entries(expect.status)) {
      const actual = statusValue(truth, key)
      const ok = show(actual) === show(wanted)
      results.push({ text: `状态 ${key} 为 ${show(wanted)}${ok ? '' : `（实际 ${show(actual ?? '（无）')}）`}`, ok })
    }
  }
  return results
}

/** Runs a scenario's NPC plans and steps on an already-open simulation. Stops after the first step that errors. */
export async function applyScenario(sim: LensSimulation, scenario: LensScenario): Promise<LensScenarioResult> {
  if (scenario.npcPlans) sim.setNpcPlans(scenario.npcPlans)
  const steps: LensScenarioResult['steps'][number][] = []
  for (const [position, scenarioStep] of scenario.steps.entries()) {
    let trace: LensStepTrace
    try {
      trace = await sim.step(resolve(scenarioStep, await sim.state()))
    } catch (cause) {
      if (!(cause instanceof Unmatched)) throw cause
      const placeholder: LensStep = { kind: 'action', action: { actionType: 'interact', parameters: {} } }
      trace = { index: position, step: placeholder, lines: [], autoStart: [], activated: [], error: cause.message }
    }
    const expectations = scenarioStep.expect ? await check(sim, scenarioStep.expect, trace) : undefined
    steps.push(expectations ? { ...trace, expectations } : trace)
    if (trace.error !== undefined) break
  }
  return { title: scenario.title, steps }
}

export async function runScenario(packPath: string, scenario: LensScenario): Promise<LensScenarioResult> {
  const sim = await LensSimulation.open(packPath, scenario.start)
  try {
    return await applyScenario(sim, scenario)
  } finally {
    await sim.close()
  }
}
