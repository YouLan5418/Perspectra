import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import { currentLocation } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'

const PLAYER = 'character:player', COMPANION = 'character:companion'
const MODEL = 'deepseek-v4.1-flash'
const object = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as WorldJsonObject
const rows = (value: unknown) => Array.isArray(value) ? value.map(object) : []
const fields = (properties: WorldJsonObject): WorldJsonObject => ({ type: 'object', required: Object.keys(properties), properties })
const contains = (properties: WorldJsonObject): WorldJsonObject => ({ type: 'array', contains: fields(properties) })

/** A controlled source pack, with real model choices and ordinary adjudicated player operations. */
export function writeKnowledgeConditionsPack(pack: string) {
  cpSync(resolve('examples/world-packs/prototype-g1'), pack, { recursive: true })
  mkdirSync(resolve(pack, 'scripts/activities'), { recursive: true })
  const save = (file: string, value: unknown) => writeFileSync(resolve(pack, file), JSON.stringify(value, null, 2))
  const source = JSON.parse(readFileSync(resolve(pack, 'worldpack.source.json'), 'utf8'))
  const characters = JSON.parse(readFileSync(resolve(pack, 'characters.json'), 'utf8'))
  for (const character of characters.characters) if (character.characterId !== PLAYER) {
    character.portrayal = { summary: '你和玩家一起参观旧馆，想先在前室了解钥匙和纸张，等玩家邀请再一起去后室。依据自己实际知道的事交流，也可以自己决定行动。', speakingStyle: '自然简短，避免重复小动作。' }
  }
  save('characters.json', characters)
  const cognition = JSON.parse(readFileSync(resolve(pack, 'cognition.json'), 'utf8'))
  for (const character of cognition.characters) character.goals = []
  save('cognition.json', cognition)
  save('assertions.json', { schemaVersion: 'worldpack-assertions/v1', assertions: [] })
  const money = (current: boolean) => fields({ knownStatus: contains({ key: { const: 'money' }, current: { const: current } }) })
  const entries = [
    { id: 'front', text: '前室的旧名是听雨厅。这个名字是馆史背景，不要求你一直留在这里。', when: fields({ locationId: { const: 'location:front-room' } }) },
    { id: 'with-player', text: '本馆接待习惯：与来访者同处一室时，可以自然询问对方想参观什么。', when: fields({ scene: fields({ people: contains({ characterId: { const: PLAYER } }) }) }) },
    { id: 'visible-key', text: '眼前黄铜钥匙的齿纹叫燕尾纹，是旧馆工匠的制式；这个背景不证明谁已经拿走钥匙。', when: fields({ items: fields({ current: contains({ entityId: { const: 'entity:brass-key' } }) }) }) },
    { id: 'held-key', text: '你当前保管的黄铜钥匙配有检修标签，标签写着“三号柜”。不要把这当作已经开柜。', when: fields({ characterId: { const: COMPANION }, items: fields({ current: contains({ entityId: { const: 'entity:brass-key' }, holderId: { const: COMPANION } }) }) }) },
    { id: 'fresh', text: '你的钱袋账目目前仍是有效的已确认值；涉及金额时依照你自己的已知余额。', when: money(true) },
    { id: 'stale', text: '你手里的余额只是上次确认值，已不能确认现在是多少。需要时可以查看钱包；本材料不透露新金额或变化原因。', when: money(false) },
    { id: 'private-stimulus', text: '“琥珀短笺”在馆史中指一张用于预约修复师的便签，不是任何人的称呼。', when: fields({ stimulus: { type: 'array', contains: fields({ content: fields({ actorId: { const: PLAYER }, speech: { anyOf: [fields({ text: { type: 'string', pattern: '琥珀短笺' } }), fields({ segments: contains({ type: { const: 'speech' }, text: { type: 'string', pattern: '琥珀短笺' } }) })] } }) }) } }) },
    { id: 'activity-own', text: '你分到的竹影细雨签，是介绍竹纸防潮工艺的材料；可以解释自己的纸签，不据此推断别人拿到什么。', when: fields({ activity: fields({ activityKey: { const: 'study' }, game: fields({ phase: { const: 'briefing' }, private: fields({ seal: { const: '竹影细雨' } }) }) }) }) },
    { id: 'activity-foreign', text: '越权材料：月光绳结对应玩家私有纸签。', when: fields({ activity: fields({ game: fields({ private: fields({ seal: { const: '月光绳结' } }) }) }) }) },
    { id: 'activity-internal', text: '越权材料：石榴暗号是活动内部答案。', when: fields({ activity: fields({ game: fields({ internal: fields({ answer: { const: '石榴暗号' } }) }) }) }) },
    { id: 'personal', text: '你私下把后室盆栽叫作暮蓝铃，别人没有听你说过这个别称；这是你自己的背景。', when: fields({ locationId: { const: 'location:front-room' } }), private: true },
  ]
  save('documents.json', { schemaVersion: 'worldpack-documents/v2', documents: entries.map(entry => ({ documentId: 'document:' + entry.id,
    contentRef: entry.id + '.md', usage: 'world_context', audience: entry.private ? 'character_private' : 'public',
    ...(entry.private ? { characterIds: [COMPANION] } : {}) })) })
  for (const entry of entries) writeFileSync(resolve(pack, entry.id + '.md'), entry.text)
  save('knowledge.json', { maximumCharacters: 8000, entries: entries.map(entry => ({ documentId: 'document:' + entry.id,
    constant: true, keywords: [], priority: 10, when: entry.when })) })
  writeFileSync(resolve(pack, 'scripts/status.js'), `globalThis.statusScript = {
    definition: { statuses: [{ key:'money', label:'余额', type:'number', owner:'character' }], operations: [
      {id:'check-purse',label:'查看钱包',schema:{type:'object',additionalProperties:false,properties:{}}},
      {id:'adjust-companion',label:'私下结算同行者款项',actors:'player',schema:{type:'object',additionalProperties:false,properties:{}}}
    ] },
    initialize(ids) { return {public:{},characters:Object.fromEntries(ids.map(id=>[id,{money:100}]))} },
    resolve(truth, actor, op) {
      if(op==='check-purse')return {changes:[],reveals:[{observerId:actor,holderId:actor,key:'money'}],description:'查看了自己的钱袋。',audience:'self'};
      if(op==='adjust-companion')return {changes:[{holderId:'${COMPANION}',key:'money',value:truth.characters['${COMPANION}'].money+30}],reveals:[],description:'私下完成了一笔馆务结算，同行者尚未核实钱袋。',audience:'self'};
      return {rejectReason:'没有这个操作'};
    }
  };`)
  writeFileSync(resolve(pack, 'scripts/activities/study.js'), `globalThis.activityScript = {
    definition:{title:'纸签讲解',npcIds:['${COMPANION}'],operations:[
      {id:'pass',label:'换人讲解',requiresTurn:false,schema:{type:'object',additionalProperties:false,properties:{}}},
      {id:'quit',label:'结束讲解',requiresTurn:false,schema:{type:'object',additionalProperties:false,properties:{}}}
    ]},
    initialize({playerId,npcIds}){return {active:true,phase:'briefing',turn:playerId,round:1,public:{topic:'旧馆纸张'},private:{[playerId]:{seal:'月光绳结'},[npcIds[0]]:{seal:'竹影细雨'}},internal:{answer:'石榴暗号'}}},
    policy(view,actor){return {speech:'free',speechChoices:[],narration:true,move:false,interactions:[],operations:actor===view.participants[0]?['pass','quit']:['pass']}},
    resolve(state,actor,op){const game=JSON.parse(JSON.stringify(state.game));game.round++;if(op==='quit'){game.active=false;game.phase='finished';game.turn=null}else{game.turn=state.participants.find(id=>id!==actor)}return {game,description:op==='quit'?'纸签讲解结束。':'请下一位讲解自己的纸签。',audience:'participants'}},
    schedule(view){return view.game.active&&view.game.turn!==view.participants[0]?{kind:'activate',characterId:view.game.turn}:{kind:'wait'}},
    onOutcome(){return {kind:'wait'}}
  };`)
  source.documentFiles = ['documents.json']; source.markdownFiles = entries.map(entry => entry.id + '.md')
  source.assetFiles = ['knowledge.json', 'scripts/status.js', 'scripts/activities/study.js']
  save('worldpack.source.json', source)
}

function expected(context: WorldJsonObject): string[] {
  const actor = object(context.character).characterId, current = rows(object(context.items).current)
  const known = rows(context.knownStatus), activity = object(context.activity), game = object(activity.game)
  const checks: Record<string, boolean> = {
    front: context.locationId === 'location:front-room',
    'with-player': rows(object(context.scene).people).some(row => row.characterId === PLAYER),
    'visible-key': current.some(row => row.entityId === 'entity:brass-key'),
    'held-key': actor === COMPANION && current.some(row => row.entityId === 'entity:brass-key' && row.holderId === actor),
    fresh: known.some(row => row.key === 'money' && row.current === true), stale: known.some(row => row.key === 'money' && row.current === false),
    'private-stimulus': rows(context.stimulus).some(row => { const content = object(row.content); return content.actorId === PLAYER
      && (String(object(content.speech).text ?? '').includes('琥珀短笺') || rows(object(content.speech).segments).some(segment => segment.type === 'speech' && String(segment.text).includes('琥珀短笺'))) }),
    'activity-own': activity.activityKey === 'study' && game.phase === 'briefing' && object(game.private).seal === '竹影细雨',
    'activity-foreign': object(game.private).seal === '月光绳结',
    'activity-internal': object(game.internal).answer === '石榴暗号',
    personal: actor === COMPANION && context.locationId === 'location:front-room',
  }
  return Object.entries(checks).filter(([, match]) => match).map(([id]) => 'document:' + id).sort()
}

/** Key comes from the calling process only. Never persist headers, environment or provider error bodies. */
export async function playKnowledgeConditions(output: string) {
  const key = process.env.OPENCODE_API_KEY?.trim()
  if (!key) throw new Error('OpenCode user credential missing')
  const run = resolve(output), local = relative(resolve('.tmp'), run)
  if (!local || local.startsWith('..') || isAbsolute(local) || existsSync(run)) throw new Error('Use a new directory inside .tmp')
  const session = randomUUID(), headers = { authorization: 'Bearer ' + key, 'x-opencode-session': session, 'content-type': 'application/json' }
  let endpoint = ''
  for (const base of ['https://opencode.ai/zen/go/v1', 'https://opencode.ai/inference/go/v1']) {
    const response = await fetch(base + '/models', { headers, redirect: 'error', signal: AbortSignal.timeout(30000) })
    const data = await response.json() as { data?: { id: string }[] }
    console.log(JSON.stringify({ preflight: true, base, status: response.status, requestedModelFound: data.data?.some(row => row.id === MODEL) ?? false }))
    if (response.ok && data.data?.some(row => row.id === MODEL)) { endpoint = base + '/chat/completions'; break }
  }
  if (!endpoint) throw new Error('Requested OpenCode model unavailable')
  mkdirSync(run, { recursive: true })
  const pack = resolve(run, 'pack'); writeKnowledgeConditionsPack(pack)
  const calls: WorldJsonObject[] = [], turns: WorldJsonObject[] = []
  const save = (file: string, value: unknown) => writeFileSync(resolve(run, file), JSON.stringify(value, null, 2))
  let stage = 'startup'
  const relay = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => { void (async () => {
      const started = performance.now(), wire = JSON.parse(body)
      let input: WorldJsonObject = {}
      try { input = object(JSON.parse(wire.messages?.findLast((row: { role: string }) => row.role === 'user')?.content ?? '{}')) } catch { /* Utility calls need not contain a role request. */ }
      const context = object(input.context), actor = object(context.character).characterId
      const ids = rows(object(context.knowledge).entries).map(row => String(row.documentId)).sort()
      const record: Record<string, WorldJsonValue> = { index: calls.length + 1, stage, kind: actor ? 'character' : 'utility',
        ...(actor ? { actor, continuation: input.continuation ?? false, context: {
          character: context.character!, locationId: context.locationId ?? null, scene: context.scene!, items: context.items!, knownStatus: context.knownStatus ?? [],
          stimulus: context.stimulus ?? [], activity: context.activity ?? null, knowledge: context.knowledge!,
        }, knowledgeIds: ids, expectedIds: expected(context), selectionMatches: JSON.stringify(ids) === JSON.stringify(expected(context)) } : {}) }
      calls.push(record)
      try {
        const upstream = await fetch(endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(90000) })
        const text = await upstream.text(), result = JSON.parse(text)
        record.httpStatus = upstream.status; record.returnedModel = result.model ?? null; record.usage = result.usage ?? null
        if (upstream.ok && actor) {
          const message = result.choices?.[0]?.message
          try { record.decision = JSON.parse(message?.tool_calls?.[0]?.function?.arguments ?? message?.content ?? 'null') } catch { record.invalidPayload = true }
        }
        response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(text)
      } catch { record.transportFailed = true; response.writeHead(502); response.end('{"error":{"message":"playtest transport failed"}}') }
      finally { record.durationMs = Math.round(performance.now() - started); save('calls.json', calls) }
    })().catch(() => { response.writeHead(500); response.end('{"error":{"message":"playtest observer failed"}}') }) })
  })
  await new Promise<void>(ready => relay.listen(0, '127.0.0.1', ready))
  let runtime: FrozenWorldPlaytestRuntime | undefined, credentialLeaks = 0
  try {
    runtime = await FrozenWorldPlaytestRuntime.create({ packPath: pack, dataDirectory: resolve(run, 'world'), provider: 'local',
      model: MODEL, memoryCore: true, timeoutMs: 90000, utilityEndpoint: 'http://127.0.0.1:' + (relay.address() as { port: number }).port + '/v1/chat/completions' })
    const step = async (name: string, action: () => ReturnType<NonNullable<typeof runtime>['state']>) => {
      stage = name; const before = await runtime!.state(), started = performance.now(), state = await action()
      turns.push({ stage, durationMs: Math.round(performance.now() - started), error: state.error, notice: state.notice ?? null,
        statusBar: (state.statusBar ?? []) as unknown as WorldJsonObject[], lines: state.transcript.filter(line => line.seq > (before.transcript.at(-1)?.seq ?? 0)) as unknown as WorldJsonObject[] })
      save('turns.json', turns)
      console.log(JSON.stringify({ stage, error: state.error, calls: calls.length, durationMs: Math.round(performance.now() - started) }))
      if (state.error) throw new Error('Playtest turn failed: ' + name)
      return state
    }
    const locations = () => {
      const store = new WorldStore(resolve(run, 'world/world.sqlite'))
      try { const events = store.readEvents(runtime!.address); return {
        player: currentLocation(events, PLAYER), companion: currentLocation(events, COMPANION) }
      } finally { store.close() }
    }
    const joinCompanion = async () => { const position = locations(); if (position.companion && position.player !== position.companion) {
      await runtime!.submit('/act move ' + JSON.stringify({ locationId: position.companion }))
    } }
    const speak = async (text: string, target?: string) => {
      if (target === COMPANION) await joinCompanion()
      return runtime!.submit('/act speak ' + JSON.stringify({ text,
        scope: target ? 'direct' : 'scene_public', ...(target ? { addresseeIds: [target] } : {}) }))
    }
    await step('player-take', () => runtime!.perform({ actionType: 'interact', parameters: {
      targetRef: { kind: 'entity', id: 'entity:brass-key' }, bindingId: 'binding:key-take', definitionRef: { id: 'base:take', version: 1 }, arguments: {} } }))
    await step('front-background', () => speak('这间前室以前叫什么？这把黄铜钥匙有什么纹样？'))
    await step('private-stimulus', () => speak('只问你：馆史里的琥珀短笺是什么？', COMPANION))
    await step('stimulus-ended', () => speak('换个话题，今天我们慢慢逛就好。'))
    await joinCompanion()
    await step('player-give', () => runtime!.perform({ actionType: 'interact', parameters: {
      targetRef: { kind: 'entity', id: 'entity:brass-key' }, bindingId: 'binding:key-give', definitionRef: { id: 'base:give', version: 1 }, arguments: { recipientId: COMPANION } } }))
    await step('held-key-label', () => speak('现在钥匙交给你了，检修标签写的是什么？', COMPANION))
    await step('private-adjustment', () => runtime!.submit('/status adjust-companion {}'))
    await step('stale-balance', () => speak('先别急着查钱包，你上次确认的余额现在还有效吗？不确定就直说。', COMPANION))
    await step('recheck-balance', () => speak('现在请实际查看你自己的钱包，然后告诉我确认了多少。', COMPANION))
    const activityAction = async (operation: string) => {
      if (operation === 'start') await joinCompanion()
      const state = await runtime!.state(), activity = state.activity
      return runtime!.activityAction({ activityKey: 'study', activityId: operation === 'start' ? null : String(activity?.id),
        revision: operation === 'start' ? 0 : Number(activity?.revision), operation, parameters: {}, requestId: randomUUID() })
    }
    await step('activity-start', () => activityAction('start'))
    await step('activity-own-material', () => speak('请讲讲你分到的纸签，说明自己的即可，不用猜其他人的。', COMPANION))
    await step('activity-scheduled', () => activityAction('pass'))
    await step('activity-end', () => activityAction('quit'))
    await step('after-activity', () => speak('讲解结束了。你觉得旧馆的哪个细节有意思？', COMPANION))
    await step('ask-move', () => speak('请你实际先去后室等我，我随后过去。', COMPANION))
    await step('player-follow', () => runtime!.submit('/act move {"locationId":"location:back-room"}'))
    await step('back-room', () => speak('我们现在在哪儿？钥匙目前是谁保管？'))
    await step('player-depart', () => runtime!.submit('/act move ' + JSON.stringify({ locationId: locations().player === 'location:front-room' ? 'location:back-room' : 'location:front-room' })))
    await step('player-rejoin', async () => { await joinCompanion(); return speak('我回来了。现在继续慢慢看吧。', COMPANION) })
    const final = await runtime.state(); save('transcript.json', final.transcript)
    const characterCalls = calls.filter(row => row.kind === 'character')
    const coverage = Object.fromEntries(['front', 'with-player', 'visible-key', 'held-key', 'fresh', 'stale', 'private-stimulus', 'activity-own', 'personal']
      .map(id => [id, { selected: characterCalls.filter(row => (row.knowledgeIds as string[]).includes('document:' + id)).length,
        absent: characterCalls.filter(row => !(row.knowledgeIds as string[]).includes('document:' + id)).length }]))
    save('summary.json', { model: MODEL, endpoint, memoryMode: final.debug.memoryMode, turns: turns.length,
      requests: calls.length, characterRequests: characterCalls.length, successfulRequests: calls.filter(row => row.httpStatus === 200).length,
      selectionMismatches: characterCalls.filter(row => row.selectionMatches !== true).map(row => row.index), coverage,
      forbiddenKnowledgeDeliveries: characterCalls.filter(row => (row.knowledgeIds as string[]).some(id => ['document:activity-foreign', 'document:activity-internal'].includes(id))).map(row => row.index),
      sessionHeader: true, credentialSource: 'user-environment', limitations: ['单次小型受控试玩，非长会话验收', 'NPC 行动由真实模型决定；未触发的条件须单独报告', '知识不再注入不等于角色遗忘'] })
  } finally {
    await runtime?.close(); relay.closeAllConnections(); await new Promise<void>(done => relay.close(() => done()))
    let scanned = 0, leaks = 0
    const scan = (directory: string) => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (entry.isFile()) { scanned++; if (readFileSync(path).includes(Buffer.from(key))) leaks++ }
    } }
    scan(run); save('credential-scan.json', { scannedFiles: scanned, credentialMatches: leaks })
    console.log(JSON.stringify({ finished: existsSync(resolve(run, 'summary.json')), requests: calls.length, credentialMatches: leaks, output: run }))
    credentialLeaks = leaks
  }
  if (credentialLeaks) throw new Error('Credential found in playtest artifacts')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await playKnowledgeConditions(process.argv[2] ?? '.tmp/knowledge-conditions-deepseek-' + Date.now())
}
