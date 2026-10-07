import type { MessageSource } from './request-inspector.ts'
import { Worker } from 'node:worker_threads'
import type { WorldJsonObject, WorldJsonValue, CharacterView } from '@harness-world/contracts'
import type { ChatCall, ChatMessage } from './wire.ts'
import type { RolePreset } from './preset.ts'
import { presetMacros } from './preset-macros.ts'
import { REGEX_WORKER_PROGRAM, type TextJob, type TextResult } from './preset-regex.ts'

/** A deadline can stop catastrophic backtracking without blocking the world process. */
export async function processPresetText(jobs: readonly TextJob[], signal?: AbortSignal): Promise<TextResult[]> {
  if (!jobs.some(job => job.rules.some(r => r.enabled && r.stage === job.stage && (r.target === 'both' || r.target === job.target)))) {
    return jobs.map(job => ({ text: job.text, trace: [] }))
  }
  signal?.throwIfAborted()
  const worker = new Worker(REGEX_WORKER_PROGRAM + `
    const {parentPort} = require('node:worker_threads');
    parentPort.once('message',jobs=>{try{parentPort.postMessage({results:run(jobs)})}catch(error){parentPort.postMessage({error:error.message})}});
  `, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 32 } })
  try {
    return await new Promise<TextResult[]>((resolve, reject) => {
      const fail = (error: Error) => { cleanup(); reject(error) }
      const timer = setTimeout(() => fail(new Error('预设文本处理超时。')), 1000)
      const abort = () => fail(new Error('预设文本处理已取消。'))
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      signal?.addEventListener('abort', abort, { once: true })
      worker.once('error', fail)
      worker.once('exit', code => fail(new Error('预设文本处理线程退出：' + code)))
      worker.once('message', (message: { results?: TextResult[]; error?: string }) => {
        cleanup()
        if (message.error || !message.results) reject(new Error(message.error ?? '预设文本处理失败。'))
        else resolve(message.results)
      })
      worker.postMessage(jobs)
    })
  } finally { await worker.terminate() }
}
function object(value: unknown): WorldJsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WorldJsonObject : undefined
}
interface RoleRequest { context: WorldJsonObject; continuation: boolean }
/** Only expression fields of authorized observations are transformed. Facts and affordances stay intact. */
export async function presetContext<T extends RoleRequest>(request: T, preset: RolePreset, playerId: string, signal?: AbortSignal): Promise<T> {
  if (!preset.textRules?.some(rule => rule.enabled && (rule.stage === 'input' || rule.stage === 'history'))) return request
  const copy = structuredClone(request)
  const observations = Array.isArray(copy.context.observations) ? copy.context.observations : []
  const contentOf = (record: WorldJsonValue): WorldJsonObject | undefined => {
    const entry = object(record)
    return object((object(entry?.value) ?? entry)?.content)
  }
  const isPlayer = (content: WorldJsonObject | undefined) => object(content?.speech)?.characterId === playerId
    || object(content?.playerInput)?.actorId === playerId
  const latest = observations.filter(record => isPlayer(contentOf(record))).toSorted((a,b) => Number(object(a)?.sourceSeq)-Number(object(b)?.sourceSeq)).at(-1)
  const latestSeq = object(latest)?.sourceSeq
  const latestContent = latest === undefined ? undefined : contentOf(latest)
  const latestText = object(latestContent?.playerInput)?.sourceText ?? object(latestContent?.speech)?.text
  const jobs: TextJob[] = [], destinations: { object: Record<string, WorldJsonValue>; key: string }[] = []
  const seen = new Set<WorldJsonObject>()
  for (const record of [...observations, ...(Array.isArray(copy.context.selfObservations) ? copy.context.selfObservations : []),
    ...(Array.isArray(copy.context.stimulus) ? copy.context.stimulus : [])]) {
    const entry = object(record), content = contentOf(record), speech = object(content?.speech), input = object(content?.playerInput)
    if (!content || seen.has(content)) continue
    seen.add(content)
    const latestStimulus = entry?.sourceSeq === undefined && latestText !== undefined && (input?.sourceText ?? speech?.text) === latestText
    const stage = isPlayer(content) && (latestSeq !== undefined && entry?.sourceSeq === latestSeq || latestStimulus) ? 'input' : 'history'
    if (speech) for (const [key, target] of [['text', 'speech'], ['narration', 'narration']] as const) {
      if (typeof speech[key] === 'string') { jobs.push({ text: speech[key], stage, target, rules: preset.textRules! }); destinations.push({ object: speech, key }) }
    }
    if (input && typeof input.sourceText === 'string') {
      jobs.push({ text: input.sourceText, stage, target: 'speech', rules: preset.textRules! }); destinations.push({ object: input, key: 'sourceText' })
    }
  }
  const results = await processPresetText(jobs, signal)
  results.forEach((result, i) => {
    const destination = destinations[i]!
    if (destination.key === 'sourceText' && destination.object.sourceText !== result.text) {
      destination.object.note = '玩家输入的上下文文本投影；sourceSpans 指向未修改的原始输入存档。投影不证明动作成功，也不替角色决定行动。'
    }
    destination.object[destination.key] = result.text
  })
  return copy
}
/** Core contract is fixed first; ordered preset nodes surround the authorized context. */
export function presetCall(call: ChatCall, preset: RolePreset, request: RoleRequest, playerName: string, labels: { character?: string; scene?: string } = {}): ChatCall {
  const character = object(request.context.character), scene = object(request.context.scene)
  const now = new Date()
  const expand = presetMacros({ char: labels.character ?? String(character?.name ?? character?.characterId ?? ''), user: playerName,
    scene: labels.scene ?? String(scene?.locationName ?? scene?.locationId ?? ''), date: now.toLocaleDateString('zh-CN'), time: now.toLocaleTimeString('zh-CN') })
  const before: ChatMessage[] = [], after: ChatMessage[] = []
  const beforeSources: MessageSource[] = [], afterSources: MessageSource[] = []
  for (const node of preset.nodes ?? []) {
    if (!node.enabled) continue
    const content = expand(node.content)
    if (content.trim()) {
      const messages = node.position === 'beforeContext' ? before : after
      const sources = node.position === 'beforeContext' ? beforeSources : afterSources
      messages.push({ role: node.role, content })
      sources.push({source:'preset:'+node.id,name:node.name,original:node.content,macroExpanded:content!==node.content})
    }
  }
  return { ...call, messages: [...call.messages.slice(0, 1), ...before, ...call.messages.slice(1), ...after],
    inspection:{characterId:String(character?.characterId??''),continuation:request.continuation,
      sources:[{source:'core',name:'Core 固定契约'},...beforeSources,...call.messages.slice(1).map(()=>({source:'context',name:'当前角色授权上下文'})),...afterSources]} }
}
/** Reject malformed originals before cleaning; domain validation still runs on the resulting expression. */
export async function presetOutput(raw: WorldJsonValue, preset: RolePreset, signal?: AbortSignal, expression?: WorldJsonObject): Promise<WorldJsonValue> {
  const decision = object(raw)
  if (decision?.decision !== 'publish' || !preset.textRules?.some(rule => rule.enabled && rule.stage === 'output')) return raw
  if (Object.keys(decision).some(key => !['decision', 'speech', 'narration', 'addresseeIds'].includes(key))) throw new TypeError('表达包含不支持的字段。')
  for (const key of ['speech', 'narration']) if (decision[key] !== undefined && (typeof decision[key] !== 'string' || decision[key].length > 2000)) throw new TypeError('原始表达字段无效。')
  if (!(typeof decision.speech === 'string' && decision.speech.trim()) && !(typeof decision.narration === 'string' && decision.narration.trim())) throw new TypeError('原始表达为空。')
  if (decision.speech !== undefined && expression?.speech === 'none' || decision.narration !== undefined && expression?.narration === false) throw new TypeError('当前玩法禁止该表达字段。')
  if (decision.speech !== undefined && expression?.speech === 'choices' && (!Array.isArray(expression.speechChoices) || !expression.speechChoices.includes(decision.speech))) throw new TypeError('原始对白不属于当前玩法选项。')
  const keys = (['speech', 'narration'] as const).filter(key => typeof decision[key] === 'string')
  const results = await processPresetText(keys.map(key => ({ text: decision[key] as string, stage: 'output', target: key, rules: preset.textRules! })), signal)
  const output = { ...decision }
  keys.forEach((key, i) => { output[key] = results[i]!.text })
  if (expression?.speech === 'choices' && output.speech !== decision.speech) throw new TypeError('文本规则不能改写玩法对白选项。')
  if (results.some(result => result.text.length > 2000) || !results.some(result => result.text.trim())) throw new TypeError('处理后的表达为空或超过 2000 字符。')
  return output
}
/** Display copies are never written to Event/Observation/Memory. */
export async function presetDisplay(view: CharacterView, presets: ReadonlyMap<string, RolePreset>): Promise<CharacterView> {
  if (![...presets.values()].some(p => p.textRules?.some(r => r.enabled && r.stage === 'display'))) return view
  const copy = structuredClone(view), jobs: TextJob[] = [], destinations: { object: Record<string, WorldJsonValue>; key: string }[] = []
  for (const record of copy.observations) {
    const speech = object(object(object(record.value)?.content)?.speech)
    if (!speech || typeof speech.characterId !== 'string') continue
    const preset = presets.get(speech.characterId)
    if (!preset?.textRules?.some(rule => rule.enabled && rule.stage === 'display')) continue
    for (const [key, target] of [['text', 'speech'], ['narration', 'narration']] as const) if (typeof speech[key] === 'string') {
      jobs.push({ text: speech[key], stage: 'display', target, rules: preset.textRules }); destinations.push({ object: speech, key })
    }
  }
  const results = await processPresetText(jobs)
  results.forEach((result, i) => { destinations[i]!.object[destinations[i]!.key] = result.text })
  return copy
}
