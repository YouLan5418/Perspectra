import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LensStore } from '../../desktop/lens/store.ts'
import type { LensItem, LensView } from '../../desktop/lens/view.ts'

const item = (value: number, id = 'character:a'): LensItem => ({
  id,
  section: 'characters',
  title: `T-${id}`,
  fields: [{ key: 'n', label: 'N', value }],
  source: { kind: 'json', file: 'a.json', pointer: '/characters/0' },
})
const view = (...items: LensItem[]): LensView => ({ packId: 'p', packVersion: '1', title: 'P', items })

let pack: string
beforeEach(() => {
  pack = mkdtempSync(join(tmpdir(), 'lens-store-'))
  writeFileSync(join(pack, 'worldpack.source.json'), '{}')
})
afterEach(() => rmSync(pack, { recursive: true, force: true }))

it('seen round-trips', () => {
  const store = new LensStore(pack)
  store.markSeen(view(item(1)))
  expect(new LensStore(pack).seen()).toEqual(view(item(1)))
})

it('missing seen is null', () => {
  expect(new LensStore(pack).seen()).toBeNull()
})

it('corrupt seen snapshot fails with the file path', () => {
  mkdirSync(join(pack, '.perspectra-lens'))
  writeFileSync(join(pack, '.perspectra-lens', 'seen.json'), '{not json')
  expect(() => new LensStore(pack).seen()).toThrow(/seen\.json/)
})

it('seen snapshot of the wrong shape fails with the file path', () => {
  mkdirSync(join(pack, '.perspectra-lens'))
  writeFileSync(join(pack, '.perspectra-lens', 'seen.json'), '{"items":5}')
  expect(() => new LensStore(pack).seen()).toThrow(/seen\.json/)
})

it('corrupt requests file fails instead of reading as empty', () => {
  mkdirSync(join(pack, '.perspectra-lens'))
  writeFileSync(join(pack, '.perspectra-lens', 'requests.json'), 'oops')
  expect(() => new LensStore(pack).requests(view())).toThrow(/requests\.json/)
})

it('request becomes changed when the item changes', () => {
  const store = new LensStore(pack)
  const request = store.addRequest(item(1), '  想改成 2  ')
  expect(request.note).toBe('  想改成 2  ')
  expect(store.requests(view(item(1)))[0]).toMatchObject({ id: request.id, state: 'open' })
  expect(store.requests(view(item(2)))[0]!.state).toBe('changed')
})

it('request whose item disappeared is marked removed', () => {
  const store = new LensStore(pack)
  store.addRequest(item(1), 'x')
  expect(store.requests(view())[0]!.state).toBe('removed')
})

it('closed request stays closed', () => {
  const store = new LensStore(pack)
  const request = store.addRequest(item(1), 'x')
  store.closeRequest(request.id)
  expect(store.requests(view())[0]!.state).toBe('closed')
  expect(store.requests(view(item(9)))[0]!.state).toBe('closed')
})

it('rejects empty or oversized notes and unknown request ids', () => {
  const store = new LensStore(pack)
  expect(() => store.addRequest(item(1), '')).toThrow()
  expect(() => store.addRequest(item(1), 'x'.repeat(2001))).toThrow()
  expect(() => store.closeRequest('nope')).toThrow()
})

it('checkpoints save, list and load', () => {
  const store = new LensStore(pack)
  store.saveCheckpoint('v1', view(item(1)))
  expect(store.checkpoints().map(entry => entry.name)).toEqual(['v1'])
  expect(store.checkpoints()[0]!.savedAt).toMatch(/^\d{4}-/)
  expect(store.checkpoint('v1')).toEqual(view(item(1)))
})

it('checkpoint name cannot escape the directory', () => {
  const store = new LensStore(pack)
  for (const name of ['../x', '..', 'a/b', 'a\b', '', 'x'.repeat(41)])
    expect(() => store.saveCheckpoint(name, view())).toThrow()
  expect(() => store.checkpoint('../x')).toThrow()
})

it('lists scenario file names', () => {
  const dir = join(pack, '.perspectra-lens', 'scenarios')
  expect(new LensStore(pack).scenarios()).toEqual([])
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'b.json'), '{}')
  writeFileSync(join(dir, 'a.json'), '{}')
  writeFileSync(join(dir, 'note.txt'), '')
  expect(new LensStore(pack).scenarios()).toEqual(['a.json', 'b.json'])
})

it('store never writes outside .perspectra-lens', () => {
  const before = readdirSync(pack).filter(name => name !== '.perspectra-lens')
  const content = readFileSync(join(pack, 'worldpack.source.json'), 'utf8')
  const store = new LensStore(pack)
  store.markSeen(view(item(1)))
  store.saveCheckpoint('v1', view(item(1)))
  store.closeRequest(store.addRequest(item(1), 'x').id)
  expect(readdirSync(pack).filter(name => name !== '.perspectra-lens')).toEqual(before)
  expect(readFileSync(join(pack, 'worldpack.source.json'), 'utf8')).toBe(content)
  expect(readdirSync(join(pack, '.perspectra-lens')).some(name => name.includes('.tmp'))).toBe(false)
})
