import { afterEach, expect, it } from 'vitest'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve, sep, join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadPackWeb, saveStageMarks, type StageMarks } from '../../desktop/host/pack-frontend.ts'
import { createHostServer, type HostRuntime } from '../../desktop/host/http-server.ts'

const token = 'a'.repeat(64)
const roots: string[] = [],
  servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('unexpected temporary directory')
    await rm(root, { recursive: true, force: true })
  }
})
const png = Buffer.from([137, 80, 78, 71])
const claude = {
  sheets: { faces: 'portraits/claude/faces.png' },
  expressions: { smile: { sheet: 'faces', cell: 0 } },
  defaultExpression: 'smile',
}
async function pack() {
  const root = await mkdtemp(join(tmpdir(), 'stage-marks-'))
  roots.push(root)
  await mkdir(join(root, 'frontend', 'portraits', 'claude'), { recursive: true })
  await writeFile(join(root, 'frontend', 'portraits', 'claude.png'), png)
  await writeFile(join(root, 'frontend', 'portraits', 'claude', 'faces.png'), png)
  await writeFile(
    join(root, 'frontend', 'stage.json'),
    JSON.stringify({ characters: { 'character:claude': { face: [0.4, 0.1, 0.2, 0.1], ...claude } } }),
  )
  return { root, web: (await loadPackWeb(root))! }
}

it('writes one portrait marks into stage.json and keeps the expressions already there', async () => {
  const { root, web } = await pack()
  const marks: StageMarks = { framing: { top: 0.05, waist: 0.52 }, face: [0.42, 0.09, 0.16, 0.1] }
  const stage = await saveStageMarks(root, web, 'character:claude', marks)
  expect(stage.characters['character:claude']).toMatchObject({ ...marks, expressions: claude.expressions })
  // What was written is what the next load reads.
  expect((await loadPackWeb(root))?.stage).toEqual(stage)
})

it('refuses marks the stage file cannot take and leaves the file as it was', async () => {
  const { root, web } = await pack()
  const before = await readFile(join(root, 'frontend', 'stage.json'), 'utf8')
  // The sheet expression has no box of its own, so it needs the face box.
  await expect(saveStageMarks(root, web, 'character:claude', { framing: { top: 0.05, waist: 0.5 } })).rejects.toThrow(
    TypeError,
  )
  await expect(
    saveStageMarks(root, web, 'character:claude', { framing: { top: 0.6, waist: 0.5 }, face: [0.4, 0.1, 0.2, 0.1] }),
  ).rejects.toThrow('0 ≤ top < waist ≤ 1')
  expect(await readFile(join(root, 'frontend', 'stage.json'), 'utf8')).toBe(before)
})

it('saves through the creator API with the host token and serves the new marks afterwards', async () => {
  const { root, web } = await pack()
  const runtime = {
    saveStageMarks: (id: string, marks: StageMarks) => saveStageMarks(root, web, id, marks),
  } as unknown as HostRuntime
  const server = createHostServer(runtime, token, web)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const post = (body: unknown, headers: Record<string, string> = { 'x-playtest-token': token }) =>
    fetch(origin + '/api/creator-stage', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const marks = { characterId: 'character:claude', framing: { top: 0.04, waist: 0.5 }, face: [0.4, 0.1, 0.2, 0.1] }
  expect((await post(marks, {})).status).toBe(401)
  const bad = await post({ ...marks, face: [0.9, 0.1, 0.2, 0.1] })
  expect(bad.status).toBe(400)
  expect(((await bad.json()) as { error: string }).error).toContain('不超出图片')
  expect((await post(marks)).status).toBe(200)
  const read = (await (
    await fetch(origin + '/api/creator-stage', { headers: { 'x-playtest-token': token } })
  ).json()) as { editable: boolean; portraits: string[]; stage: { characters: Record<string, unknown> } }
  expect(read.editable).toBe(true)
  expect(read.portraits).toEqual(expect.arrayContaining(['portraits/claude.png', 'portraits/claude/faces.png']))
  expect(read.stage.characters['character:claude']).toMatchObject({ framing: marks.framing, face: marks.face })
})
