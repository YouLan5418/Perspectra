import { createServer, type Server } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { compileWorldPackSource } from '@harness-world/world-pack'
import { WorldStore } from '@harness-world/store-sqlite'
import { WorldHostCore } from '../../desktop/host/world-runtime.ts'
import { PackStatus } from '../../desktop/host/pack-status.ts'

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

/** Everyone starts in the living room; heroines describe in turn and vote for the next heroine in line. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'model-girls-undercover-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const pack = join(root, 'pack'),
    data = join(root, 'data')
  cpSync(resolve('examples/world-packs/model-girls-sweet-days'), pack, { recursive: true })
  const characters = JSON.parse(readFileSync(join(pack, 'characters.json'), 'utf8'))
  for (const c of characters.characters) c.initialLocationId = 'location:living-room'
  writeFileSync(join(pack, 'characters.json'), JSON.stringify(characters))
  const scenes = JSON.parse(readFileSync(join(pack, 'scenes.json'), 'utf8'))
  for (const s of scenes.scenes) {
    s.participantIds =
      s.locationId === 'location:living-room'
        ? characters.characters.map((c: { characterId: string }) => c.characterId)
        : []
    s.lifecycle = s.participantIds.length ? 'active' : 'created'
  }
  writeFileSync(join(pack, 'scenes.json'), JSON.stringify(scenes))
  const compiled = await compileWorldPackSource(
    pack,
    createInstalledInteractionPackages().map(interactionPackageDescription),
  )
  const status = PackStatus.load(pack, compiled)!

  // What each heroine was shown, by character.
  const seen: { self: string; text: string }[] = []
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => (body += String(chunk)))
    request.on('end', () => {
      const user = (JSON.parse(body).messages as { role: string; content: string }[]).findLast(m => m.role === 'user')
      const input = user?.content.startsWith('{') ? JSON.parse(user.content) : {}
      const activity = find(input, o => o.activityKey === 'undercover' && typeof o.game === 'object')
      const game = activity?.game as WorldJsonObject | undefined
      const self = String(find(input.context, o => typeof o.characterId === 'string')?.characterId ?? '')
      seen.push({ self, text: JSON.stringify(input) })
      let decision: WorldJsonObject = { decision: 'abstain' }
      if (input.result !== undefined)
        decision = { decision: 'publish', segments: [{ type: 'speech', text: '就这么定了。' }] }
      else if (game?.phase === 'describe')
        decision = { decision: 'publish', segments: [{ type: 'speech', text: '这个东西家里就有。' }] }
      else if (game?.phase === 'vote')
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
              target: NAMES[HEROINES[(HEROINES.indexOf(self) + 1) % 3]!]!,
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
  const runtime = await WorldHostCore.create({
    packPath: pack,
    dataDirectory: data,
    provider: 'local',
    model: 'fixture',
    utilityEndpoint: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions',
    timeoutMs: 5000,
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
  return { runtime, truth, current, request, seen }
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
