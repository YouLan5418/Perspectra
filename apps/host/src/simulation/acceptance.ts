import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { compileWorldPackSource } from '@perspectra/world-pack'
import { loadPackWeb } from '../runtime/pack-frontend.ts'
import {
  applyScenario,
  parseScenario,
  unexpectedStepError,
  validCheckId,
  type LensScenario,
  type LensScenarioResult,
} from './scenario.ts'
import { LensSimulation } from './simulation.ts'
import { digest, engineIdentity, exportDigest } from './acceptance-identity.ts'

interface AcceptanceCase {
  id: string
  scenario: string
  required: string[]
  requiredPlans?: string[]
}
type Outcome = 'passed' | 'failed' | 'not-run' | 'insufficient'
interface Check {
  id: string
  status: Outcome
  reason?: string
  assertion?: number
}
interface CaseReport {
  id: string
  status: Outcome
  reason?: string
  scenarioDigest?: string
  plannedSteps?: number
  executedSteps?: number
  checks: Check[]
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
function strings(v: unknown, valid: (value: unknown) => boolean): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(valid) && new Set(v).size === v.length
}
function parseManifest(bytes: Buffer): AcceptanceCase[] {
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  if (
    !object(value) ||
    Object.keys(value).some(k => k !== 'cases') ||
    !Array.isArray(value.cases) ||
    !value.cases.length
  )
    throw new Error('invalid-manifest')
  const seen = new Set<string>()
  return value.cases.map(row => {
    if (
      !object(row) ||
      !validCheckId(row.id) ||
      seen.has(row.id) ||
      Object.keys(row).some(k => !['id', 'scenario', 'required', 'requiredPlans'].includes(k)) ||
      typeof row.scenario !== 'string' ||
      row.scenario.split('/').some(p => !p || p === '.' || p === '..' || /[:\\]/u.test(p)) ||
      !strings(row.required, validCheckId) ||
      (row.requiredPlans !== undefined &&
        !strings(row.requiredPlans, id => typeof id === 'string' && /^character:[a-zA-Z0-9_-]+$/u.test(id)))
    )
      throw new Error('invalid-case')
    seen.add(row.id)
    return {
      id: row.id,
      scenario: row.scenario,
      required: row.required,
      ...(row.requiredPlans ? { requiredPlans: row.requiredPlans } : {}),
    }
  })
}

function plan(row: AcceptanceCase, reason: string): CaseReport {
  const ids = [...row.required, ...(row.requiredPlans ?? []).map(id => 'plan/' + id)]
  return { id: row.id, status: 'not-run', reason, checks: ids.map(id => ({ id, status: 'not-run', reason })) }
}

function summarize(row: AcceptanceCase, scenario: LensScenario, result: LensScenarioResult): CaseReport {
  const checks: Check[] = row.required.map(id => {
    const index = scenario.steps.findIndex(s => s.id === id)
    const step = result.steps[index]
    if (!step) return { id, status: 'not-run', reason: 'earlier-step-error' }
    const expectations = step.expectations ?? []
    if (!expectations.length) return { id, status: 'insufficient', reason: 'no-assertions' }
    const assertion = expectations.findIndex(e => !e.ok && !e.missing)
    if (assertion >= 0) return { id, status: 'failed', reason: 'expectation-mismatch', assertion }
    const missing = expectations.findIndex(e => !!e.missing)
    if (missing >= 0) return { id, status: 'insufficient', reason: expectations[missing]!.missing!, assertion: missing }
    return { id, status: 'passed' }
  })
  for (const actor of row.requiredPlans ?? []) {
    const id = 'plan/' + actor
    if (result.steps.some(s => s.lines.some(l => l.actorId === actor && l.planUnmatched)))
      checks.push({ id, status: 'failed', reason: 'plan-action-unavailable' })
    else if (result.unusedNpcPlans?.[actor]) checks.push({ id, status: 'insufficient', reason: 'unused-plan' })
    else checks.push({ id, status: 'passed' })
  }
  const unexpected = result.steps.findIndex((step, i) => unexpectedStepError(step, scenario.steps[i]?.expect))
  const status =
    unexpected >= 0 || checks.some(c => c.status === 'failed')
      ? 'failed'
      : checks.some(c => c.status !== 'passed')
        ? 'insufficient'
        : 'passed'
  return {
    id: row.id,
    status,
    ...(unexpected >= 0 ? { reason: 'unexpected-step-error', blockedAt: unexpected } : {}),
    plannedSteps: scenario.steps.length,
    executedSteps: result.steps.length,
    checks,
  }
}

async function runCase(row: AcceptanceCase, directory: string, pack: string) {
  let scenarioDigest: string | undefined
  let stage = 'invalid-scenario'
  try {
    const path = await realpath(resolve(directory, row.scenario))
    const rel = relative(directory, path)
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error()
    const bytes = await readFile(path)
    scenarioDigest = digest(bytes)
    const scenario = parseScenario(JSON.parse(bytes.toString('utf8')))
    if (
      row.required.some(id => !scenario.steps.some(s => s.id === id)) ||
      row.requiredPlans?.some(id => !scenario.npcPlans?.[id]?.length)
    )
      throw new Error()
    stage = 'host-start-failed'
    // Delivery runs the supplied export directly; only exploratory simulate materializes editor drafts.
    const sim = await LensSimulation.open(pack, scenario.start)
    try {
      stage = 'runner-error'
      const result = await applyScenario(sim, scenario)
      return { report: { ...summarize(row, scenario, result), scenarioDigest }, invalid: false }
    } finally {
      await sim.close()
    }
  } catch {
    return { report: { ...plan(row, stage), ...(scenarioDigest ? { scenarioDigest } : {}) }, invalid: true }
  }
}

/** Share only public IDs, counts, reason codes and digests. Scenario traces stay in the local simulate command. */
export async function runAcceptance(pack: string, file: string, filter: readonly string[]) {
  const bytes = await readFile(file)
  const cases = parseManifest(bytes)
  if (filter.some(id => !cases.some(c => c.id === id)) || new Set(filter).size !== filter.length)
    throw new Error('invalid-filter')
  const directory = await realpath(dirname(file))
  const engine = engineIdentity()
  const root = await mkdtemp(join(tmpdir(), 'perspectra-acceptance-'))
  const reports = cases.map(c => plan(c, 'filtered'))
  let exitCode = 0
  let snapshotDigest: string | null = null
  let packHash: string | null = null
  let frontendDigest: string | null = null
  try {
    const snapshot = join(root, 'pack')
    await cp(pack, snapshot, { recursive: true })
    snapshotDigest = await exportDigest(snapshot)
    packHash = (await compileWorldPackSource(snapshot)).packHash
    frontendDigest = (await loadPackWeb(snapshot))?.digest ?? null
    for (const [i, row] of cases.entries()) {
      if (filter.length && !filter.includes(row.id)) continue
      const { report, invalid } = await runCase(row, directory, snapshot)
      reports[i] = report
      if (invalid) exitCode = 1
      else if (report.status !== 'passed' && !exitCode) exitCode = 2
    }
  } catch {
    exitCode = 1
    for (const [i, row] of cases.entries())
      if (!filter.length || filter.includes(row.id)) reports[i] = plan(row, 'invalid-export')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  if (engine.kind === 'unknown') exitCode = 1
  const checks = reports.flatMap(r => r.checks)
  const count = (status: Outcome) => checks.filter(c => c.status === status).length
  return {
    exitCode,
    report: {
      command: 'accept',
      scope: filter.length ? 'filtered' : 'all',
      deliveryPassed: !filter.length && exitCode === 0 && engine.kind !== 'unknown',
      manifestDigest: digest(bytes),
      exportDigest: snapshotDigest,
      packHash,
      frontendDigest,
      engine,
      cases: reports,
      summary: {
        planned: checks.length,
        executed: checks.length - count('not-run'),
        passed: count('passed'),
        failed: count('failed'),
        notRun: count('not-run'),
        insufficient: count('insufficient'),
      },
      ...(engine.kind === 'unknown' ? { identityWarning: 'engine-unidentified' } : {}),
    },
  }
}
