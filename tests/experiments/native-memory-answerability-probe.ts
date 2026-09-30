import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Source = {
  source_id: string; source_seq: number; source_hash: string
  epistemic_kind: string; text_value: string
}
type Case = {
  id: string; characterId: string; question: string; expected: string | null; ambiguitySources?: string[]
  returned: Array<{ sourceId: string; text: string }>
}
type SemanticCase = {
  id: string; candidates: Array<{ sourceId: string; sourceHash: string }>
}
type ChatRequest = {
  model: string
  messages: Array<{ role: 'system' | 'user'; content: string }>
  temperature: number; max_tokens: number
}
const input = resolve(process.argv[2] ?? '')
if (!process.argv[2] || !existsSync(input)) throw new Error('provide a baseline output directory')
const execute = process.argv.includes('--execute')
const all = process.argv.includes('--all')
const model = process.env.HCW_LOCAL_MODEL?.trim() || 'gemini-3.7-flash'
const endpoint = process.env.HCW_LOCAL_ENDPOINT?.trim() || 'http://127.0.0.1:8045/v1/chat/completions'
const baseline = JSON.parse(readFileSync(resolve(input, 'report.json'), 'utf8')) as {
  headSeq: number; results: Case[]
}
const semantic = JSON.parse(readFileSync(resolve(input, 'semantic-probe.json'), 'utf8')) as {
  results: SemanticCase[]
}
const sources = JSON.parse(readFileSync(resolve(input, 'sources.json'), 'utf8')) as Record<string, Source[]>
const semanticById = new Map(semantic.results.map(row => [row.id, row]))
const diagnosticIds = new Set(['direct', 'paraphrase', 'private-unknown', 'promise-unfulfilled',
  'vessel-paraphrase', 'vessel-unverified-return', 'vessel-bob-unknown', 'ambiguous-cup', 'unseen-drop'])
const selected = all ? baseline.results : baseline.results.filter(row => diagnosticIds.has(row.id))
const system = '你正在扮演一个角色。只能依据下面给出的该角色可见旧记录回答问题。'
  + '亲眼观察到的动作与某人声称的事情不同；承诺也不等于已经完成。'
  + '相关记录可能仍不足以回答后来发生了什么。证据不足时直接说“无法确认”。'
  + '若问题指代多个对象，请指出歧义并要求澄清。'
  + '请用一句自然的中文回答，不要猜测未观察到的事实。'
const requests: Array<{ id: string; mode: 'keyword' | 'semantic'; characterId: string
  expectedSourceId: string | null; goldBehavior: 'answer' | 'unknown' | 'clarify'; supportingSourcesPresent: boolean; sourceIds: string[]; request: ChatRequest }> = []
for (const entry of selected) {
  const visible = new Map((sources[entry.characterId] ?? []).map(source => [source.source_id, source]))
  const candidates = semanticById.get(entry.id)?.candidates
  if (candidates === undefined) throw new Error('missing semantic candidates for ' + entry.id)
  for (const mode of ['keyword', 'semantic'] as const) {
    const ids = mode === 'keyword' ? entry.returned.slice(0, 5).map(row => row.sourceId)
      : candidates.slice(0, 5).map(row => row.sourceId)
    const unique = [...new Set(ids)]
    const records = unique.map(id => {
      const source = visible.get(id)
      if (source === undefined || source.source_seq > baseline.headSeq) {
        throw new Error('candidate is not visible to ' + entry.characterId + ': ' + id)
      }
      if (mode === 'keyword' && entry.returned.find(row => row.sourceId === id)?.text !== source.text_value) {
        throw new Error('keyword candidate text differs from its source: ' + id)
      }
      if (mode === 'semantic' && candidates.find(row => row.sourceId === id)?.sourceHash !== source.source_hash) {
        throw new Error('semantic candidate hash differs from its source: ' + id)
      }
      return source
    })
    const evidence = records.length === 0 ? '（没有检索到旧记录）'
      : records.map((row, index) => [
        '[' + (index + 1) + '] 来源 ' + row.source_id + '；类型 ' + row.epistemic_kind
          + '；获知事件序号 ' + row.source_seq,
        row.text_value,
      ].join('\n')).join('\n')
    requests.push({
      id: entry.id, mode, characterId: entry.characterId,
      expectedSourceId: entry.expected, goldBehavior: entry.ambiguitySources === undefined
        ? (entry.expected === null ? 'unknown' : 'answer') : 'clarify',
      supportingSourcesPresent: entry.ambiguitySources === undefined
        ? entry.expected !== null && unique.includes(entry.expected)
        : entry.ambiguitySources.every(id => unique.includes(id)),
      sourceIds: records.map(row => row.source_id),
      request: { model, temperature: 0, max_tokens: 128, messages: [
        { role: 'system', content: system },
        { role: 'user', content: '问题：' + entry.question + '\n可见旧记录：\n' + evidence },
      ] },
    })
  }
}
writeFileSync(resolve(input, 'answerability-requests.json'), JSON.stringify(requests, null, 2))
process.stdout.write('prepared ' + requests.length + ' character-scoped requests\n')
if (execute) {
  const apiKey = process.env.HCW_LOCAL_API_KEY?.trim()
  const host = new URL(endpoint).hostname
  if (!apiKey && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error('HCW_LOCAL_API_KEY is required for a non-loopback endpoint')
  }
  type ResponseRecord = {
    id: string; mode: 'keyword' | 'semantic'; requestHash: string; characterId: string
    goldBehavior: 'answer' | 'unknown' | 'clarify'; supportingSourcesPresent: boolean
    expectedSourceId: string | null; sourceIds: string[]
    model?: string | null; answer?: string; error?: string
  }
  const responsePath = resolve(input, 'answerability-responses.json')
  const planned = requests.map(item => ({
    ...item, requestHash: createHash('sha256').update(JSON.stringify(item.request)).digest('hex'),
  }))
  const expectedHashes = new Map(planned.map(item => [item.id + '/' + item.mode, item.requestHash]))
  const previous = existsSync(responsePath)
    ? JSON.parse(readFileSync(responsePath, 'utf8')) as ResponseRecord[] : []
  const responses = previous.filter(row => typeof row.answer === 'string'
    && row.requestHash === expectedHashes.get(row.id + '/' + row.mode))
  let failed = false
  for (const item of planned) {
    if (responses.some(row => row.id === item.id && row.mode === item.mode
      && row.requestHash === item.requestHash)) continue
    let completed = false
    let lastError = 'request did not run'
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST', signal: AbortSignal.timeout(120_000),
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
          body: JSON.stringify(item.request),
        })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const body = await response.text()
        const parsed = JSON.parse(body) as { model?: string; choices?: Array<{ message?: { content?: string } }> }
        const answer = parsed.choices?.[0]?.message?.content
        if (typeof answer !== 'string' || answer.length === 0) throw new Error('model response has no answer text')
        if (item.characterId === 'character:npc' && answer.includes('深海灯')) {
          throw new Error('model disclosed private text to NPC')
        }
        responses.push({ id: item.id, mode: item.mode, requestHash: item.requestHash,
          characterId: item.characterId, goldBehavior: item.goldBehavior,
          supportingSourcesPresent: item.supportingSourcesPresent, expectedSourceId: item.expectedSourceId,
          sourceIds: item.sourceIds, model: parsed.model ?? null, answer })
        completed = true
        break
      } catch (error: unknown) {
        lastError = String(error)
        const retryable = error instanceof TypeError || /^Error: HTTP 5\d\d$/u.test(lastError)
          || (error instanceof DOMException && error.name === 'TimeoutError')
        if (!retryable || attempt === 2) break
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)))
      }
    }
    if (!completed) {
      responses.push({ id: item.id, mode: item.mode, requestHash: item.requestHash,
        characterId: item.characterId, goldBehavior: item.goldBehavior,
        supportingSourcesPresent: item.supportingSourcesPresent, expectedSourceId: item.expectedSourceId,
        sourceIds: item.sourceIds, error: lastError })
      failed = true
    }
    writeFileSync(responsePath, JSON.stringify(responses, null, 2))
    if (failed) break
  }
  process.stdout.write('recorded ' + responses.length + '/' + requests.length + ' responses\n')
  if (failed) process.exitCode = 1
}
