import type { HolderQuestion, Publication } from './jev-shadow.ts'

export interface ClaimQuestion extends HolderQuestion {
  readonly earlierPublications: readonly Publication[]
  readonly round: { readonly roundId: string | null; readonly fromSeq: number; readonly toSeq: number }
}
export const claimCriteria = {
  OBJECTIVE_NEW: '最新客观旁白确认指定人物在这一次交互中从原处或他人处新拿到、接到目标物品；这次获取完成，不是旧回忆、意图或仅递出。',
  OBJECTIVE_NOW: '最新客观旁白确认指定人物在这段表达结束时当前实际持有目标。已持有者在自己手内翻转不算新获取，选这里。',
  OBJECTIVE_DURING: '最新客观旁白确认指定人物在这次操作过程中短暂实际持有目标，随后归还或交给别人；结束时不再持有，但中途持有写成已经发生。仅摸别人拿着的东西不算。',
  OBJECTIVE_PAST: '仅最新客观旁白回顾此前另一段经历中指定人物曾持有目标，没有确认这次实际持有。',
  SPEECH_NOW: '仅最新对白、引用或思想声称指定人物现在实际持有或这次刚拿到目标；客观旁白没有确认该人物持有。',
  SPEECH_PAST: '仅最新对白、引用或思想回述先前某次指定人物实际持有过目标，没有断言她现在持有。',
  NONE: '最新表达未确认该人物实际持有目标；只打算、邀请、伸手、递出未确认接收、否认、假设、只看或摸别人拿着的东西都不算。未来要给、要放下也不是已经发生。',
  UNCERTAIN: '物品、人物指代、完成程度或时间范围无法确定。',
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
  OBJECTIVE_RELEASE: '最新客观旁白确认目标物品在这一次交互中从手中或随身保管处被放到本场景桌面/地面，并已经松手，表达结束时无人持有。仅桌面滑动、挪几寸、不离开原平面不算从手中放下。',
  OBJECTIVE_GROUND: '最新 narration 确认目标当前无人保管地搁在本场景桌面/地面，包括看着桌上的目标、没碰桌上的目标这些背景事实。若目标仍被握持、杯底只是贴桌，不能选这里。明确本次松手放下优先选 OBJECTIVE_RELEASE。',
  PAST: '最新客观旁白只回忆此前一次把目标放下，未确认当前在桌面/地面或本次完成放下。',
  SPEECH_ONLY: '目标已放下或在桌面的说法仅在对白、引用或思想中，最新客观旁白没有确认。',
  NONE: '最新 narration 没有确认目标无人持有或完成放下。只看桌面空处、给目标留位置、看目标原来搁着的印子不等于目标现在在桌上。仍握持时贴桌或挪到桌边、触碰或开盖不等于松手放下。邀请、未来、假设、否认也不算。',
  UNCERTAIN: '不能确定是哪件物品、放下是否完成、是否属于本场景或结束时是否仍由人持有。',
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
    ...q.earlierPublications.map(p => [`publication:${p.seq}`, `最新表达回述这次具体经历（seq ${p.seq}，表达者 ${p.actorId}）：旁白：${p.narration}；对白：${p.speech}。必须对应同一次经历，不能仅因同物品或同人物。`]),
    ['NONE', '没有回述此前具体经历，或者没有指定人物持有宣称。'],
    ['UNRESOLVED', '确实回述此前经历，但候选里找不到明确对应的一次，或存在多个同样可能的经历。'],
  ])
  return { model: 'typesafe/jev-1.13', state: {
    target: q.item, items: q.items, characters: q.characters, publication: q.publication,
    earlierPublications: q.earlierPublications, round: q.round,
  }, questions: { placement: {type:'choice',instructions:`只解释最新 publication 对 ${q.item.name}（${q.item.entityId}）是否作出客观放下或当前桌面/地面归属宣称。先单独阅读最新 publication.narration，逐句确认目标而非其他物品的位置。只看空处、原来的位置或为物品留位置不是物品当前位置。触桌与松手不同：杯底贴桌但手仍持杯，不是无人持有。旁白明确本次松手选 OBJECTIVE_RELEASE，仅确认当前无人持有的桌上物品选 OBJECTIVE_GROUND；别因对白很长而忽略真实背景位置。若相关位置只在 publication.speech、引用或思想里，选 SPEECH_ONLY，即便角色说自己亲眼看见或声称已经放下。不要把对白或 earlierPublications 的位置搬进最新旁白，不判断世界真伪。`,criteria:placementCriteria},
    ...Object.fromEntries(q.characters.flatMap((c, i) => [
    [`claim_${i}`, { type: 'choice', instructions: `这段已经生成的文本是否把 ${c.name}（${c.characterId}）持有目标物品 ${q.item.name}（${q.item.entityId}） 写成已发生的客观事件，还是仅角色说法？`
      + '只解释 publication 对指定人物的最新宣称。speech 是角色对白，可以说谎；narration 是客观叙述，其中引用的话和思想仍属于角色陈述。'
      + '分清本次新获取、结束时实际持有、这次中途持有后归还、过去回忆、现在对白和过去对白。对白同时提现在和过去，且指定人物只在过去持有时选 SPEECH_PAST。'
      + '最新回答若回应此前明确的回忆提问，刚拿到、刚看过等可指被追问的过去经历；结合紧邻提问判断，不能仅凭刚字判成现在。只判最新文本，不把上下文其他人物或其他物品的持有搬到最新宣称。'
      + '只有明确取得或持续握持才能算持有。沿桌面滑动、推杯、挪半寸、手搭物品、触碰后收手、拧开又拧上盖子均不证明曾持有。物品仍可以在桌上或他人手里；不能因为某动作常需要拿起就推导一次拿起。明确端起、举起、握在手里仍算持有。'
      + '我指 actorId，你根据公开表达解指代，不能确定则 UNCERTAIN。多件物品分别判断，不借邻近物品的动作替目标断言。'
      + '先客观后对白；先中途持有后归还、再本次新获取、再结束时持有、再过去回忆。不要因 earlierPublications 讲过就排除本次客观断言。不要判断世界真假。', criteria: Object.fromEntries(Object.entries(claimCriteria).map(([label,description]) => [label,description.replaceAll('指定人物',`${c.name}（${c.characterId}）`).replaceAll('目标',`${q.item.name}（${q.item.entityId}）`)])) }],
    [`reference_${i}`, { type: 'choice', instructions: `publication 对 ${c.name}（${c.characterId}）持有目标物品 ${q.item.name}（${q.item.entityId}） 的宣称，是否明确回述 earlierPublications 里的同一次具体经历？`
      + '选择具体来源发布，优先第一次完整叙述那段经历的表达，也可以选择明确延续同一次经历的回述。参与者说法有改写时，仍可能回述同一次查看及归还经历；必须还有查看内容、归还等具体线索，仅人物和物品相同不足以认定同一次。'
      + '历史中她曾持有，不代表本次也持有。没有回述则 NONE，确实回述但来源无法唯一定位则 UNRESOLVED。不判断世界真伪。', criteria: references }],
  ])) } }
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
