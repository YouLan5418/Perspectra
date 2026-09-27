import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { bindPlayerIntentCandidate, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { createCoreRulebookRegistry, currentEntityState, type CompiledWorldManifest, type RulebookEvent } from '@harness-world/kernel'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { PlayerInputJobs, WorldStore, type PlayerInputJob } from '@harness-world/store-sqlite'
import { createChatProvider } from '@harness-world/provider-chat'
import { preparePlayerIntent } from '../../packages/application/src/player-intent-preparation.ts'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import { createClaimClassifier } from './jev-shadow-claims-client.ts'
import type { ShadowRecord } from './jev-shadow.ts'

const directory = resolve(process.argv[2] ?? '')
if (!process.argv[2] || existsSync(directory)) throw new Error('provide a new output directory')
const key = process.env.DEEPSEEK_API_KEY
if (!key) throw new Error('DEEPSEEK_API_KEY missing')
mkdirSync(directory, { recursive: true })
const packPath = resolve('experiments/jev-narrative-auditor/holdout-2026-09-27/live-pack')
const files = ['packages/application/src/player-intent-preparation.ts', 'packages/provider-chat/src/prototype-turn.ts',
  'packages/application/src/prototype-character-turn.ts', 'packages/contracts/src/player-submission.ts',
  'packages/application/src/round-coordinator.ts', 'packages/memory/src/local-memory.ts', 'tests/experiments/jev-shadow-window.ts']
writeFileSync(resolve(directory, 'sources.json'), JSON.stringify(Object.fromEntries(files.map(path => [path, readFileSync(path, 'utf8')])), null, 2))
const log = (file: string, value: unknown) => appendFileSync(resolve(directory, file), JSON.stringify(value) + '\n')
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const diary = 'entity:diary', player = 'character:player'

if (process.argv.includes('--probe')) {
  const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: resolve(directory, 'world'), packPath,
    provider: 'deepseek', model: 'deepseek-flash', apiKey: key })
  const store = new WorldStore(resolve(directory, 'world/world.sqlite'))
  const stored = store.readManifest(runtime.address)!
  const manifest = stored.manifest as CompiledWorldManifest
  const base = store.readEvents(runtime.address)
  const resolver = createCoreRulebookRegistry({ interactionPackages: [createBasicInteractionPackage()] })
    .resolve(manifest.rulebook.rulebookId, manifest.rulebook.version, 'custody10:probe')
  const profile = { version: 'player-intent-profile/v1' as const, providerId: 'chat-completions',
    modelId: 'deepseek-flash', maxOutputTokens: 1024, timeoutMs: 60000 }
  const provider = createChatProvider({ endpoint: new URL('https://api.deepseek.com/chat/completions'),
    model: profile.modelId, apiKey: key, style: 'tool', timeoutMs: 60000 })
  const cases = [
    { id: 'bare-lift', holder: null, text: '我拿起日记。', expected: 'no-transfer' },
    { id: 'look', holder: null, text: '我拿起日记看看。', expected: 'no-transfer' },
    { id: 'carry', holder: null, text: '我拿起日记，准备带走。', expected: 'base:take' },
    { id: 'put', holder: player, text: '我把日记放下。', expected: 'no-transfer' },
    { id: 'temporary-table', holder: player, text: '我把日记暂时放桌上。', expected: 'no-transfer' },
    { id: 'release', holder: player, text: '我不保管了，把日记留在这里。', expected: 'base:drop' },
    { id: 'npc-table', holder: 'character:companion', text: '陆舟，你把日记放桌上吧。', expected: 'communication' },
    { id: 'npc-custody', holder: player, text: '程雨，你替我保管一下。', expected: 'communication' },
    { id: 'npc-look', holder: null, text: '你们谁把怀表拿过来看看？', expected: 'communication' },
    { id: 'npc-to-npc', holder: 'character:companion', text: '我让陆舟把日记交给程雨。', expected: 'communication' },
    { id: 'clipped-invite', holder: 'character:companion', text: '陆舟，你可以把自己保管的布面日记暂放桌上，腾出手整理衣袖，不用改变保管人。', expected: 'communication' },
    { id: 'own-lift', holder: player, text: '我拿起日记。', expected: 'no-transfer' },
    { id: 'own-carry', holder: player, text: '我拿起日记，准备带走。', expected: 'no-transfer' },
  ]
  writeFileSync(resolve(directory, 'protocol.json'), JSON.stringify({ cases, repeats: 2, model: profile.modelId,
    scope: 'real intent call on fixed World prefixes; no NPC activation; no World commits', noTuning: true }, null, 2))
  const results: { id: string; repeat: number; expected: string; actual: string; correct: boolean }[] = []
  try {
    for (let repeat = 1; repeat <= 2; repeat++) for (const sample of cases) {
      const events: RulebookEvent[] = [...base]
      if (sample.holder !== null) events.push({ eventType: 'entity.transferred', data: {
        entityId: diary, fromHolderId: null, fromLocationId: 'location:front-room',
        toHolderId: sample.holder, toLocationId: null, characterId: sample.holder, interactionId: 'base:take' } })
      const job = { address: runtime.address, inputId: `input:${sample.id}:${repeat}`, principalId: manifest.playerBindings[0]!.principalId,
        input: { text: sample.text } } as unknown as PlayerInputJob
      const prepared = preparePlayerIntent(job, manifest, events, resolver, profile, 8192, stored.manifestHash, events.length)
      if (!('request' in prepared)) throw new Error('probe was not prepared')
      let raw: WorldJsonValue | undefined, outcome: unknown, actual: string, exactTarget = true
      try {
        raw = await provider.dispatch(prepared.request, profile, AbortSignal.timeout(60000))
        const bound = bindPlayerIntentCandidate(raw, prepared.binding)
        outcome = bound
        if (bound.status === 'validated') exactTarget = bound.submission.actions.every(a => {
          if (a.actionType !== 'interact') return true
          const parameters = a.parameters as WorldJsonObject
          return (parameters.targetRef as WorldJsonObject).id === diary

        })
        actual = bound.status === 'clarification_required' ? bound.status : bound.submission.actions.map(a =>
          a.actionType === 'interact' ? String(((a.parameters as WorldJsonObject).definitionRef as WorldJsonObject).id)
            : (Object.hasOwn(a.parameters as object, 'narration') ? 'narrate' : a.actionType)).join('+')
      } catch (error) { actual = 'invalid_or_failed'; outcome = String(error) }
      const result = outcome as { status?: string; submission?: { sourceText: string; sourceSpans: { text: string }[] } }
      const selectedQuotes = result.submission?.sourceSpans.map(span => span.text) ?? []
      const controlled = actual.split('+').some(a => a.startsWith('base:') || a === 'move')
      const boundaryMet = sample.expected === 'no-transfer' ? !controlled && actual !== 'invalid_or_failed'
        : sample.expected === 'communication' ? actual === 'speak' : actual === sample.expected && exactTarget
      const row = { id: sample.id, repeat, expected: sample.expected, actual, exactTarget, correct: boundaryMet,
        fullSourceStored: result.submission === undefined ? null : result.submission.sourceText === sample.text,
        quotesCoverFullSource: selectedQuotes.join('') === sample.text, selectedQuotes }
      results.push(row); log('results.jsonl', { ...row, holder: sample.holder, text: sample.text, request: prepared.request, raw, outcome })
      console.log(JSON.stringify(row))
    }
    writeFileSync(resolve(directory, 'summary.json'), JSON.stringify({ calls: results.length,
      boundaryMet: results.filter(r => r.correct).length, mismatches: results.filter(r => !r.correct), unchanged: sha(base) === sha(store.readEvents(runtime.address)) }, null, 2))
  } finally { await runtime.close(); store.close() }
} else {
  const clip = process.argv.includes('--clip')
  const clippedInput = '陆舟，你可以把自己保管的布面日记暂放桌上，腾出手整理衣袖，不用改变保管人。'
  const items = [{ entityId: diary, name: '布面日记' }, { entityId: 'entity:pocket-watch', name: '铜怀表' }]
  const records: ShadowRecord[] = []
  let round = 0
  const nativeFetch = globalThis.fetch
  // Experiment observation only: capture DeepSeek JSON bodies, never headers or credentials.
  globalThis.fetch = async (url, init) => {
    if (clip && typeof init?.body === 'string' && String(url).includes('api.deepseek.com')) {
      const body = JSON.parse(init.body), user = JSON.parse(body.messages[1].content)
      if (user.sourceText === clippedInput) {
        const payload = { version: 'player-intent-candidate/v3', decision: 'act', reason: 'none', actions: [{
          key: 'a', affordanceId: 'narrate', quotes: ['把自己保管的布面日记暂放桌上，腾出手整理衣袖，不用改变保管人'] }] }
        const answer = { choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'submit_actions', arguments: JSON.stringify(payload) } }] } }] }
        log('model-calls.jsonl', { round, injectedCandidate: true, request: { model: body.model, messages: body.messages }, response: answer })
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    }
    const response = await nativeFetch(url, init)
    if (String(url).includes('api.deepseek.com') && typeof init?.body === 'string') {
      const body = JSON.parse(init.body)
      const answer = await response.clone().json()
      log('model-calls.jsonl', { round, request: { model: body.model, messages: body.messages, tools: body.tools }, response: answer })
    }
    return response
  }
  const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: resolve(directory, 'world'), packPath,
    provider: 'deepseek', model: 'deepseek-flash', apiKey: key, shadowAudit: { items,
      classify: createClaimClassifier(process.env.OPENROUTER_JEV_KEY ?? ''),
      write: async record => { records.push(record); log('jev-shadow.jsonl', record) } } })
  const store = new WorldStore(resolve(directory, 'world/world.sqlite'))
  const jobs = new PlayerInputJobs(resolve(directory, 'world/world.sqlite'))
  const read = () => store.readEvents(runtime.address)
  const initialSeq = read().length
  const command = (definition: string, recipientId?: string) => '/act interact ' + JSON.stringify({
    targetRef: { kind: 'entity', id: diary }, bindingId: `binding:diary-${definition}`,
    definitionRef: { id: `base:${definition}`, version: 1 }, arguments: recipientId ? { recipientId } : {},
  })
  const prompts = clip ? [command('take'), command('give', 'character:companion'), clippedInput,
    '陆舟，你为什么这么处理日记？'] : [
    '我拿起日记。', '我拿起日记看看。', '我拿起日记，准备带走。',
    '我把日记放下。', '我把日记暂时放桌上。', '我不保管了，把日记留在这里。',
    command('take'), command('give', 'character:companion'),
    '陆舟，你把日记放桌上吧。', '程雨，你替我保管一下。',
    '你们谁把怀表拿过来看看？', '我让陆舟把日记交给程雨。', clippedInput,
  ]
  writeFileSync(resolve(directory, 'protocol.json'), JSON.stringify({ prompts, clip, mode: 'shadow-only',
    identicalFinalStimulus: prompts.at(-1), noRewriting: true, noTuning: true, model: 'deepseek-flash' }, null, 2))
  try {
    for (const [index, input] of prompts.entries()) {
      round = index + 1
      const beforeSeq = read().length
      const state = await runtime.submit(input, `custody10:${round}`)
      const delta = read().filter(e => e.seq > beforeSeq)
      log('turns.jsonl', { round, input, beforeSeq, state, job: jobs.read(runtime.address, `custody10:${round}`),
        diary: currentEntityState(read(), diary), events: delta })
      console.log(JSON.stringify({ round, headSeq: state.debug.headSeq, notice: state.notice,
        holder: currentEntityState(read(), diary)?.holderId, transfers: delta.filter(e => e.eventType === 'entity.transferred').map(e => e.data) }))
    }
    const final = await runtime.state(), before = sha(read())
    await runtime.close()
    const events = read()
    writeFileSync(resolve(directory, 'events.json'), JSON.stringify(events, null, 2))
    const publications = events.filter(e => e.seq > initialSeq && e.eventType === 'character.speak')
      .filter(e => String((e.data as WorldJsonObject).text ?? '').trim() || String((e.data as WorldJsonObject).narration ?? '').trim())
    writeFileSync(resolve(directory, 'summary.json'), JSON.stringify({ rounds: prompts.length, providerCalls: final.debug.providerCalls,
      publications: publications.length, records: records.length, complete: records.length === publications.length * items.length,
      unchangedDuringDrain: before === sha(events), conflicts: records.filter(r => r.status === 'CONFLICT'),
      failures: records.filter(r => ['CALL_FAILED', 'AUDIT_FAILED', 'QUEUE_SKIPPED'].includes(r.status)),
      costUsd: records.reduce((s, r) => s + (r.answer?.costUsd ?? 0), 0),
      transfers: events.filter(e => e.seq > initialSeq && e.eventType === 'entity.transferred'),
      finalDiary: currentEntityState(events, diary) }, null, 2))
  } finally { await runtime.close(); jobs.close(); store.close(); globalThis.fetch = nativeFetch }
}
