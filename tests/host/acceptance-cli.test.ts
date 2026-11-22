import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { exportProject } from '../../apps/host/src/editor/export.ts'
import { runAcceptance } from '../../apps/host/src/simulation/acceptance.ts'

const porch = resolve('examples/world-packs/porch-note')
const investigation = resolve('examples/world-packs/investigation')
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'delivery-test-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function file(name: string, body: unknown) {
  const path = join(root, name)
  writeFileSync(path, JSON.stringify(body))
  return path
}
const parse = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'apps/host/src/cli/worldpack.ts', ...args], { encoding: 'utf8' })
const accept = (pack: string, manifest: string, ...ids: string[]) => runAcceptance(pack, manifest, ids)

it('binds the exported pack, frontend, actual scenario bytes and full or selected porch cases', async () => {
  const out = (await exportProject(porch, join(root, 'export'))).directory
  const qa = join(root, 'qa')
  cpSync(porch, qa, { recursive: true })
  const manifest = join(qa, 'acceptance.json')
  const full = await accept(out, manifest)
  expect(full.exitCode).toBe(0)
  expect(full.report).toMatchObject({
    scope: 'all',
    deliveryPassed: true,
    summary: { planned: 5, executed: 5, passed: 5 },
  })
  expect(full.report.engine.digest).toMatch(/^sha256:/)
  const filtered = cli('accept', out, manifest, '--only', 'empty')
  expect(filtered.status).toBe(0)
  expect(JSON.parse(filtered.stdout)).toMatchObject({
    scope: 'filtered',
    deliveryPassed: false,
    cases: [
      { id: 'empty', status: 'passed' },
      { id: 'opener', status: 'not-run', reason: 'filtered' },
    ],
  })
  const path = join(qa, 'empty.scenario.json')
  const scenario = parse(path)
  scenario.steps[1].expect = { started: 'read-note' } // leave committed an update ending this activity
  writeFileSync(path, JSON.stringify(scenario))
  const wrong = await accept(out, manifest, 'empty')
  expect(wrong.exitCode).toBe(2)
  expect(wrong.report.cases[0]!.checks[1]).toMatchObject({ id: 'leave', status: 'failed' })
  expect(wrong.report.cases[0]!.scenarioDigest).not.toBe(full.report.cases[0]!.scenarioDigest)
  expect(wrong.report.packHash).toBe(full.report.packHash)
  expect(wrong.report.manifestDigest).toBe(full.report.manifestDigest)
  appendFileSync(join(out, 'frontend/activities/note.css'), '\n/* changed */')
  const css = await accept(out, manifest, 'empty')
  expect(css.report.frontendDigest).not.toBe(full.report.frontendDigest)
  expect(css.report.packHash).toBe(full.report.packHash)
  expect(css.report.exportDigest).not.toBe(full.report.exportDigest)
}, 90000)

it('checks a committed rejection and stable private state, and publishes only safe evidence', async () => {
  const out = (await exportProject(investigation, join(root, 'export'))).directory
  const original = await accept(out, join(investigation, 'acceptance.json'))
  expect(original.exitCode).toBe(0)
  expect(original.report.cases[0]?.checks.map(c => c.status)).toEqual(['passed', 'passed', 'passed'])
  const secret = 'PRIVATE-request-or-credential'
  file('negative.json', {
    title: root + secret,
    npcPlans: { 'character:aru': [{ kind: 'say', text: secret }] },
    steps: [
      { id: 'panel', interact: 'not-offered', expect: { error: 'not-offered', panelsExclude: [secret] } },
      { id: 'delivery', interact: 'investigation:search', expect: { contextExcludes: { 'character:aru': secret } } },
      { id: 'wrong', interact: 'investigation:search', expect: { status: { 'character:player.energy': 99 } } },
      {
        id: 'unsubmitted',
        interact: 'not-offered',
        expect: { error: 'not-offered', resolution: { status: 'rejected', code: 'INSUFFICIENT_ENERGY' } },
      },
      { id: 'no-check', action: parse(join(investigation, 'scenario.json')).steps[2].action },
      { interact: 'not-offered' },
      { id: 'never', say: secret, expect: { started: 'anything' } },
    ],
  })
  const manifest = file('plan.json', {
    cases: [
      {
        id: 'negative',
        scenario: 'negative.json',
        required: ['panel', 'delivery', 'wrong', 'unsubmitted', 'no-check', 'never'],
        requiredPlans: ['character:aru'],
      },
    ],
  })
  const result = cli('accept', out, manifest)
  expect(result.status).toBe(2)
  expect(result.stdout).not.toContain(secret)
  expect(result.stdout).not.toContain(root)
  expect(result.stdout).not.toContain('modelInputs')
  const report = JSON.parse(result.stdout)
  expect(report).toMatchObject({
    deliveryPassed: false,
    cases: [
      {
        id: 'negative',
        blockedAt: 5,
        plannedSteps: 7,
        executedSteps: 6,
        checks: [
          { status: 'insufficient', reason: 'panel-not-captured' },
          { status: 'insufficient', reason: 'no-request' },
          { status: 'failed', reason: 'expectation-mismatch' },
          { status: 'insufficient', reason: 'no-resolution' },
          { status: 'insufficient', reason: 'no-assertions' },
          { status: 'not-run', reason: 'earlier-step-error' },
          { status: 'insufficient', reason: 'unused-plan' },
        ],
      },
    ],
  })
}, 60000)

it('fails on a different formal rejection code while allowing a reported empty set of player panels', async () => {
  const scenario = parse(join(investigation, 'scenario.json'))
  const exhausted = scenario.steps[2]
  exhausted.expect.resolution.code = 'WRONG_REJECTION'
  file('wrong-code.json', scenario)
  const manifest = file('manifest.json', {
    cases: [{ id: 'wrong-code', scenario: 'wrong-code.json', required: ['exhausted'] }],
  })
  const wrong = await accept(investigation, manifest)
  expect(wrong.exitCode).toBe(2)
  expect(wrong.report.cases[0]!.checks).toMatchObject([{ status: 'failed', reason: 'expectation-mismatch' }])

  file('empty-panels.json', {
    title: '门廊没有玩法面板',
    steps: [{ id: 'empty', activity: 'read-note', operation: 'start', expect: { panelsExclude: ['线索'] } }],
  })
  const emptyPlan = file('empty-plan.json', {
    cases: [{ id: 'empty-panels', scenario: 'empty-panels.json', required: ['empty'] }],
  })
  expect((await accept(porch, emptyPlan)).exitCode).toBe(0)
}, 60000)

it('gates only named checkpoints and plans, and separates invalid input and Host startup from failures', async () => {
  const scenario = {
    title: '探索',
    npcPlans: { 'character:aru': [{ kind: 'say', text: 'unused' }] },
    steps: [
      { id: 'ok', interact: 'investigation:search', expect: { resolution: { status: 'accepted' } } },
      { id: 'optional', interact: 'investigation:search', expect: { status: { 'character:player.energy': 99 } } },
    ],
  }
  file('good.json', scenario)
  file('startup.json', { ...scenario, start: { scenes: { 'character:invalid': 'scene:invalid' } } })
  const plan = file('plan.json', {
    cases: [
      { id: 'explore', scenario: 'good.json', required: ['ok'] },
      { id: 'bad-file', scenario: 'missing.json', required: ['ok'] },
      { id: 'bad-start', scenario: 'startup.json', required: ['ok'] },
    ],
  })
  const mixed = await accept(investigation, plan)
  expect(mixed.exitCode).toBe(1)
  expect(mixed.report.cases.map(r => r.reason ?? r.status)).toEqual(['passed', 'invalid-scenario', 'host-start-failed'])
  const invalid = cli('accept', investigation, plan, '--only', 'private-invalid-case')
  expect(invalid.status).toBe(1)
  expect(invalid.stderr).not.toContain(root)
  expect(invalid.stderr).not.toContain('private-invalid-case')
  expect(
    JSON.parse(
      invalid.stderr
        .trim()
        .split('\n')
        .find(l => l.startsWith('{'))!,
    ),
  ).toMatchObject({ errorCode: 'INVALID_REQUEST' })
}, 60000)
