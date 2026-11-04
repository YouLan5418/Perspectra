import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { loadHostPlugins, type HostPlugins } from '../../desktop/host-plugins.ts'
import { composeWorldSeams } from '../../desktop/official-bundle.ts'

const roots: string[] = [],
  sessions: HostPlugins[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const session of sessions.splice(0)) await session.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function load(sources: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-composition-'))
  roots.push(root)
  const settings = sources.map((source, i) => {
    const path = join(root, `plugin-${i}.mjs`)
    writeFileSync(path, `export const hostApi='2.4';\n${source}`)
    return { id: `plugin-${i}`, path, enabled: true }
  })
  const session = await loadHostPlugins(settings)
  sessions.push(session)
  return session
}

it('activates an earlier consumer after a later plugin supplies its Cordis service', async () => {
  const session = await load([
    `export default { inject:['later'], apply(ctx) { ctx.effect(()=>ctx.scheduler.register({id:ctx.later.name,version:'1.0.0',open:async()=>({run:async()=>({})})})) } }`,
    `import {Service} from '@deepseek-ai/cordis'; export default class Later extends Service {constructor(ctx){super(ctx,'later');this.name='from-later'}}`,
  ])
  expect(session.skipped).toEqual([])
  expect(session.seams.scheduler.id).toBe('from-later')
})

it('reports a missing dependency rather than recording an unstarted plugin as installed', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const session = await load([`export default {inject:['absent'], apply(){throw new Error('must not run')}}`])
  expect(session.skipped).toEqual([{ id: 'plugin-0', reason: 'apply', detail: expect.stringContaining('absent') }])
  expect(session.installed[0]!.enabled).toBe(false)
  expect(session.seams.scheduler.id).toBe('official-scheduler')
})

it('diagnoses mutually waiting services without inventing a dependency ordering', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const session = await load([
    `import {Service} from '@deepseek-ai/cordis'; export default class A extends Service {static inject=['b'];constructor(ctx){super(ctx,'a')}}`,
    `import {Service} from '@deepseek-ai/cordis'; export default class B extends Service {static inject=['a'];constructor(ctx){super(ctx,'b')}}`,
  ])
  expect(session.skipped).toHaveLength(2)
  expect(session.skipped.every(entry => entry.detail?.includes('循环依赖'))).toBe(true)
  expect(session.installed.every(entry => !entry.enabled)).toBe(true)
})

it('registers official context defaults through the public registry and respects explicit omission', async () => {
  const session = await load([])
  expect(session.seams.decisions).toHaveLength(5)
  expect(composeWorldSeams({ ...session.seams, decisionOrder: [] }).decisions).toEqual([])
  expect(composeWorldSeams().memory.id).toBe('official-memory-none')
})

it('keeps settings priority when the first plugin registers after asynchronous setup', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const code = (id: string, delay: number) =>
    `export default async ctx => { await new Promise(done=>setTimeout(done,${delay})); ctx.effect(()=>ctx.scheduler.register({id:'${id}',version:'1.0.0',open:async()=>({})})) }`
  const session = await load([code('first', 20), code('second', 0)])
  expect(session.seams.scheduler.id).toBe('first')
  expect(session.skipped).toEqual([{ id: 'plugin-1', reason: 'apply' }])
})
