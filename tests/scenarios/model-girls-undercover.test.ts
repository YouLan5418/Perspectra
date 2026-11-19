import { createRoleplayCore } from '../support/roleplay-runtime.ts'
import { type Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { type WorldJsonObject } from '@perspectra/sdk/contracts'
import { compileWorldPackSource } from '@perspectra/world-pack'
import { WorldStore } from '@perspectra/core/store'
import { loadStatus } from '../support/status-runtime.ts'
import { createChatServer, fakeModels } from '../support/fake-provider.ts'

const HEROINES = ['character:gpt', 'character:claude', 'character:deepseek']
const NAMES: Record<string, string> = {
  'character:gpt': 'GPT',
  'character:claude': 'Claude',
  'character:deepseek': 'DeepSeek',
}
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

const find = (value: unknown, test: (o: WorldJsonObject) => boolean): WorldJsonObject | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  if (!Array.isArray(value) && test(value as WorldJsonObject)) return value as WorldJsonObject
  for (const child of Object.values(value)) {
    const hit = find(child, test)
    if (hit) return hit
  }
  return undefined
}

/** The participants describe in turn and vote for the next heroine in line. */
async function fixture(atThreshold = false, outageScene?: 'living-room' | 'kitchen') {
  const root = mkdtempSync(join(tmpdir(), 'model-girls-undercover-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const pack = join(root, 'pack'),
    data = join(root, 'data')
  cpSync(resolve('examples/world-packs/model-girls-sweet-days'), pack, { recursive: true })
  // This fixture starts after the prologue, at the first morning.
  const sourcePath = join(pack, 'worldpack.source.json')
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
  source.assetFiles = source.assetFiles.filter((asset: string) => asset !== 'scripts/activities/prologue.js')
  writeFileSync(sourcePath, JSON.stringify(source))
  const statusPath = join(pack, 'scripts/status.js')
  writeFileSync(
    statusPath,
    readFileSync(statusPath, 'utf8').replace(
      "day: 0,\n        slot: '深夜'",
      atThreshold ? "day: 2,\n        slot: '午后'" : "day: 1,\n        slot: '清晨'",
    ),
  )
  const characters = JSON.parse(readFileSync(join(pack, 'characters.json'), 'utf8'))
  for (const c of characters.characters)
    c.initialLocationId =
      outageScene && c.characterId === 'character:deepseek' ? 'location:kitchen' : 'location:living-room'
  writeFileSync(join(pack, 'characters.json'), JSON.stringify(characters))
  const scenes = JSON.parse(readFileSync(join(pack, 'scenes.json'), 'utf8'))
  for (const s of scenes.scenes) {
    s.participantIds = characters.characters
      .filter((c: { initialLocationId: string }) => c.initialLocationId === s.locationId)
      .map((c: { characterId: string }) => c.characterId)
    s.lifecycle = s.participantIds.length ? 'active' : 'created'
  }
  writeFileSync(join(pack, 'scenes.json'), JSON.stringify(scenes))
  if (outageScene) {
    const path = join(pack, 'world-events.json')
    const { when: _when, sceneNotices: _notices, ...blackout } = JSON.parse(readFileSync(path, 'utf8')).rules[0]
    writeFileSync(
      path,
      JSON.stringify({
        rules: [{ ...blackout, round: 1, location: 'location:' + outageScene, wakeCharacters: ['character:gpt'] }],
      }),
    )
  }
  const compiled = await compileWorldPackSource(pack, [])
  const status = loadStatus(pack, compiled)!

  const voters = outageScene ? HEROINES.slice(0, 2) : HEROINES
  // What each heroine was shown, by character.
  let holdLastVote = atThreshold
  const seen: { self: string; text: string; leading: string; tools: string }[] = []
  const server: Server = createChatServer((request, response) => {
    let body = ''
    request.on('data', chunk => (body += String(chunk)))
    request.on('end', () => {
      const payload = JSON.parse(body)
      const user = (payload.messages as { role: string; content: string }[]).findLast(m => m.role === 'user')
      const input = user?.content.startsWith('{') ? JSON.parse(user.content) : {}
      const activity = find(input, o => o.activityKey === 'undercover' && typeof o.game === 'object')
      const game = activity?.game as WorldJsonObject | undefined
      const self = String(find(input.context, o => typeof o.characterId === 'string')?.characterId ?? '')
      seen.push({
        self,
        text: user?.content ?? '',
        leading: JSON.stringify(payload.messages.slice(0, payload.messages.indexOf(user))),
        tools: JSON.stringify(payload.tools),
      })
      let decision: WorldJsonObject = { decision: 'abstain' }
      if (input.result !== undefined)
        decision = { decision: 'publish', segments: [{ type: 'speech', text: '就这么定了。' }] }
      else if (game?.phase === 'describe')
        decision = { decision: 'publish', segments: [{ type: 'speech', text: '这个东西家里就有。' }] }
      else if (
        game?.phase === 'vote' &&
        !(holdLastVote && (((game.public as WorldJsonObject).已投票 as string[] | undefined)?.length ?? 0) >= 2)
      )
        decision = {
          decision: 'perform',
          actionType: 'interact',
          parameters: {
            targetRef: { kind: 'character', id: self },
            bindingId: String(activity!.id),
            definitionRef: { id: 'activity:vote', version: 1 },
            arguments: {
              activityId: String(activity!.id),
              revision: Number(activity!.revision),
              target: NAMES[voters[(voters.indexOf(self) + 1) % voters.length]!]!,
              reason: '刚才那句太含糊了。',
            },
          },
        }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              message: { tool_calls: [{ function: { name: 'submit_actions', arguments: JSON.stringify(decision) } }] },
            },
          ],
        }),
      )
    })
  })
  cleanup.push(() => new Promise<void>(done => (server.closeAllConnections(), server.close(() => done()))))
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const runtime = await createRoleplayCore({
    packPath: pack,
    dataDirectory: data,
    models: fakeModels(
      'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions',
      'openai',
      'fixture',
    ),
    timeoutMs: 5000,
    // Isolate the prize check from the independent 30-yuan utility-bill beat.
    pacingEnabled: atThreshold || outageScene !== undefined,
  })
  cleanup.push(() => runtime.close())
  const truth = () => {
    const store = new WorldStore(join(data, 'world.sqlite'))
    try {
      return status.truth(store.readEvents(runtime.address))
    } finally {
      store.close()
    }
  }
  const current = async () =>
    ((await runtime.state()).activities as WorldJsonObject[]).find(a => a.activityKey === 'undercover')!
  const request = async (operation: string, parameters: WorldJsonObject, requestId: string) => {
    const a = operation === 'start' ? undefined : await current()
    return runtime.activityAction({
      activityKey: 'undercover',
      activityId: a ? String(a.id) : null,
      revision: a ? Number(a.revision) : 0,
      operation,
      parameters,
      requestId,
    })
  }
  return {
    runtime,
    truth,
    current,
    request,
    seen,
    release: () => {
      holdLastVote = false
    },
  }
}

it('needs at least two heroines, keeps every word private and settles time, prize and privilege together', async () => {
  const f = await fixture()
  await expect(f.request('start', { npcIds: ['character:claude'] }, 'solo')).rejects.toThrow()
  const moneyBefore = f.truth().characters['character:player']!.money as number
  await f.request('start', { npcIds: HEROINES }, 'start')
  for (let step = 0; step < 16; step++) {
    const game = (await f.current()).game as WorldJsonObject
    if (!game.active) break
    if (game.turn !== 'character:player') await f.request('retry', {}, 'retry-' + step)
    else if (game.phase === 'describe') await f.runtime.submit('我这个东西很常见。')
    else await f.request('vote', { target: 'GPT', reason: '感觉她在绕弯子。' }, 'vote-' + step)
  }
  const game = (await f.current()).game as WorldJsonObject
  expect(game.phase).toBe('finished')
  const result = String((game.public as WorldJsonObject).lastResult)
  expect(result).toContain('卧底是')

  // Heroines saw their own word only; the undercover identity and the other word stayed internal.
  const words = new Map<string, Set<string>>()
  for (const s of f.seen.filter(s => HEROINES.includes(s.self))) {
    expect(s.text).not.toMatch(/civilianWord|undercoverWord|"votes"|"order"/)
    const word = /"我的词":"([^"]+)"/.exec(s.text)?.[1]
    if (word) words.set(s.self, (words.get(s.self) ?? new Set()).add(word))
  }
  for (const set of words.values()) expect(set.size).toBe(1)

  const after = f.truth()
  expect(after.public.slot).toBe('午后')
  const winners = ['character:player', ...HEROINES].filter(id => after.characters[id]!['undercover-privilege'] !== '')
  expect(winners.length).toBeGreaterThan(0)
  const playerWon = winners.includes('character:player')
  expect(after.characters['character:player']!.money).toBe(moneyBefore + (playerWon ? 30 : 0))
  expect(result).toContain(playerWon ? '屋主赢得 30 元生活费' : '赢家')
  expect(result).toContain('时间来到了午后')
}, 60000)

it('costs no time when the player quits midway', async () => {
  const f = await fixture()
  await f.request('start', { npcIds: ['character:gpt', 'character:deepseek'] }, 'start')
  await f.request('quit', {}, 'quit')
  const game = (await f.current()).game as WorldJsonObject
  expect(game.phase).toBe('quit')
  expect(String((game.public as WorldJsonObject).lastResult)).toContain('答案揭晓')
  expect(f.truth().public.slot).toBe('清晨')
}, 60000)

it.each(['player vote', 'retry'] as const)(
  'settles the pack clock when the final NPC ballot follows %s',
  async route => {
    const f = await fixture(true)
    await f.request('start', { npcIds: HEROINES }, 'start')
    for (let step = 0; step < 16; step++) {
      const game = (await f.current()).game as WorldJsonObject
      if (game.phase === 'vote' && ((game.public as WorldJsonObject).已投票 as string[] | undefined)?.length === 2)
        break
      if (game.phase === 'describe' && game.turn === 'character:player') await f.runtime.submit('家里常用。')
      else await f.request('retry', {}, 'prepare-' + step)
    }
    const ballot = () => f.request('vote', { target: 'GPT', reason: '她的描述太含糊。' }, 'player-vote')
    if (route === 'player vote') f.release()
    await ballot()
    if (route === 'retry') {
      expect(f.truth().public).toMatchObject({ slot: '午后', 'power-on': true })
      expect(((await f.current()).game as WorldJsonObject).phase).toBe('vote')
      f.release()
      await f.request('retry', {}, 'final-retry')
    }
    const game = (await f.current()).game as WorldJsonObject
    expect(game.phase).toBe('finished')
    const summary = game.public as WorldJsonObject
    expect(summary.已投票).toHaveLength(4)
    expect((summary.已投票 as string[]).at(-1)).toMatch(/^(GPT|Claude|DeepSeek)→/u)
    expect(String(summary.lastResult)).toContain('卧底是')
    expect(String(summary.lastResult)).toContain('傍晚')
    expect(f.truth().public).toMatchObject({ day: 2, slot: '傍晚', 'power-on': false })
    if (route === 'retry')
      expect(
        (await f.runtime.state()).activities?.filter(a => a.activityKey === 'blackout-comfort').map(a => a.game),
      ).not.toContainEqual(expect.objectContaining({ active: true }))
  },
  90_000,
)

it.each(['living-room', 'kitchen'] as const)(
  'keeps the %s outage in authorized history during real game turns',
  async scene => {
    const witness = scene === 'living-room'
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.999)
    cleanup.push(() => {
      rng.mockRestore()
    })
    const f = await fixture(false, scene)
    const gpt = () => f.seen.filter(row => row.self === 'character:gpt')
    const notice = '窗外闷雷滚过，啪的一声，屋里的灯灭了。'
    await f.request('start', { npcIds: ['character:gpt', 'character:claude'] }, 'deal')
    expect(f.truth().public['power-on']).toBe(false)
    expect(gpt()).toHaveLength(0)
    for (let i = 0; i < 2; i++) await f.runtime.submit('我这个东西很常见。', 'description-' + i)
    const descriptions = gpt().filter(row =>
      find(JSON.parse(row.text).context, o => o.phase === 'describe' && o.turn === 'character:gpt'),
    )
    expect(descriptions).toHaveLength(2)
    expect(JSON.parse(descriptions[0]!.text).context.statusChanges).toContainEqual(
      expect.objectContaining({ key: 'power-on', from: true, to: false }),
    )
    for (const row of gpt()) {
      const ctx = JSON.parse(row.text).context
      expect(ctx.activity.activityKey).toBe('undercover')
      expect(find(ctx, o => '我的词' in o)).toBeDefined()
      expect(ctx.knownStatus).toContainEqual(expect.objectContaining({ key: 'power-on', value: false }))
      expect(row.text.split(notice).length - 1).toBe(witness ? 1 : 0)
      expect(JSON.stringify(ctx.history).includes(notice)).toBe(witness)
      expect(JSON.stringify(ctx.stimulus)).not.toMatch(/eventNotice|context\.history\[/)
    }
    const before = gpt().length
    await f.request('vote', { target: 'GPT', reason: '她的描述。' }, 'final-vote')
    expect((await f.current()).game).toMatchObject({ active: false, phase: 'finished' })
    expect(gpt().length - before).toBe(witness ? 1 : 0)
    if (!witness) return
    const wake = gpt().at(-1)!
    const ctx = JSON.parse(wake.text).context
    const ref = /^context\.history\[(\d+)\]$/.exec(ctx.stimulus[0]?.observation)
    expect(ref).not.toBeNull()
    expect(ctx.history[Number(ref![1])].content.content).toEqual({ eventNotice: notice })
    expect(wake.text.split(notice)).toHaveLength(2)
    // A real new private message adds a history row after the independent decision.
    await f.runtime.submit(
      '/act speak ' +
        JSON.stringify({ text: 'GPT，游戏结束了吗？', scope: 'private', addresseeIds: ['character:gpt'] }),
    )
    const ordinary = gpt().at(-1)!
    expect(gpt().length - before).toBe(2)
    const next = JSON.parse(ordinary.text).context
    expect(JSON.stringify(next.stimulus)).not.toMatch(/eventNotice|context\.history\[/)
    expect(next.history.slice(0, ctx.history.length)).toEqual(ctx.history)
    // The previous closing ] becomes a comma when the new row is appended.
    for (const [from, to] of [
      [descriptions[0]!, wake],
      [wake, ordinary],
    ] as const) {
      const history = JSON.parse(from.text).context.history
      const end = from.text.indexOf(',"history":') + ',"history":'.length + JSON.stringify(history).length - 1
      const prefix = from.text.slice(0, end)
      expect(prefix).toContain(notice)
      expect(to.text.startsWith(prefix)).toBe(true)
      expect(from.leading).toBe(to.leading)
      expect(from.tools).toBe(to.tools)
    }
  },
  60_000,
)
