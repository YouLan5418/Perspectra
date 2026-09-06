import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorldJsonObject } from '@harness-world/contracts'
import {
  byteHash,
  object,
  type ExperimentActionReference,
  type ExperimentMessage,
} from './compact-context.ts'

export type UtilityIntentResult =
  | { readonly status: 'action'; readonly action: { readonly actionType: 'speak' | 'move' | 'take'; readonly parameters: WorldJsonObject } }
  | { readonly status: 'clarification'; readonly question: string }

const SYSTEM = '你是玩家输入翻译器，不扮演角色、不续写故事。只判断玩家本人此刻要执行的一个动作。规则：①“好，去X”“我们走吧/出发吧/去X吧”等确认现在付诸行动且目标明确的表达选择 move；这只移动玩家本人，其他角色自行决定。②“要不要/是不是/觉得/可以吗”等询问、讨论计划、尚未确认的建议，以及要求某个具名角色或其他人行动，都选择 speak。③玩家明确表示自己现在拿取某物才选择 take。④目标必须使用用户消息提供的短引用；动作或目标确实无法确定才选择 clarification。不得创造目标。严格按 Schema 填写三个字段。'

function schema(references: readonly ExperimentActionReference[]) {
  const variants: Record<string, unknown>[] = [
    {
      type: 'object', additionalProperties: false, required: ['intent', 'targetRef', 'question'],
      properties: {
        intent: { type: 'string', const: 'speak' }, targetRef: { type: 'string', const: '' },
        question: { type: 'string', const: '' },
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['intent', 'targetRef', 'question'],
      properties: {
        intent: { type: 'string', const: 'clarification' }, targetRef: { type: 'string', const: '' },
        question: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
  ]
  const locations = references.filter(reference => reference.kind === 'location').map(reference => reference.short)
  const entities = references.filter(reference => reference.kind === 'entity').map(reference => reference.short)
  if (locations.length > 0) variants.push({
    type: 'object', additionalProperties: false, required: ['intent', 'targetRef', 'question'],
    properties: {
      intent: { type: 'string', const: 'move' }, targetRef: { type: 'string', enum: locations },
      question: { type: 'string', const: '' },
    },
  })
  if (entities.length > 0) variants.push({
    type: 'object', additionalProperties: false, required: ['intent', 'targetRef', 'question'],
    properties: {
      intent: { type: 'string', const: 'take' }, targetRef: { type: 'string', enum: entities },
      question: { type: 'string', const: '' },
    },
  })
  return {
    oneOf: variants,
  } as const
}

function messages(text: string, references: readonly ExperimentActionReference[]): readonly ExperimentMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify({
      text,
      output: { intent: 'speak|move|take|clarification', targetRef: '短引用或空字符串', question: '澄清问题或空字符串' },
      targets: {
        move: references.filter(reference => reference.kind === 'location')
          .map(reference => ({ locationRef: reference.short, name: reference.label })),
        take: references.filter(reference => reference.kind === 'entity')
          .map(reference => ({ entityRef: reference.short, kind: reference.label })),
      },
    }) },
  ]
}

function normalizedResult(
  raw: unknown,
  text: string,
  references: readonly ExperimentActionReference[],
): UtilityIntentResult {
  const value = object(raw)
  if (Object.keys(value).sort().join(',') !== 'intent,question,targetRef'
    || typeof value.intent !== 'string' || typeof value.targetRef !== 'string'
    || typeof value.question !== 'string' || value.question.length > 200) {
    throw new TypeError('utility intent output is malformed')
  }
  if (value.intent === 'speak' && value.targetRef === '' && value.question === '') {
    return { status: 'action', action: { actionType: 'speak', parameters: { text } } }
  }
  if ((value.intent === 'move' || value.intent === 'take') && value.question === '') {
    const kind = value.intent === 'move' ? 'location' : 'entity'
    const reference = references.find(candidate => candidate.kind === kind && candidate.short === value.targetRef)
    if (reference === undefined) throw new TypeError('utility intent target reference is unavailable')
    return { status: 'action', action: {
      actionType: value.intent,
      parameters: value.intent === 'move' ? { locationId: reference.source } : { entityId: reference.source },
    } }
  }
  if (value.intent === 'clarification' && value.targetRef === '' && value.question.trim() === value.question
    && value.question.length > 0) {
    return { status: 'clarification', question: value.question }
  }
  throw new TypeError('utility intent output is contradictory')
}

/** Experimental, non-authoritative natural-language adapter backed by local Ollama. */
export class OllamaUtilityIntentInterpreter {
  #ordinal = 0

  constructor(
    private readonly endpoint: URL,
    private readonly model: string,
    private readonly timeoutMs: number,
    private readonly evidenceDirectory: string,
  ) {}

  async interpret(text: string, references: readonly ExperimentActionReference[]): Promise<UtilityIntentResult> {
    const requestMessages = messages(text, references)
    const body = JSON.stringify({
      model: this.model, messages: requestMessages, stream: false, think: false,
      format: schema(references), options: { temperature: 0, seed: 42, num_predict: 80 }, keep_alive: '10m',
    })
    const evidenceId = `utility-${String(++this.#ordinal).padStart(4, '0')}-${byteHash(text).slice(7, 23)}`
    writeFileSync(resolve(this.evidenceDirectory, `${evidenceId}.request.json`), JSON.stringify({
      model: this.model, messages: requestMessages, actionReferences: references, wireBodyHash: byteHash(body),
    }, null, 2), { flag: 'wx' })
    const response = await fetch(this.endpoint, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`utility model returned HTTP ${response.status}`)
    const envelope = object(await response.json())
    if (envelope.done_reason !== 'stop') throw new TypeError('utility model response was not complete')
    const message = object(envelope.message)
    if (typeof message.content !== 'string') throw new TypeError('utility model returned no content')
    const result = normalizedResult(JSON.parse(message.content), text, references)
    writeFileSync(resolve(this.evidenceDirectory, `${evidenceId}.response.json`), JSON.stringify({
      model: envelope.model, result,
    }, null, 2), { flag: 'wx' })
    return result
  }
}
