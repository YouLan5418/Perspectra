import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { knowledgeEquality, knowledgeWhen } from '../../packages/world-pack/src/editor-fields.ts'
import {
  knowledgeBook,
  saveKnowledge,
  assistKnowledge,
  type KnowledgeRow,
} from '../../apps/host/src/editor/knowledge.ts'
import { startEditorServer } from '../../apps/host/src/editor/server.ts'
import { playKnowledge } from '../../apps/host/src/editor/knowledge-play.ts'
import { saveRule } from '../../apps/host/src/editor/rules.ts'
import { exportProject } from '../../apps/host/src/editor/export.ts'
import { createWorld } from '../../apps/host/src/editor/workspace.ts'
import { runEditorCli } from '../../apps/host/src/editor/cli.ts'
import {
  knowledgeSchema,
  readKnowledgeCondition,
  type KnowledgeCondition,
} from '../../packages/world-pack/src/editor-knowledge.ts'
import {
  knowledgeFields,
  buildKnowledgeCondition,
  saveKnowledgeRequest,
} from '../../apps/host/src/editor/knowledge-fields.ts'
import { knowledgeReferences } from '../../apps/host/src/editor/knowledge.ts'
import { KnowledgeSelection } from '../../apps/host/src/official-pack-metadata.ts'
import { readProject, saveGraph } from '../../apps/host/src/editor/project.ts'
let temp: string, root: string
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'creator-knowledge-'))
  root = join(temp, 'pack')
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))
const variable = { key: 'light', label: '门廊灯', type: 'boolean', initial: true }
const row: KnowledgeRow = {
  documentId: 'document:spare-lamp',
  usage: 'world_context',
  audience: 'character_private',
  characterIds: ['character:companion'],
  text: '备用灯藏在蓝柜子的第二层。',
  delivery: { constant: false, keywords: ['备用灯'], priority: 10, when: knowledgeWhen('light', false) },
}
const read = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'))
const write = (dir: string, file: string, data: unknown) =>
  writeFileSync(join(dir, file), JSON.stringify(data, null, 2) + '\n')
async function setup() {
  await createWorld(root, { title: '门廊', player: '访客', companion: '阿林', location: '门廊' })
  const chars = read(root, 'characters.json'),
    scenes = read(root, 'scenes.json')
  chars.characters.push({ ...chars.characters[1], characterId: 'character:visitor', displayName: '小余' })
  scenes.scenes[0].participantIds.push('character:visitor')
  write(root, 'characters.json', chars)
  write(root, 'scenes.json', scenes)
  saveRule(root, { kind: 'variable', base: null, row: variable })
}
it('checks actual model requests at two fresh starts and distinguishes roles, conditions and keyword misses', async () => {
  await setup()
  saveKnowledge(root, { base: null, row })
  const play = (text: string) =>
    playKnowledge(root, { documentId: row.documentId, expected: row, variable: 'light', values: [true, false], text })
  const result = await play('请问备用灯在哪里？')
  expect(result.trials.map(t => t.value)).toEqual([true, false])
  const hits = (i: number, id: string) => result.trials[i]!.actors.find(a => a.id === id)!.requests.map(r => r.received)
  for (const [i, value] of [
    [0, false],
    [1, true],
  ] as const) {
    expect(hits(i, 'character:companion')).toContain(value)
    expect(hits(i, 'character:visitor')).toContain(false)
    expect(hits(i, 'character:visitor')).not.toContain(true)
  }
  expect(hits(0, 'character:companion')).not.toContain(true)
  const miss = await play('窗外的天气如何？')
  expect(miss.trials[1]!.actors.find(a => a.id === 'character:companion')!.requests).toEqual(
    expect.arrayContaining([{ received: false }]),
  )
  expect(miss.trials[1]!.actors.flatMap(a => a.requests).some(r => r.received)).toBe(false)
}, 90000)
it('shares candidates, assistant patch validation and stale-write protection with CLI', async () => {
  await setup()
  expect(await runEditorCli(['knowledge-candidates', root])).toMatchObject({
    variables: [expect.objectContaining({ key: 'light' })],
  })
  write(temp, 'edit.json', { base: null, row })
  await runEditorCli(['knowledge-save', root, join(temp, 'edit.json')])
  const initial = knowledgeBook(root),
    save = (next: KnowledgeRow) => saveKnowledge(root, { base: row, row: next })
  expect(() => save({ ...row, characterIds: ['character:missing'] })).toThrow()
  expect(() => save({ ...row, characterIds: [] })).toThrow()
  expect(() => save({ ...row, delivery: { ...row.delivery!, when: knowledgeWhen('missing', false) } })).toThrow()
  expect(() =>
    saveRule(root, { kind: 'variable', base: variable, row: { ...variable, type: 'number', initial: 0 } }),
  ).toThrow('知识条件')
  expect(() =>
    saveKnowledge(root, { operation: 'knowledge-budget', base: initial.maximumCharacters, maximumCharacters: 99 }),
  ).toThrow()
  expect(knowledgeBook(root)).toEqual(initial)
  const assisted = await assistKnowledge(
    root,
    { documentId: row.documentId, base: row, provider: 'dsh', prompt: '提高优先级' },
    undefined,
    async (provider, prompt) => {
      expect(provider).toBe('dsh')
      expect(prompt).toContain('character:visitor')
      return '{"delivery":{"priority":12}}'
    },
  )
  expect(() => save({ ...row, delivery: { ...row.delivery!, priority: 44 } })).toThrow('delivery.priority')
  expect(knowledgeBook(root).rows).toContainEqual({ ...row, delivery: { ...row.delivery, priority: 12 } })
  save({ ...row, text: '并发补充的正文' })
  saveKnowledge(root, assisted.undo!)
  expect(knowledgeBook(root).rows).toContainEqual({ ...row, text: '并发补充的正文' })
})
it('saves a native knowledge condition through the browser endpoint when base and proposal exceed one MiB together', async () => {
  cpSync('examples/world-packs/status-market', root, { recursive: true })
  const source = read(root, 'knowledge.json')
  source.entries[0].when.description = 'x'.repeat(550000)
  write(root, 'knowledge.json', source)
  const base = knowledgeBook(root).rows[0]!,
    row = { ...base, text: '领取委托奖励。' }
  const body = JSON.stringify({ operation: 'knowledge-save', base, row })
  expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024)
  const server = await startEditorServer(root)
  try {
    const address = new URL(server.url)
    const token = new URLSearchParams(address.hash.slice(1)).get('token')!
    const result = await fetch(new URL('/api/editor', address), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-editor-token': token },
      body,
    })
    expect(result.status).toBe(200)
    expect(((await result.json()) as { rows: KnowledgeRow[] }).rows[0]).toEqual(row)
  } finally {
    await server.close()
  }
})
it('undoes only the assistant changes still needed at the moment of saving', async () => {
  await setup()
  saveKnowledge(root, { base: null, row })
  const shared = { ...row, text: '共同新正文' }
  const edit = await assistKnowledge(
    root,
    { provider: 'codex', prompt: '补充正文和优先级', documentId: row.documentId, base: row },
    undefined,
    async () => {
      saveKnowledge(root, { base: row, row: shared })
      return JSON.stringify({ text: shared.text, delivery: { priority: 12 } })
    },
  )
  saveKnowledge(root, edit.undo!)
  expect(knowledgeBook(root).rows).toContainEqual(shared)
})
it('preserves native complex conditions and unrelated source files through export and re-opening', async () => {
  cpSync('examples/world-packs/status-market', root, { recursive: true })
  const file = read(root, 'documents.json')
  file.documents.push({
    ...file.documents[0],
    documentId: 'document:author-draft',
    usage: 'author_note',
    audience: 'author_only',
  })
  write(root, 'documents.json', file)
  const originalBody = readFileSync(join(root, 'task-reward.md'))
  const initial = knowledgeBook(root),
    entry = initial.rows.find(r => r.documentId === 'document:task-reward')!
  expect(knowledgeEquality(entry.delivery?.when)).toBeUndefined()
  expect(entry.delivery?.when).toHaveProperty('properties.self')
  const next = { ...entry, text: entry.text + '\n追加线索。' }
  saveKnowledge(root, { base: entry, row: next })
  const dest = (await exportProject(root, join(temp, 'export'))).directory
  expect(readFileSync(join(dest, 'knowledge.json'))).toEqual(readFileSync(join(root, 'knowledge.json')))
  expect(readFileSync(join(dest, 'characters.json'))).toEqual(readFileSync(join(root, 'characters.json')))
  expect(knowledgeBook(dest).rows).toContainEqual(next)
  expect(knowledgeBook(dest).rows.some(r => r.documentId === 'document:author-draft')).toBe(false)
  expect(readFileSync(join(dest, 'task-reward.md'))).toEqual(originalBody)
  const exported = read(dest, 'documents.json').documents
  expect(exported[0].contentRef).not.toBe('task-reward.md')
  expect(exported[1]).toEqual(file.documents[1])
  expect(knowledgeBook(dest).maximumCharacters).toBe(initial.maximumCharacters)
}, 30000)

it('delivers grouped reader, location and visible scene conditions through real Host requests', async () => {
  await setup()
  const group: KnowledgeCondition = {
    match: 'all',
    terms: [
      { path: ['public', 'light'], comparison: 'eq', value: false },
      { path: ['locationId'], comparison: 'eq', value: 'location:start' },
      { path: ['scene', 'people', null, 'characterId'], comparison: 'eq', value: 'character:visitor' },
    ],
  }
  await saveKnowledgeRequest(root, { row, base: null, condition: group })
  const current = knowledgeBook(root).rows[0]!
  expect(readKnowledgeCondition(current.delivery?.when)).toEqual(group)
  for (const [kind, id] of [
    ['location', 'location:start'],
    ['character', 'character:visitor'],
    ['world', 'light'],
  ]) {
    expect(knowledgeReferences(root, kind, id)).toMatchObject([{ id: row.documentId, field: 'when' }])
  }
  expect(() =>
    saveRule(root, { kind: 'variable', base: variable, row: { ...variable, type: 'number', initial: 1 } }),
  ).toThrow('知识条件')
  const { trials } = await playKnowledge(root, {
    documentId: row.documentId,
    text: '备用灯在哪里？',
    variable: 'light',
    values: [true, false],
  })
  expect(trials[0]!.actors.flatMap(a => a.requests).some(r => r.received)).toBe(false)
  expect(trials[1]!.actors.find(a => a.id === 'character:companion')!.requests).toContainEqual({ received: true })
  expect(trials[1]!.actors.find(a => a.id === 'character:visitor')!.requests).toContainEqual({ received: false })
  expect(trials[1]!.actors.find(a => a.id === 'character:visitor')!.requests.some(r => r.received)).toBe(false)
}, 60000)

it('reopens the market quest condition with its authored stages and tests only the reader’s known values', async () => {
  cpSync('examples/world-packs/status-market', root, { recursive: true })
  const script = join(root, 'scripts/status.js')
  const original = readFileSync(script, 'utf8')
  const enumOnly = original.replace("stage: { type: 'string', enum:", 'stage: { enum:')
  expect(enumOnly).not.toEqual(original)
  writeFileSync(script, enumOnly)
  const book = await knowledgeFields(root),
    path = ['self', 'quests', 'market', 'stage']
  expect(book.paths).toContainEqual(path)
  expect(
    book.fields
      .find(f => JSON.stringify(f.path) === JSON.stringify(['self', 'quests', '*', 'stage']))
      ?.choices?.map(o => o.value),
  ).toEqual(['active', 'done', 'claimed'])
  const base = knowledgeBook(root).rows[0]!,
    parsed = readKnowledgeCondition(base.delivery!.when)!
  expect(parsed).toEqual({ match: 'one', terms: [{ path, comparison: 'eq', value: 'done' }] })
  await expect(
    buildKnowledgeCondition(root, { ...parsed, terms: [{ path, comparison: 'eq', value: 'missing' }] }),
  ).rejects.toThrow()
  await expect(
    buildKnowledgeCondition(root, {
      ...parsed,
      terms: [{ path: ['characters', 'character:absent', 'quests'], comparison: 'known' }],
    }),
  ).rejects.toThrow()
  expect(readKnowledgeCondition({ ...base.delivery!.when, description: '自定义语义' })).toBeUndefined()
  expect(readKnowledgeCondition({ type: 'array', contains: { const: 1 } })).toBeUndefined()
  const condition: KnowledgeCondition = {
    match: 'any',
    terms: [
      { path, comparison: 'ne', value: 'active' },
      { path: ['self', 'money'], comparison: 'gte', value: 500 },
    ],
  }
  await saveKnowledgeRequest(root, { base, row: base, condition })
  const dest = (await exportProject(root, join(temp, 'out'))).directory
  expect(readKnowledgeCondition(knowledgeBook(dest).rows[0]!.delivery?.when)).toEqual(condition)
  const selector = KnowledgeSelection.parse(read(dest, 'knowledge.json'), {
    documents: [{ ...base, contentRef: 'quest.md' }],
    markdown: [{ path: 'quest.md', text: base.text }],
  })
  const received = (holderId: string, stage: string, money: number) =>
    selector.select({
      character: { characterId: 'character:companion' },
      knownStatus: [
        { key: 'quests', holderId, value: { market: { stage } } },
        { key: 'money', holderId, value: money },
      ],
    }).entries
  expect(received('character:visitor', 'claimed', 501)).toEqual([])
  expect(received('character:companion', 'active', 0)).toEqual([])
  expect(received('character:companion', 'active', 500)).toHaveLength(1)
  expect(received('character:companion', 'claimed', 0)).toHaveLength(1)
})

it('binds same-named activity variables to their own activity, with no internal candidates', async () => {
  await setup()
  for (const key of ['tea', 'cook'])
    saveGraph(root, null, {
      key,
      title: key,
      opening: '开始',
      choices: [],
      variables: [
        { key: 'ready', label: '已就绪', scope: 'shared', type: 'boolean', initial: false },
        { key: 'choice', label: '个人选择', scope: 'private', type: 'string', initial: '是', options: ['是', '否'] },
        { key: 'secret', label: '内部裁定', scope: 'internal', type: 'number', initial: 0 },
      ],
    })
  const fields = (await knowledgeFields(root)).fields
  expect(fields.some(f => f.path.includes('secret'))).toBe(false)
  expect(
    fields
      .filter(f => f.path.at(-1) === 'ready')
      .map(f => f.activity)
      .sort(),
  ).toEqual(['cook', 'tea'])
  const condition: KnowledgeCondition = {
    match: 'one',
    terms: [
      { path: ['activity', 'game', 'private', 'variables', 'choice'], activity: 'tea', comparison: 'eq', value: '是' },
    ],
  }
  const { when } = await buildKnowledgeCondition(root, condition)
  expect(readKnowledgeCondition(when)).toEqual(condition)
  expect(knowledgeSchema(condition)).toEqual(when)
  await saveKnowledgeRequest(root, { base: null, row, condition })
  expect(knowledgeReferences(root, 'activity', 'tea')).toHaveLength(1)
  expect(knowledgeReferences(root, 'activity', 'cook')).toEqual([])
  expect(knowledgeReferences(root, 'local', 'choice', 'tea')).toHaveLength(1)
  const tea = readProject(root).graphs.find(g => g.key === 'tea')!
  expect(() => saveGraph(root, tea, { ...tea, variables: tea.variables?.filter(v => v.key !== 'choice') })).toThrow(
    '知识条件',
  )
  const selector = KnowledgeSelection.parse(
    {
      maximumCharacters: 1000,
      entries: [{ documentId: row.documentId, keywords: [], constant: true, priority: 0, when }],
    },
    { documents: [{ ...row, contentRef: 'tea' }], markdown: [{ path: 'tea', text: row.text }] },
  )
  const received = (activityKey: string, choice: string) =>
    selector.select({
      character: { characterId: 'character:companion' },
      activity: { activityKey, game: { private: { variables: { choice } } } },
    }).entries
  expect(received('tea', '是')).toHaveLength(1)
  expect(received('cook', '是')).toEqual([])
  expect(received('tea', '否')).toEqual([])
})
