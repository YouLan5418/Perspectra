import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ManifestationChannel, ManifestationProposal, WorldJsonObject } from '@harness-world/contracts'
import {
  byteHash,
  object,
  type ExperimentActionReference,
  type ExperimentMessage,
} from './compact-context.ts'

export type UtilityIntentResult =
  | {
      readonly status: 'action'
      readonly action: { readonly actionType: 'speak' | 'move' | 'take' | 'interact'; readonly parameters: WorldJsonObject }
      readonly manifestation?: ManifestationProposal
    }
  | { readonly status: 'clarification'; readonly question: string }

const SYSTEM = '你是玩家输入翻译器，不扮演角色、不续写故事。只判断玩家本人此刻要执行的一个动作。规则：①完整的提问、陈述、讨论和对白必须选择 speak；绝不能因为 targets 非空就要求用户在 move/take 中选择。②“好，去X”“我们走吧/出发吧/去X吧”等确认现在付诸行动且目标明确的表达选择 move；这只移动玩家本人，其他角色自行决定。③“要不要/是不是/觉得/可以吗”等询问、讨论计划、尚未确认的建议，以及要求某个具名角色或其他人行动，都选择 speak。④玩家明确表示自己现在拿取某物才选择 take。⑤目标必须使用用户消息提供的短引用；clarification 只用于玩家明确要行动、但动作或目标确实无法确定的情况。不得创造目标。严格按提供的 Schema 填写字段。'

const MANIFESTATION_SYSTEM = '同时提取玩家明确写出的外部可观察表现。舞台动作常用全角或半角括号（…）(…)或星号*…*标记，提取时剥掉这些标记符号，只保留标记内与括号外的真实文字。spokenText 必须是原文中括号外连续出现的对白，没有说话则为空。manifestationCues 只允许原文中逐字出现的表情、视线、姿态、手势、语气或外观变化，每项 description 必须是原文中的连续片段且不含标记符号。voice 通道只描述说话时的语气或声音特征（如“声音颤抖”“压低声音”“语气迟疑”），绝不能把台词本身当作 voice；台词只放 spokenText，spokenText 不得与任一 voice description 重复。不得推断、改写或补充情绪、动机、秘密和心理数值。没有表现则返回空数组。纯表现而没有 speak/move/take 主行为时返回 clarification，不能伪造对白。严格按 Schema 填写五个字段。'

const CLARIFICATION_SYSTEM = `${SYSTEM} 你正在处理上一条输入的澄清答复。答复只用于消除歧义，不是新的角色对白；若用户确认 speak，最终对白必须是 originalText，不能是 answer。`

/** Questions and conversational utterances that are safer to preserve verbatim than to send through an action classifier. */
export function isDefinitelyPlayerSpeech(text: string): boolean {
  const normalized = text.trim()
  return /[?？]$/u.test(normalized)
    || /^(?:发生了什么|怎么了|为什么|谁(?:在|是|会|能|要|把|拿|去|来|说)|哪里|哪儿|什么时候)/u.test(normalized)
    || /(?:吗|呢)$/u.test(normalized)
}

/** Explicit stage-direction notation opts into the utility model even when the line is a question. */
export function hasExplicitPlayerPerformance(text: string): boolean {
  return /[（(][^）)]+[）)]/u.test(text) || /\*[^*]+\*/u.test(text)
}

function schema(references: readonly ExperimentActionReference[], manifestationEnabled: boolean) {
  const manifestationProperties = manifestationEnabled ? {
    spokenText: { type: 'string', maxLength: 2_048 },
    manifestationCues: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object', additionalProperties: false, required: ['channel', 'description'],
        properties: {
          channel: { type: 'string', enum: ['facial', 'gaze', 'posture', 'gesture', 'voice', 'appearance'] },
          description: { type: 'string', minLength: 1, maxLength: 512 },
        },
      },
    },
  } : {}
  const required = manifestationEnabled
    ? ['intent', 'targetRef', 'question', 'spokenText', 'manifestationCues']
    : ['intent', 'targetRef', 'question']
  const variant = (properties: Record<string, unknown>) => ({
    type: 'object', additionalProperties: false, required,
    properties: { ...properties, ...manifestationProperties },
  })
  const variants: Record<string, unknown>[] = [
    variant({
        intent: { type: 'string', const: 'speak' }, targetRef: { type: 'string', const: '' },
        question: { type: 'string', const: '' },
      }),
    variant({
        intent: { type: 'string', const: 'clarification' }, targetRef: { type: 'string', const: '' },
        question: { type: 'string', minLength: 1, maxLength: 200 },
      }),
  ]
  const locations = references.filter(reference => reference.kind === 'location').map(reference => reference.short)
  const entities = references.filter(reference => reference.kind === 'entity').map(reference => reference.short)
  if (locations.length > 0) variants.push(variant({
      intent: { type: 'string', const: 'move' }, targetRef: { type: 'string', enum: locations },
      question: { type: 'string', const: '' },
    }))
  if (entities.length > 0) variants.push(variant({
      intent: { type: 'string', const: 'take' }, targetRef: { type: 'string', enum: entities },
      question: { type: 'string', const: '' },
    }))
  return {
    oneOf: variants,
  } as const
}

function outputShape(manifestationEnabled: boolean) {
  return manifestationEnabled
    ? {
        intent: 'speak|move|take|clarification', targetRef: '短引用或空字符串', question: '澄清问题或空字符串',
        spokenText: '原文中括号外的对白片段或空字符串',
        manifestationCues: [{ channel: 'facial|gaze|posture|gesture|voice|appearance', description: '原文中剥掉标记符号后的表现片段' }],
      }
    : { intent: 'speak|move|take|clarification', targetRef: '短引用或空字符串', question: '澄清问题或空字符串' }
}

function messages(
  text: string,
  references: readonly ExperimentActionReference[],
  manifestationEnabled: boolean,
): readonly ExperimentMessage[] {
  return [
    { role: 'system', content: manifestationEnabled ? `${SYSTEM} ${MANIFESTATION_SYSTEM}` : SYSTEM },
    { role: 'user', content: JSON.stringify({
      text,
      output: outputShape(manifestationEnabled),
      targets: {
        move: references.filter(reference => reference.kind === 'location')
          .map(reference => ({ locationRef: reference.short, name: reference.label })),
        take: references.filter(reference => reference.kind === 'entity')
          .map(reference => ({ entityRef: reference.short, kind: reference.label })),
      },
    }) },
  ]
}

function clarificationMessages(
  originalText: string,
  question: string,
  answer: string,
  references: readonly ExperimentActionReference[],
  manifestationEnabled: boolean,
): readonly ExperimentMessage[] {
  return [
    { role: 'system', content: manifestationEnabled
      ? `${CLARIFICATION_SYSTEM} ${MANIFESTATION_SYSTEM}`
      : CLARIFICATION_SYSTEM },
    { role: 'user', content: JSON.stringify({
      originalText, clarificationQuestion: question, answer,
      output: outputShape(manifestationEnabled),
      targets: {
        move: references.filter(reference => reference.kind === 'location')
          .map(reference => ({ locationRef: reference.short, name: reference.label })),
        take: references.filter(reference => reference.kind === 'entity')
          .map(reference => ({ entityRef: reference.short, kind: reference.label })),
      },
    }) },
  ]
}

/** 空白不敏感地匹配原文连续片段，返回原文中对应的精确片段（保留原文空白）。 */
function sourceSpan(text: string, fragment: string): string | undefined {
  if (fragment.trim() !== fragment || fragment.length === 0) return undefined
  const compactText = text.replace(/\s+/gu, '')
  const compactFragment = fragment.replace(/\s+/gu, '')
  if (compactFragment.length === 0) return undefined
  const idx = compactText.indexOf(compactFragment)
  if (idx === -1) return undefined
  let start = -1
  let seen = 0
  for (let i = 0; i < text.length; i++) {
    if (/\s/u.test(text.charAt(i))) continue
    if (seen === idx) { start = i; break }
    seen++
  }
  if (start === -1) return undefined
  let remaining = compactFragment.length
  let end = text.length
  for (let i = start; i < text.length; i++) {
    if (/\s/u.test(text.charAt(i))) continue
    remaining--
    if (remaining === 0) { end = i + 1; break }
  }
  return text.slice(start, end)
}

function normalizedResult(
  raw: unknown,
  text: string,
  references: readonly ExperimentActionReference[],
  manifestationEnabled: boolean,
): UtilityIntentResult {
  const value = object(raw)
  const expectedKeys = manifestationEnabled
    ? 'intent,manifestationCues,question,spokenText,targetRef'
    : 'intent,question,targetRef'
  if (Object.keys(value).sort().join(',') !== expectedKeys
    || typeof value.intent !== 'string' || typeof value.targetRef !== 'string'
    || typeof value.question !== 'string' || value.question.length > 200) {
    throw new TypeError('utility intent output is malformed')
  }
  let manifestation: ManifestationProposal | undefined
  let spokenText = text
  if (manifestationEnabled) {
    if (typeof value.spokenText !== 'string' || !Array.isArray(value.manifestationCues)
      || value.manifestationCues.length > 8) throw new TypeError('utility manifestation output is malformed')
    spokenText = value.spokenText
    const cues = value.manifestationCues.map((entry, index) => {
      const cue = object(entry)
      if (Object.keys(cue).sort().join(',') !== 'channel,description'
        || typeof cue.channel !== 'string'
        || !['facial', 'gaze', 'posture', 'gesture', 'voice', 'appearance'].includes(cue.channel)
        || typeof cue.description !== 'string' || cue.description.length === 0
        || cue.description.trim() !== cue.description) {
        throw new TypeError('utility manifestation cue is not an exact observable source span')
      }
      const span = sourceSpan(text, cue.description)
      if (span === undefined) throw new TypeError('utility manifestation cue is not an exact observable source span')
      return {
        cueId: `cue:player:${index + 1}:${byteHash(`${cue.channel}\u001f${span}`).slice(7, 15)}`,
        channel: cue.channel as ManifestationChannel,
        description: span,
        persistence: 'event_only' as const,
      }
    })
    if (new Set(cues.map(cue => `${cue.channel}\u001f${cue.description}`)).size !== cues.length) {
      throw new TypeError('utility manifestation cues must be unique')
    }
    manifestation = cues.length === 0 ? undefined : { cues }
  }
  if (value.intent === 'speak' && value.targetRef === '' && value.question === '') {
    const speechSpan = sourceSpan(text, spokenText)
    if (speechSpan === undefined || (manifestation === undefined && speechSpan !== text)) {
      throw new TypeError('utility speech must preserve an exact player source span')
    }
    return {
      status: 'action', action: { actionType: 'speak', parameters: { text: speechSpan } },
      ...(manifestation === undefined ? {} : { manifestation }),
    }
  }
  if ((value.intent === 'move' || value.intent === 'take') && value.question === '') {
    if (manifestationEnabled && spokenText !== '') throw new TypeError('utility physical action cannot invent speech')
    const kind = value.intent === 'move' ? 'location' : 'entity'
    const reference = references.find(candidate => candidate.kind === kind && candidate.short === value.targetRef)
    if (reference === undefined) throw new TypeError('utility intent target reference is unavailable')
    return {
      status: 'action', action: {
        actionType: value.intent,
        parameters: value.intent === 'move' ? { locationId: reference.source } : { entityId: reference.source },
      },
      ...(manifestation === undefined ? {} : { manifestation }),
    }
  }
  if (value.intent === 'clarification' && value.targetRef === '' && value.question.trim() === value.question
    && value.question.length > 0 && (!manifestationEnabled || (spokenText === '' && manifestation === undefined))) {
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
    private readonly manifestationEnabled = false,
  ) {}

  async interpret(text: string, references: readonly ExperimentActionReference[]): Promise<UtilityIntentResult> {
    const requestMessages = messages(text, references, this.manifestationEnabled)
    return this.#request(requestMessages, text, references, text)
  }

  async interpretClarification(
    originalText: string,
    question: string,
    answer: string,
    references: readonly ExperimentActionReference[],
  ): Promise<UtilityIntentResult> {
    const requestMessages = clarificationMessages(
      originalText, question, answer, references, this.manifestationEnabled,
    )
    const result = await this.#request(requestMessages, originalText, references, `${originalText}\u001f${answer}`)
    return !this.manifestationEnabled && result.status === 'action' && result.action.actionType === 'speak'
      ? { status: 'action', action: { actionType: 'speak', parameters: { text: originalText } } }
      : result
  }

  async #request(
    requestMessages: readonly ExperimentMessage[],
    actionText: string,
    references: readonly ExperimentActionReference[],
    evidenceText: string,
  ): Promise<UtilityIntentResult> {
    const body = JSON.stringify({
      model: this.model, messages: requestMessages, stream: false, think: false,
      format: schema(references, this.manifestationEnabled),
      options: { temperature: 0, seed: 42, num_predict: this.manifestationEnabled ? 240 : 80 }, keep_alive: '10m',
    })
    const evidenceId = `utility-${String(++this.#ordinal).padStart(4, '0')}-${byteHash(evidenceText).slice(7, 23)}`
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
    const result = normalizedResult(JSON.parse(message.content), actionText, references, this.manifestationEnabled)
    writeFileSync(resolve(this.evidenceDirectory, `${evidenceId}.response.json`), JSON.stringify({
      model: envelope.model, result,
    }, null, 2), { flag: 'wx' })
    return result
  }
}
