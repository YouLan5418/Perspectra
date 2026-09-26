import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { HolderQuestion, Publication } from './jev-shadow.ts'

interface Sample {
  id: string
  question: HolderQuestion
  publishedHistory: Publication[]
  worldHolder: string | null
  officialTransfers: { seq: number; from: string | null; to: string | null }[]
  gold: { risk: string; note: string }
}
const source = resolve('experiments/jev-narrative-auditor/historical-replay-2026-09-26/cases.json')
const folder = resolve('experiments/jev-narrative-auditor/objective-event-replay-2026-09-26')
const samples = JSON.parse(readFileSync(source, 'utf8')) as Sample[]
const criteria = {
  OBJECTIVE_EVENT: '客观叙述把目标物品的一次受控变化写成已经发生：从地面或他人处拿起、接到、交付完成、放下，或者通过操作及归还确认中途曾由另一人持有。最后回到原持有人仍算。一次表达同时拿起多件物品，对每个目标分别算。',
  CHARACTER_CLAIM: '仅角色对白、引用、思想、传闻或回忆声称目标物品已发生受控变化或由某人持有；客观叙述没有确认这次变化。角色说法不是客观事实。',
  OBJECTIVE_STATE: '客观叙述只确认目标物品已经在某人手中或仍在原处，未描述一次新的受控变化；同一持有人翻转、掂量、握紧、从掌心换到指间不构成持有人变化。',
  INTENT_ATTEMPT: '只有请求、邀请、打算、条件假设、伸手或递出等未确认完成的尝试，没有断言已经发生受控变化或实际持有。',
  NO_CLAIM: '最新表达没有目标物品的受控状态宣称；仅看物品、指物品、提到名字、表情姿态或其他不涉及持有与归属的细微动作。',
  UNCERTAIN: '目标物品或完成含义不能确定。',
}
const instructions = '这段已经生成的文本，是否把目标物品的某个受控状态变化描述成已经发生的客观事件？'
  + '仅解释 latest 对 target 的语义，不判断世界真假；不要用此前表达已经说过这件事作为排除最新客观完成断言的理由。'
  + 'speech 是角色对白；narration 是客观叙述，但其中引用的言语、思想仍是角色陈述。earlierPublications 若提供，只帮助解指代。'
  + '先检查客观已发生变化；若没有，再检查角色完成或持有宣称，再检查客观当前状态，再检查意图尝试，否则无宣称。'
const holderCriteria = {
  OBJECTIVE_HELD: '最新客观叙述确认指定人物在当前或中途实际持有目标物品，包括短暂拿到、持有后归还；即使最终物品不在她手上也算。仅指、看、要求物品不算持有。',
  CHARACTER_HELD: '只有最新对白、引用或思想声称指定人物实际持有过目标物品，客观叙述未确认该人物持有；角色说法不证明客观事实。',
  NO_HELD_CLAIM: '最新表达未声称该人物实际持有目标物品；仅计划、邀请、伸手、拒绝或不涉及指定人物。明确否认持有也属于这里。',
  UNCERTAIN: '无法确定指代或是否确实声称指定人物持有。',
}
function request(sample: Sample, history: boolean, mode: 'semantic' | 'holders') {
  const questions = mode === 'semantic' ? { completed_event: { type: 'choice', instructions, criteria } }
    : Object.fromEntries(sample.question.characters.map((character, i) => [`held_${i}`, {
      type: 'choice', instructions: `只判断 latest 是否声称 ${character.name}（${character.characterId}）实际持有过 target。`
        + 'speech 的我指 actorId；你按公开角色和此前表达解指代，无法确定则选 UNCERTAIN。'
        + '角色对白允许说谎，不能转为客观事件。不判断世界真假，不用此前表达代替 latest 的宣称。', criteria: holderCriteria,
    }]))
  return { model: 'typesafe/jev-1.13', state: {
    target: sample.question.item, items: sample.question.items, characters: sample.question.characters,
    latest: sample.question.publication, ...(history ? { earlierPublications: sample.publishedHistory } : {}),
  }, questions }
}
interface Answer { type: string; choice: string; probabilities: Record<string, number>; confidence?: number }
interface ResponseBody { model: string; answers: Record<string, Answer>; usage?: { cost?: number; input_tokens?: number; output_tokens?: number } }
function validate(input: unknown, body: ReturnType<typeof request>): ResponseBody {
  const response = input as ResponseBody
  if (typeof response.model !== 'string') throw new Error('invalid model')
  for (const [id, q] of Object.entries(body.questions)) {
    const answer = response.answers?.[id], labels = Object.keys(q.criteria)
    if (answer?.type !== 'choice' || !labels.includes(answer.choice) || !answer.probabilities
      || labels.some(label => !Number.isFinite(answer.probabilities[label]) || answer.probabilities[label]! < 0 || answer.probabilities[label]! > 1)
      || Math.abs(labels.reduce((sum, label) => sum + answer.probabilities[label]!, 0) - 1) > 0.02) throw new Error('invalid choice')
  }
  return response
}
// Frozen before API calls. These describe text semantics, not World truth.
const objectiveIds = ['free:94:entity:brass-key','free:139:entity:brass-key','continuous:100:entity:brass-key',
  'actionA:26:entity:brass-key','actionB:32:entity:brass-key','girls:156:entity:phone','girls:156:entity:charger','girls:215:entity:charger']
const speechIds = ['free:151:entity:brass-key','free:156:entity:brass-key','free:221:entity:brass-key',
  'free:226:entity:brass-key','free:242:entity:brass-key','free:247:entity:brass-key','continuous:111:entity:brass-key',
  'actionA:43:entity:brass-key','actionB:58:entity:brass-key','girls:215:entity:phone','girls:412:entity:phone']
const stateIds = ['free:54:entity:brass-key','continuous:105:entity:brass-key','girls:383:entity:phone','girls:535:entity:phone','live:184:entity:brass-key']
const intentIds = ['free:128:entity:brass-key']
function expected(sample: Sample): string[] {
  if (objectiveIds.includes(sample.id)) return ['OBJECTIVE_EVENT']
  if (speechIds.includes(sample.id)) return ['CHARACTER_CLAIM']
  if (stateIds.includes(sample.id)) return ['OBJECTIVE_STATE']
  if (intentIds.includes(sample.id)) return ['INTENT_ATTEMPT']
  if (sample.id === 'girls:340:entity:phone') return ['OBJECTIVE_STATE','OBJECTIVE_EVENT'] // “被交付的手机” can refer to completed past delivery or qualify current possession.
  if (sample.gold.risk === 'borderline') return [] // Excluded from accuracy, retained verbatim.
  return ['NO_CLAIM']
}
const mode = process.argv.includes('--holders') ? 'holders' : 'semantic'
mkdirSync(folder, { recursive: true })
const outputIndex = process.argv.indexOf('--output')
const outputArg = outputIndex < 0 ? undefined : process.argv[outputIndex + 1]
if (outputIndex >= 0 && (!outputArg || outputArg.startsWith('--'))) throw new Error('--output requires a new file path')
const output = outputArg ? resolve(outputArg) : resolve(folder, mode === 'semantic' ? 'results.jsonl' : 'holder-results.jsonl')
if (existsSync(output)) throw new Error('result already exists; do not overwrite')
const jobs = mode === 'semantic'
  ? samples.flatMap(sample => [false,true].flatMap(history => [1,2,3].map(repeat => ({ sample, history, repeat }))))
  : samples.map(sample => ({ sample, history: true, repeat: 1 }))
if (process.argv.includes('--prepare')) {
  if (mode === 'holders') {
    writeFileSync(resolve(folder, 'holder-requests.jsonl'), jobs.map(j => JSON.stringify({ id: j.sample.id, request: request(j.sample,j.history,mode) })).join('\n') + '\n', { flag: 'wx' })
    writeFileSync(resolve(folder, 'holder-gold.json'), JSON.stringify(samples.filter(s => ['terminal-conflict','unbacked-history'].includes(s.gold.risk)).map(s => ({ id: s.id, characterId: s.id.startsWith('girls:') ? 'character:glm' : s.gold.risk === 'terminal-conflict' ? 'character:companion' : 'character:friend', expected: s.question.publication.seq === 139 || s.gold.risk === 'terminal-conflict' ? 'OBJECTIVE_UNBACKED' : 'SPEECH_UNBACKED' })), null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ samples: samples.length, calls: jobs.length, folder }))
    process.exit(0)
  }
  writeFileSync(resolve(folder, 'gold.json'), JSON.stringify(samples.map(s => ({ id: s.id, expected: expected(s), risk: s.gold.risk })), null, 2) + '\n', { flag: 'wx' })
  writeFileSync(resolve(folder, 'requests.jsonl'), jobs.map(j => JSON.stringify({ id: j.sample.id, history: j.history, repeat: j.repeat, request: request(j.sample,j.history,mode) })).join('\n') + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ samples: samples.length, calls: jobs.length, objectiveCases: objectiveIds.length, folder }))
} else {
  const apiKey = process.env.OPENROUTER_JEV_KEY
  if (!apiKey?.trim()) throw new Error('OPENROUTER_JEV_KEY missing')
  let cursor = 0, completed = 0, failed = 0, costUsd = 0
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (cursor < jobs.length) {
      const { sample, history, repeat } = jobs[cursor++]!
      const body = request(sample, history, mode), start = performance.now()
      let response: ResponseBody | undefined, error: string | undefined
      try {
        const http = await fetch('https://openrouter.ai/api/alpha/decisions', { method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
        if (!http.ok) throw new Error('HTTP error')
        response = validate(await http.json(), body)
      } catch { error = 'Jev call failed'; failed++ }
      costUsd += response?.usage?.cost ?? 0
      // Local reconciliation checks necessary possession history, not a full ordered transfer path.
      const held = new Set([sample.worldHolder,...sample.officialTransfers.flatMap(e => [e.from,e.to])])
      const reconciliation = mode === 'holders' && response ? sample.question.characters.map((person, i) => {
        const claim = response!.answers[`held_${i}`]!.choice
        return { characterId: person.characterId, claim, everHeldInWorld: held.has(person.characterId),
          verdict: claim === 'OBJECTIVE_HELD' || claim === 'CHARACTER_HELD'
            ? held.has(person.characterId) ? 'POSSIBLE_HISTORY' : claim === 'OBJECTIVE_HELD' ? 'OBJECTIVE_UNBACKED' : 'SPEECH_UNBACKED'
            : claim === 'UNCERTAIN' ? 'UNCERTAIN' : 'NO_CLAIM' }
      }) : undefined
      appendFileSync(output, JSON.stringify({ id: sample.id, history, repeat, latencyMs: Math.round(performance.now()-start), response, error, reconciliation }) + '\n')
      completed++
      if (completed % 10 === 0 || completed === jobs.length) console.log(JSON.stringify({ mode, completed, total: jobs.length, failed, costUsd }))
    }
  }))
}
