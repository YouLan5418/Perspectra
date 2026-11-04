/** Offline before/after probe. Run from the repository root with `node --import tsx`.
 * `record <file>` first verifies two independent runs; `compare <file>` checks a later implementation.
 * Only fake endpoints are used. Headers, credentials, transport timing and local paths are not captured. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ProviderProtocol } from '@harness-world/provider-chat'
import { WorldHostRuntime, type WorldHostOptions } from '../../desktop/host/world-runtime.ts'
import { withCoreMemory } from '../support/core-memory-options.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'

interface Scenario {
  name: string
  pack?: string
  protocol?: ProviderProtocol
  options?: Partial<WorldHostOptions>
  core?: boolean
  activity?: boolean
  lines?: readonly string[]
}
const scenarios: readonly Scenario[] = [
  { name: 'default' },
  { name: 'preset', options: { preset: { prompt: '保持角色自己的语气，简洁表达。' } } },
  { name: 'google', protocol: 'google' },
  { name: 'anthropic', protocol: 'anthropic' },
  { name: 'expressions', options: { stageExpressions: { 'character:companion': ['smile', 'calm'] } } },
  { name: 'core', core: true },
  { name: 'sweet', pack: 'model-girls-sweet-days', lines: ['你好。'] },
  { name: 'market', pack: 'status-market' },
  { name: 'awaken', pack: 'ai-girls-awaken-v10', activity: true, lines: [] },
  { name: 'scripted', pack: 'scripted-performance', activity: true, lines: [] },
  { name: 'autonomy-staged', pack: 'autonomy-scheduling', options: { stagedAutonomy: true } },
  { name: 'autonomy-integrated', pack: 'autonomy-scheduling', options: { serialScheduling: false } },
]

function normalized(value: unknown): unknown {
  const ids = new Map<string, string>()
  // UUIDs and ISO wall-clock dates are ephemeral. Keep all audiences, source sequences and semantic text.
  const text = JSON.stringify(value)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, id => {
      if (!ids.has(id)) ids.set(id, `uuid-${ids.size + 1}`)
      return ids.get(id)!
    })
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu, 'wall-clock')
  return JSON.parse(text)
}

async function capture(scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), 'perspectra-seams-probe-'))
  const protocol = scenario.protocol ?? 'openai'
  const server = await startFakeProvider(protocol, () => ({ tool: { decision: 'abstain' } }))
  let runtime: WorldHostRuntime | undefined
  const random = Math.random
  Math.random = () => 0.25
  try {
    const options: WorldHostOptions = {
      dataDirectory: root,
      packPath: resolve('examples/world-packs', scenario.pack ?? 'dynamic-scheduling'),
      models: fakeModels(server.endpoint, protocol),
      serialScheduling: true,
      ...scenario.options,
    }
    runtime = await WorldHostRuntime.create(scenario.core ? withCoreMemory({
      ...options, memoryCore: true,
      memoryCoreRun: async () => ({ delivery: [], deliveryTrace: { delivered: [], activityCoverage: [] } }),
      memoryCoreBuildRun: async input => ({
        archive: { scope: input.scope!, sources: input.sources!, facts: [], episodes: [], observations: [] },
        index: { scope: input.scope!, units: [], vectors: [] },
      }),
    }) : options)
    if (scenario.activity) {
      const activity = (await runtime.state()).activities?.[0]
      assert(activity, 'activity fixture must declare an activity')
      await runtime.activityAction({ activityKey: String(activity.activityKey), activityId: null,
        revision: 0, operation: 'start', parameters: {}, requestId: 'probe-start' })
    }
    const states = []
    const lines = scenario.lines ?? ['你好。', '你愿意说说现在想做什么吗？']
    for (const line of [undefined, ...lines]) {
      const state = line === undefined ? await runtime.state() : await runtime.submit(line)
      states.push({ transcript: state.transcript, notice: state.notice, error: state.error,
        scene: state.world.currentScene, actions: state.availableActions,
        activation: state.debug.activationCycle, autonomy: state.debug.autonomy,
        headSeq: state.debug.headSeq, tick: state.debug.tick })
    }
    const requests = server.calls.map(call => call.body)
    if (!scenario.activity) assert(requests.length > 0, scenario.name + ' must send a request')
    return normalized({ requests, states })
  } finally {
    await runtime?.close()
    await server.close()
    Math.random = random
    rmSync(root, { recursive: true, force: true })
  }
}

const [mode, file] = process.argv.slice(2)
assert((mode === 'record' || mode === 'compare') && file, 'expected: record|compare <file>')
const captures: Record<string, unknown> = {}
for (const scenario of scenarios) {
  captures[scenario.name] = await capture(scenario)
  if (mode === 'record') assert.deepEqual(await capture(scenario), captures[scenario.name], scenario.name + ' is unstable')
  process.stdout.write(scenario.name + ': captured\n')
}
if (mode === 'record') {
  mkdirSync(dirname(resolve(file)), { recursive: true })
  writeFileSync(file, JSON.stringify(captures, null, 2) + '\n')
} else assert.deepEqual(captures, JSON.parse(readFileSync(file, 'utf8')), 'decision baseline changed')
process.stdout.write('Baseline ' + mode + ' passed.\n')
