import type { HolderQuestion, Publication } from './jev-shadow.ts'

export interface ClaimQuestion extends HolderQuestion {
  readonly earlierPublications: readonly Publication[]
  readonly round: { readonly roundId: string | null; readonly fromSeq: number; readonly toSeq: number }
}
// Labels retain their wire shape; this experiment interprets custody, not hand contact.
export const claimCriteria = {
  OBJECTIVE_NEW: '最新客观旁白确认指定人物在本次新取得目标的保管或携带控制，例如收进随身口袋带走、接收并负责保管。仅托起查看不算。',
  OBJECTIVE_NOW: '最新客观旁白确认表达结束时目标仍由指定人物保管或随身携带；不要求握在手里。仅手里、桌上等物理位置不足以证明。',
  OBJECTIVE_DURING: '最新客观旁白确认本次保管责任曾迁移给指定人物，之后又转交或解除。必须明确保管关系迁移；短暂接过查看再还回不自动算迁移。',
  OBJECTIVE_PAST: '仅最新客观旁白回顾此前另一段明确的保管或携带经历，没有确认本次保管关系。',
  SPEECH_NOW: '仅最新对白、引用或思想声称指定人物现在保管目标或这次取得了保管；客观旁白没有确认。',
  SPEECH_PAST: '仅最新对白、引用或思想回述先前某次保管或携带目标，没有断言现在保管。',
  NONE: '没有明确确认指定人物的保管或携带关系。触碰、翻页、挪动、短暂托起查看后还回、仅在手里或桌上，以及意图、未完成递交、否认和假设均不算。',
  UNCERTAIN: '人物、物品、迁移是否完成或时间无法确定，或确有转交但无法确定是临时操作还是交由保管。',
}
export type ClaimKind = keyof typeof claimCriteria
export interface TemporalClaim {
  readonly characterId: string
  readonly kind: ClaimKind
  readonly referenceSeq: number | null
  readonly probabilities: Readonly<Record<string, number>>
  readonly referenceProbabilities: Readonly<Record<string, number>>
  readonly confidence: number | null
}
export const placementCriteria = {
  OBJECTIVE_RELEASE: '最新客观旁白明确确认本次解除个人保管，把目标留在当前场所供其他人取用；不是暂放桌上后仍负责保管，也不是交给另一个保管人。',
  OBJECTIVE_GROUND: '最新客观旁白明确确认当前目标无人个人保管、留在场所供人取用。不凭桌上、地上或松手推断无人保管。',
  PAST: '最新客观旁白只回顾此前解除保管的经历，未确认当前或本次解除。',
  SPEECH_ONLY: '解除保管或当前无人保管的说法仅在对白、引用或思想中。',
  NONE: '没有明确解除或无人保管的宣称。暂放桌上、松手、移到桌边、翻页、开盖、仅描述桌上的物品不代表保管关系改变；未来、否认、假设也不算。',
  UNCERTAIN: '确有交出或遗留，但无法确定物品、完成程度、个人保管是否解除或属于哪次经历。',
}
export interface PlacementClaim {
  readonly kind: keyof typeof placementCriteria
  readonly probabilities: Readonly<Record<string,number>>
  readonly confidence: number | null
}
export interface ClaimAnswer {
  readonly placement: PlacementClaim
  readonly claims: readonly TemporalClaim[]
  readonly model: string
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly costUsd: number | null
}
export function claimRequest(q: ClaimQuestion) {
  const references = Object.fromEntries([
    ...q.earlierPublications.map(p => [`publication:${p.seq}`, `最新表达明确回述这次保管经历（seq ${p.seq}，表达者 ${p.actorId}）：旁白：${p.narration}；对白：${p.speech}。同人物同物品不足以证明同一次经历。`]),
    ['NONE', '未回述具体保管经历，或只回述物理操作。'],
    ['UNRESOLVED', '确实回述保管经历，但无法唯一定位来源。'],
  ])
  const contract = '本实验只追踪保管/携带/转交关系，不追踪手的位置或微小物理操作，也不判断法律所有权。'
    + '短暂拿起查看、接过看一眼再还回、翻页、挪动、松手暂放桌上均可保持原保管关系。'
    + '收进自己的随身口袋带走、交给另一人负责保管、明确解除个人保管供他人取用属于关系迁移。'
    + '只解释最新 publication；narration 中客观事件与 speech、引用、思想分开。不得把上下文的事件搬成最新断言，不判断 World 真伪。'
  return { model: 'typesafe/jev-1.13', state: {
    target: q.item, items: q.items, characters: q.characters, publication: q.publication,
    earlierPublications: q.earlierPublications, round: q.round,
  }, questions: {
    placement: { type: 'choice', instructions: contract
      + `最新文本是否明确确认 ${q.item.name}（${q.item.entityId}）已解除个人保管，或当前无人保管、可由他人取得？桌面背景位置本身不算。`,
      criteria: Object.fromEntries(Object.entries(placementCriteria).map(([label, description]) => [label, description.replaceAll('目标', `${q.item.name}（${q.item.entityId}）`)])) },
    ...Object.fromEntries(q.characters.flatMap((c, i) => [
      [`claim_${i}`, { type: 'choice', instructions: contract
        + `最新文本是否明确确认 ${c.name}（${c.characterId}）取得或持续保管 ${q.item.name}（${q.item.entityId}）？`
        + '先判断是否声明保管关系，再区分本次迁移、当前保管、本次中途保管后转交、过去经历和角色说法。我指 actorId。'
        + '回应过去经历的提问时，刚拿过可能指过去；必须结合紧邻提问。不从一般拿起或放下动作推导保管迁移。',
        criteria: Object.fromEntries(Object.entries(claimCriteria).map(([label, description]) => [label, description.replaceAll('指定人物', `${c.name}（${c.characterId}）`).replaceAll('目标', `${q.item.name}（${q.item.entityId}）`)])) }],
      [`reference_${i}`, { type: 'choice', instructions: contract
        + `最新文本对 ${c.name}（${c.characterId}）保管 ${q.item.name}（${q.item.entityId}）的回述是否对应候选里的同一次经历？`
        + '只回述触碰或临时查看，选 NONE。确实回述保管但来源不唯一选 UNRESOLVED。历史上曾保管不证明本次迁移。', criteria: references }],
    ])),
  } }
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid Jev object')
  return v as Record<string, unknown>
}
const numberOrNull = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
export function parseClaimAnswer(input: unknown, q: ClaimQuestion): ClaimAnswer {
  const body = record(input), answers = record(body.answers), request = claimRequest(q)
  const parsed = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const a = record(answers[id]), p = record(a.probabilities), labels = Object.keys(question.criteria)
    if (a.type !== 'choice' || typeof a.choice !== 'string' || !labels.includes(a.choice)
      || labels.some(l => typeof p[l] !== 'number' || !Number.isFinite(p[l]) || (p[l] as number) < 0 || (p[l] as number) > 1)
      || Math.abs(labels.reduce((s, l) => s + (p[l] as number), 0) - 1) > 0.02) throw new Error('invalid Jev choice')
    return [id, { choice: a.choice, probabilities: p as Record<string, number>, confidence: numberOrNull(a.confidence) }]
  }))
  if (typeof body.model !== 'string') throw new Error('invalid Jev model')
  const usage = body.usage === undefined ? {} : record(body.usage)
  return { placement:{kind:parsed.placement!.choice as PlacementClaim['kind'],probabilities:parsed.placement!.probabilities,confidence:parsed.placement!.confidence},model: body.model, inputTokens: numberOrNull(usage.input_tokens), outputTokens: numberOrNull(usage.output_tokens), costUsd: numberOrNull(usage.cost),
    claims: q.characters.map((c,i) => {
      const claim = parsed[`claim_${i}`]!, ref = parsed[`reference_${i}`]!
      return { characterId: c.characterId, kind: claim.choice as ClaimKind,
        referenceSeq: ref.choice.startsWith('publication:') ? Number(ref.choice.slice('publication:'.length)) : null,
        probabilities: claim.probabilities, referenceProbabilities: ref.probabilities, confidence: claim.confidence }
    }) }
}
export function createClaimClassifier(apiKey: string): (q: ClaimQuestion) => Promise<ClaimAnswer> {
  if (!apiKey.trim()) throw new Error('OPENROUTER_JEV_KEY missing')
  return async q => {
    let response: Response
    try {
      response = await fetch('https://openrouter.ai/api/alpha/decisions', { method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(claimRequest(q)), signal: AbortSignal.timeout(10_000) })
    } catch { throw new Error('Jev transport failed') }
    if (!response.ok) throw new Error(`Jev HTTP ${response.status}`)
    return parseClaimAnswer(await response.json(), q)
  }
}
