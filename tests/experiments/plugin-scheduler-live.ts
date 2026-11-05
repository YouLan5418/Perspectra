import { createRoleplayCore } from '../support/roleplay-runtime.ts'
/** Live scheduling acceptance: record real responses on the baseline, replay them after migration,
 * then run `live` on the new runtime. Uses fresh data only; never saves headers or credentials.
 * Usage: record|replay|live <case> <new evidence file>; endpoint/model come from PERSPECTRA_MODEL_*.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldHostCore } from '../../desktop/host/world-runtime.ts'
import { environmentRoleModels } from '../../desktop/model-connections.ts'
import { playSettings } from '../../desktop/play-settings.ts'

const [mode, scenario, destination] = process.argv.slice(2)
assert(['record', 'replay', 'live'].includes(mode!) && destination, 'expected mode, case and evidence file')
const packs: Record<string, string> = {
  chat: 'dynamic-scheduling',
  staged: 'autonomy-scheduling',
  integrated: 'autonomy-scheduling',
  sweet: 'model-girls-sweet-days',
  werewolf: 'model-girls-werewolf',
}
assert(packs[scenario!], 'unknown case')
const file = resolve(destination)
assert(mode === 'replay' || !existsSync(file), 'evidence must use a new file')
mkdirSync(dirname(file), { recursive: true })
const data = mkdtempSync(file + '.' + mode + '-data-')
type Exchange = { request: WorldJsonObject; response: string; contentType: string; elapsedMs: number }
const recorded = mode === 'replay' ? JSON.parse(readFileSync(file, 'utf8')) : undefined
const exchanges: Exchange[] = []
const upstream = process.env.PERSPECTRA_MODEL_ENDPOINT
const key = process.env.PERSPECTRA_MODEL_API_KEY
const failures: string[] = []
const proxy = createServer(async (req, res) => {
  try {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const request = JSON.parse(body) as WorldJsonObject
    const before = performance.now()
    const index = exchanges.length
    // Reserve at arrival, not completion: independent character requests may finish in another order.
    exchanges.push({ request, response: '', contentType: '', elapsedMs: 0 })
    let response: string, contentType: string
    if (mode === 'replay') {
      assert(recorded.exchanges[index], 'more requests than baseline')
      const scrub = (value: unknown) =>
        JSON.parse(
          JSON.stringify(value)
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, 'uuid')
            .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu, 'wall-clock'),
        )
      assert(isDeepStrictEqual(scrub(request), scrub(recorded.exchanges[index].request)), 'request differs at ' + index)
      ;({ response, contentType } = recorded.exchanges[index])
      // Tool arguments may echo an activity UUID. Bind it to this fresh world; all semantic fields stay intact.
      const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu
      const oldIds = JSON.stringify(recorded.exchanges[index].request).match(uuid) ?? []
      const newIds = JSON.stringify(request).match(uuid) ?? []
      assert.equal(oldIds.length, newIds.length)
      const bindings = new Map(oldIds.map((id, n) => [id, newIds[n]!]))
      response = response.replace(uuid, id => bindings.get(id) ?? id)
      await delay(recorded.exchanges[index].elapsedMs)
    } else {
      assert(upstream, 'PERSPECTRA_MODEL_ENDPOINT required')
      const reply = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
        body,
        signal: AbortSignal.timeout(120_000),
      })
      assert(reply.ok, 'upstream HTTP ' + reply.status)
      response = await reply.text()
      contentType = reply.headers.get('content-type') ?? 'application/json'
    }
    exchanges[index] = { request, response, contentType, elapsedMs: Math.round(performance.now() - before) }
    res.writeHead(200, { 'content-type': contentType })
    res.end(response)
  } catch (error) {
    failures.push((error as Error).message)
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('acceptance proxy failed')
  }
})
await new Promise<void>(done => proxy.listen(0, '127.0.0.1', done))
const endpoint = 'http://127.0.0.1:' + (proxy.address() as { port: number }).port + '/v1/chat/completions'
const models = environmentRoleModels({
  PERSPECTRA_MODEL_ENDPOINT: endpoint,
  PERSPECTRA_MODEL: process.env.PERSPECTRA_MODEL,
  PERSPECTRA_MODEL_PROTOCOL: 'openai',
})
const random = Math.random
Math.random = () => 0.25
let runtime: WorldHostCore | undefined
const states: unknown[] = []
const started = performance.now()
try {
  runtime = await createRoleplayCore({
    packPath: resolve('examples/world-packs', packs[scenario!]!),
    dataDirectory: data,
    models,
    serialScheduling: scenario !== 'integrated',
    stagedAutonomy: scenario === 'staged',
    playSettings: playSettings({
      modelTimeoutSeconds: 120,
      activationTimeoutSeconds: 240,
      maximumNpcCalls: 4,
      maximumWaves: 2,
      maximumCallsPerCharacter: 1,
      reactionDeadlineSeconds: 240,
      autonomyDeadlineSeconds: 240,
      activityDeadlineSeconds: 300,
      activityOpportunities: 4,
    }),
  })
  const snapshot = async () => {
    const state = await runtime!.state()
    states.push({
      transcript: state.transcript,
      scene: state.world.currentScene,
      activities: state.activities,
      notice: state.notice,
      error: state.error,
      activation: state.debug.activationCycle,
      autonomy: state.debug.autonomy,
      headSeq: state.debug.headSeq,
      tick: state.debug.tick,
    })
    return state
  }
  const activity = async (activityKey: string, operation: string, parameters: WorldJsonObject = {}) => {
    const a = (await runtime!.state()).activities?.find(item => item.activityKey === activityKey)
    assert(a, 'missing activity ' + activityKey)
    await runtime!.activityAction({
      activityKey,
      activityId: a.id === null ? null : String(a.id),
      revision: Number(a.revision ?? 0),
      operation,
      parameters,
      requestId: 'acceptance-' + states.length,
    })
    return snapshot()
  }
  await snapshot()
  if (scenario === 'sweet') {
    await activity('prologue', 'start')
    for (let step = 0; step < 100; step++) {
      const a = (await runtime.state()).activities?.find(item => item.activityKey === 'prologue')
      if (!(a?.game as WorldJsonObject)?.active) break
      await activity('prologue', 'next')
    }
    const a = (await runtime.state()).activities?.find(item => item.activityKey === 'prologue')
    assert(!(a?.game as WorldJsonObject)?.active, 'prologue did not finish')
    assert.equal(exchanges.length, 0, 'scripted prologue must not call the model')
    await runtime.submit('早上好，昨晚睡得还习惯吗？今天想先做点什么？')
    await snapshot()
  } else if (scenario === 'werewolf') {
    await activity('werewolf', 'start')
    for (let step = 0; step < 5; step++) {
      const a = (await runtime.state()).activities?.find(item => item.activityKey === 'werewolf')
      const game = a!.game as WorldJsonObject
      if (!game.active || (exchanges.length >= 4 && game.phase === 'day-speak')) break
      const own = game.private as WorldJsonObject
      const mine = game.phase === 'night' ? own['轮到你'] === true : game.turn === 'character:player'
      if (!mine) await activity('werewolf', 'retry')
      else if (game.phase === 'day-speak') {
        await runtime.submit('我先听听大家的判断，现在还没有确定的线索。')
        await snapshot()
      } else {
        const living = ((game.public as WorldJsonObject)['存活'] as string[]).filter(name => name !== '玩家')
        if (game.phase === 'vote') await activity('werewolf', 'vote', { target: living[0]! })
        else if (own['身份'] === '狼人')
          await activity('werewolf', 'kill', { target: living.find(n => n !== own['狼同伴'])! })
        else if (own['身份'] === '预言家') await activity('werewolf', 'check', { target: living[0]! })
        else if (own['身份'] === '女巫') await activity('werewolf', 'potion', { choice: 'none' })
      }
    }
  } else {
    await runtime.submit(
      scenario === 'chat'
        ? '你听见隔壁有人吗？我想先和你聊聊今天的安排。'
        : '我先在这里等一会儿，你们各自忙自己的事吧。',
    )
    await snapshot()
  }
  assert.equal(failures.length, 0, 'proxy failed: ' + failures.join(', '))
  assert(exchanges.length > 0, 'case must exercise real requests')
  assert(
    states.every(state => !(state as { error?: boolean }).error),
    'runtime reported a processing failure',
  )
  const normalized = (value: unknown) => {
    const ids = new Map<string, string>()
    return JSON.parse(
      JSON.stringify(value)
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, id => {
          if (!ids.has(id)) ids.set(id, 'uuid-' + (ids.size + 1))
          return ids.get(id)!
        })
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu, 'wall-clock'),
    )
  }
  const comparable = { requests: exchanges.map(e => e.request), states }
  const evidence = {
    scenario,
    model: process.env.PERSPECTRA_MODEL,
    elapsedMs: Math.round(performance.now() - started),
    exchanges,
    comparable: normalized(comparable),
  }
  const serialized = JSON.stringify(evidence, null, 2)
  assert(!key || !serialized.includes(key), 'credential detected in evidence')
  if (mode === 'replay') {
    assert(
      isDeepStrictEqual(evidence.comparable, recorded.comparable),
      'request or committed result differs from baseline',
    )
    assert.equal(exchanges.length, recorded.exchanges.length)
  }
  writeFileSync(mode === 'replay' ? file + '.replayed.json' : file, serialized + '\n')
  process.stdout.write(
    JSON.stringify({
      mode,
      scenario,
      calls: exchanges.length,
      elapsedMs: evidence.elapsedMs,
      errors: states.filter(s => (s as { error?: boolean }).error).length,
    }) + '\n',
  )
} catch (error) {
  const failure = JSON.stringify({ exchanges, states, error: (error as Error).message }, null, 2)
  assert(!key || !failure.includes(key), 'credential detected in failure evidence')
  writeFileSync(data + '.failure.json', failure + '\n')
  throw error
} finally {
  await runtime?.close()
  proxy.closeAllConnections()
  await new Promise<void>(done => proxy.close(() => done()))
  Math.random = random
}
