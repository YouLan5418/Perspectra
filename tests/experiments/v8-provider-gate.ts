import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorldPlaytestRuntime } from './playtest-runtime.ts'

// Paid/manual experiment. It is intentionally not part of the automatic test suite.
const INPUTS = [
  '大家先分别介绍自己，并说说眼前最想确认的事。',
  '/interact entity:phone core:take',
  '你们看见我刚才拿手机了吗？各自怎么想？',
  '/move location:living-room',
  '到客厅后，谁愿意先看看这里有什么？',
] as const

type Provider = 'deepseek' | 'ollama'

interface InvalidEvidence {
  readonly validationError?: unknown
  readonly reasonCode?: unknown
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * ratio) - 1] ?? null
}

function providerFromArgs(): Provider {
  const args = process.argv.slice(2)
  if (args.length !== 1 || (args[0] !== '--deepseek' && args[0] !== '--ollama')) {
    throw new TypeError('usage: v8-provider-gate.ts --deepseek|--ollama')
  }
  return args[0] === '--deepseek' ? 'deepseek' : 'ollama'
}

function countCalls(debug: Record<string, unknown>): number {
  if (!Number.isSafeInteger(debug.providerCalls) || (debug.providerCalls as number) < 0) {
    throw new TypeError('playtest provider call counter is unavailable')
  }
  return debug.providerCalls as number
}

async function main(): Promise<void> {
  const provider = providerFromArgs()
  const model = provider === 'deepseek' ? 'deepseek-flash' : 'qwen3.5:4b'
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (provider === 'deepseek' && !apiKey) throw new TypeError('DeepSeek credential unavailable')
  const dataDirectory = resolve('.tmp', `v8-provider-gate-${provider}-${timestamp()}`)
  mkdirSync(dataDirectory, { recursive: true })
  const runtime = await WorldPlaytestRuntime.create({
    dataDirectory,
    packPath: resolve('examples/world-packs/ai-girls-awaken.worldpack.json'),
    interactionsPath: resolve('examples/world-packs/ai-girls-awaken.interactions.json'),
    provider,
    model,
    ...(provider === 'deepseek' ? { apiKey: apiKey! } : {}),
  })
  const turns: Array<{ readonly inputOrdinal: number; readonly providerCalls: number; readonly notice: string }> = []
  const targetCalls = provider === 'deepseek' ? 20 : 4
  try {
    for (let index = 0; index < INPUTS.length; index += 1) {
      const state = await runtime.submit(INPUTS[index]!)
      const providerCalls = countCalls(state.debug)
      turns.push({ inputOrdinal: index + 1, providerCalls, notice: state.notice })
      if (providerCalls >= targetCalls) break
    }
  } finally {
    await runtime.close()
  }

  const evidenceDirectory = resolve(dataDirectory, 'requests')
  const files = readdirSync(evidenceDirectory).sort()
  const requestFiles = files.filter(file => file.endsWith('.request.json'))
  const responseFiles = files.filter(file => file.endsWith('.response.json'))
  const invalidFiles = files.filter(file => file.endsWith('.invalid.json'))
  const failureFiles = files.filter(file => file.endsWith('.failure.json'))
  const invalidEvidence = invalidFiles.map(file => ({
    file,
    value: JSON.parse(readFileSync(resolve(evidenceDirectory, file), 'utf8')) as InvalidEvidence,
  }))
  const validationErrors = invalidEvidence.map(item => ({
    file: item.file,
    reasonCode: typeof item.value.reasonCode === 'string' ? item.value.reasonCode : 'unclassified',
    validationError: typeof item.value.validationError === 'string' ? item.value.validationError : 'unclassified',
  }))
  const terminalFiles = [...responseFiles, ...invalidFiles, ...failureFiles]
  const responseDurations = responseFiles.map(file => {
    const value = JSON.parse(readFileSync(resolve(evidenceDirectory, file), 'utf8')) as { readonly durationMs?: unknown }
    return typeof value.durationMs === 'number' ? value.durationMs : null
  }).filter((value): value is number => value !== null)
  const invalidDurations = invalidEvidence.map(item => typeof (item.value as { readonly durationMs?: unknown }).durationMs === 'number'
    ? (item.value as { readonly durationMs: number }).durationMs : null).filter((value): value is number => value !== null)
  const durations = [...responseDurations, ...invalidDurations]
  const structuralFailures = validationErrors.filter(item => /independent|onSuccess|anyOf|allOf|not|contains/u.test(item.validationError))
  const calls = requestFiles.length
  const classified = terminalFiles.length === calls && validationErrors.every(item => item.reasonCode !== 'unclassified'
    && item.validationError !== 'unclassified')
  const deepseekGatePassed = provider === 'deepseek' && calls >= 20 && invalidFiles.length / calls <= 0.1
    && failureFiles.length === 0 && classified && structuralFailures.length === 0
  const summary = {
    experiment: 'v8-provider-gate/v1',
    provider,
    model,
    targetCalls,
    calls,
    validResponses: responseFiles.length,
    invalidResponses: invalidFiles.length,
    transportFailures: failureFiles.length,
    invalidRatePermille: calls === 0 ? null : Math.round(invalidFiles.length * 1000 / calls),
    classified,
    structuralFailureCount: structuralFailures.length,
    deepseekGatePassed,
    completedInputCount: turns.length,
    turns,
    durationMs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95) },
    validationErrors,
    evidenceFiles: { requests: requestFiles, responses: responseFiles, invalid: invalidFiles, failures: failureFiles },
    caveat: provider === 'deepseek'
      ? 'Paid C0 target run. The key and vendor envelope are not persisted.'
      : 'Diagnostic-only local Provider run; it does not decide the DeepSeek release gate.',
  }
  writeFileSync(resolve(dataDirectory, 'gate-summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ dataDirectory, ...summary }, null, 2))
  if (provider === 'deepseek' && !deepseekGatePassed) process.exitCode = 1
}

await main()
