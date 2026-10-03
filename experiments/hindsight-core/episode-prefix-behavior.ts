/** Paired saved-request decisions. No world store, execution or fabricated continuation. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Ajv } from 'ajv'
import { createChatProvider } from '@harness-world/provider-chat'
import type { PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { localPrototypeTurnCall } from '../../tests/experiments/local-prototype-turn-call.ts'

type Mode = 'native' | 'old' | 'new'
type Json = Record<string, unknown>
type Comparison = { traceId: string; originalResponse: unknown; requests: Record<Mode, PrototypeTurnRequest> }
const arguments_ = process.argv.slice(2)
const tracesArg = arguments_.find(value => value.startsWith('--traces='))
const traceFilter = tracesArg?.slice('--traces='.length).split(',')
const modesArg = arguments_.find(value => value.startsWith('--modes='))
const [studyArg, repeatTrace] = arguments_.filter(value => !value.startsWith('--modes=') && !value.startsWith('--traces='))
const modes = (modesArg?.slice('--modes='.length).split(',') ?? ['native', 'old', 'new']) as Mode[]
if (modes.length === 0 || new Set(modes).size !== modes.length
  || modes.some(mode => !['native', 'old', 'new'].includes(mode))) throw new Error('invalid comparison modes')
const repetitions = repeatTrace === undefined ? 1 : 5
if (!studyArg) throw new Error('provide completed prefix study directory')
const study = resolve(studyArg)
const protocol = JSON.parse(readFileSync(resolve(study, 'protocol.json'), 'utf8')) as { model: string }
const model = process.env.HCW_LOCAL_MODEL || 'gemini-3.7-flash'
if (model !== protocol.model) throw new Error('model differs from frozen protocol')
const apiKey = process.env.HCW_LOCAL_API_KEY?.trim()
const provider = createChatProvider({
  endpoint: new URL(process.env.HCW_LOCAL_ENDPOINT || 'http://127.0.0.1:8045/v1/chat/completions'),
  model, toolName: 'prototype_turn', timeoutMs: 90_000, maxOutputTokens: 1400,
  ...(apiKey === undefined ? {} : { apiKey }),
})
const ajv = new Ajv({ strict: false, allErrors: true })
const comparisons = readdirSync(resolve(study, 'retrieval')).filter(file => file.endsWith('.json')).sort()
  .map(file => JSON.parse(readFileSync(resolve(study, 'retrieval', file), 'utf8')) as Comparison)
  .filter(comparison => comparison.originalResponse !== null)
if (comparisons.length !== 135) throw new Error('expected 135 returned original calls, got ' + comparisons.length)
const directory = resolve(study, repeatTrace === undefined ? 'behavior' : 'behavior-confirmation')
mkdirSync(directory, { recursive: true })
function write(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value, null, 2)) }
function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function object(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
}
function validateDecision(response: unknown, request: PrototypeTurnRequest, schema: object) {
  const validator = ajv.compile(schema)
  const wireSchemaValid = validator(response)
  const value = object(response)
  const decision = value?.decision
  let allowed: string[] = []
  let structureValid = true
  if (decision === 'abstain') allowed = ['decision']
  else if (decision === 'publish') allowed = ['decision', 'speech', 'narration', 'addresseeIds']
  else if (decision === 'recall') {
    allowed = ['decision', 'query']
    structureValid = request.canRecall === true && typeof value?.query === 'string'
      && value.query.trim().length >= 2 && value.query.length <= 120
  } else if (decision === 'perform') {
    allowed = ['decision', 'actionType', 'parameters']
    structureValid = (request.canPerform ?? !request.continuation) && object(value?.parameters) !== undefined
      && (value?.actionType === 'move' || value?.actionType === 'interact')
    const keys = Object.keys(object(value?.parameters) ?? {})
    structureValid &&= keys.every(key => (value?.actionType === 'move'
      ? ['locationId'] : ['targetRef', 'bindingId', 'definitionRef', 'arguments']).includes(key))
  } else structureValid = false
  structureValid &&= value !== undefined && Object.keys(value).every(key => allowed.includes(key))
  return { wireSchemaValid, structureValid, schemaErrors: validator.errors,
    limits: 'wire schema and response shape only; Rulebook execution not evaluated' }
}
const selected = (repeatTrace === undefined ? comparisons : comparisons.filter(c => c.traceId === repeatTrace))
  .filter(c => traceFilter === undefined || traceFilter.includes(c.traceId))
if (traceFilter !== undefined && selected.length !== new Set(traceFilter).size) throw new Error('unknown or repeated selected trace')
if (selected.length === 0) throw new Error('unknown confirmation trace')
const jobs = selected.flatMap((comparison, index) => Array.from({ length: repetitions }, (_, repetition) =>
  Array.from({ length: modes.length }, (_, offset) => ({ comparison, repetition, mode: modes[(index + repetition + offset) % modes.length]! }))).flat())
let cursor = 0
let stopped: Error | undefined
async function worker() {
  while (cursor < jobs.length && stopped === undefined) {
    const { comparison, mode, repetition } = jobs[cursor++]!
    const path = resolve(directory, comparison.traceId + '-' + mode + (repeatTrace === undefined ? '' : '-repeat-' + repetition) + '.json')
    const delivered = comparison.requests[mode]
    const call = localPrototypeTurnCall(delivered)
    const inputHash = hash(call)
    if (existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Json
      if (saved.inputHash !== inputHash) throw new Error('cached request changed')
      if (saved.response !== null && saved.error === undefined) continue
      write(path + '.attempt-' + Date.now() + '.json', saved)
    }
    const record: Json = { traceId: comparison.traceId, mode, model, inputHash, repetition,
      deliveredRequest: delivered, modelCall: call, response: null,
      limits: 'one fresh first decision per mode; proposals not executed; recall requests not followed up' }
    write(path, record)
    const start = Date.now()
    try {
      const response = await provider.decide(call, AbortSignal.timeout(90_000))
      record.response = response
      record.elapsedMs = Date.now() - start
      record.validation = validateDecision(response, delivered, call.schema)
      write(path, record)
      process.stdout.write(JSON.stringify({ traceId: comparison.traceId, mode, elapsedMs: record.elapsedMs,
        decision: object(response)?.decision, actionType: object(response)?.actionType }) + '\n')
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      record.elapsedMs = Date.now() - start
      write(path, record)
      stopped = error instanceof Error ? error : new Error(String(error))
    }
  }
}
await Promise.all([worker(), worker(), worker()])
if (stopped !== undefined) throw stopped
write(resolve(study, repeatTrace === undefined ? 'behavior-complete.json' : 'behavior-confirmation-complete.json'), { originalReturnedCalls: selected.length, freshCalls: jobs.length,
  model, modes, comparisonUnit: 'identical saved first decision request; independent stochastic samples',
  worldActionsExecuted: 0 })
process.stdout.write(JSON.stringify({ freshCalls: jobs.length, completed: true }) + '\n')
