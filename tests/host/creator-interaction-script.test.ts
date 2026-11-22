import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runEditorCli } from '../../apps/host/src/editor/cli.ts'
import {
  assistInteractionScript,
  draftInteraction,
  interactionScript,
  saveInteractionScript,
} from '../../apps/host/src/editor/interaction-script.ts'
import { autonomyBook } from '../../apps/host/src/editor/autonomy.ts'
import { createWorld } from '../../apps/host/src/editor/workspace.ts'
import { exportProject } from '../../apps/host/src/editor/export.ts'
import { op, playerControls } from '../../apps/host/src/editor/trial-controls.ts'
import { LensSimulation } from '../../apps/host/src/simulation/simulation.ts'

let temp: string, root: string
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'creator-daily-'))
  root = join(temp, 'pack')
})
afterEach(() => rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
const create = () => createWorld(root, { title: '雨夜', player: '玩家', companion: '阿林', location: '门廊' })
const file = 'worldpack.source.json'
async function cli(command: string, body?: unknown) {
  const args = [command, root]
  if (body) {
    const request = join(temp, 'request.json')
    writeFileSync(request, JSON.stringify(body))
    args.push(request)
  }
  return runEditorCli(args)
}
it('opts in from an empty pack, exports just the authored action, and commits its effect through the player menu', async () => {
  await create()
  const original = readFileSync(join(root, file), 'utf8'),
    book = interactionScript(root)
  expect(book.base).toMatchObject({ enabled: false, source: null })
  const draft = (await cli('interaction-script-draft', {
    source: book.source,
    id: 'porch:listen',
    label: '倾听门外动静',
  })) as ReturnType<typeof draftInteraction>
  const source = draft.source
    .replace('resolve: () =>', 'resolve: ({actorId}) =>')
    .replace(
      'effects: []',
      `effects: [{kind:'event',event:{eventType:'observation.upsert',eventVersion:1,data:{value:{observerId:actorId,content:{resultDescription:'听到了三下轻响。'}}}}}]`,
    )
  expect(readFileSync(join(root, file), 'utf8')).toBe(original)
  expect(existsSync(join(root, book.base.path))).toBe(false)
  const body = { base: book.base, config: {}, source }
  const saved = (await cli('interaction-script-save', body)) as ReturnType<typeof interactionScript>
  expect(saved.operations.map(o => o.id)).toEqual(['porch:listen'])
  expect(await cli('interaction-script-save', body)).toEqual(saved)
  expect((await autonomyBook(root)).operations).toContainEqual({ id: 'porch:listen', name: '倾听门外动静' })
  const out = (await exportProject(root, join(temp, 'out'))).directory
  expect(interactionScript(out)).toEqual(saved)
  const sim = await LensSimulation.open(out)
  try {
    const controls = playerControls(sim, sim.playerId),
      actions = (await controls.view()).actions
    expect(actions.some(a => op(a) === 'contact:hold-hand')).toBe(false)
    const option = actions.find(a => op(a) === 'porch:listen')
    expect(option).toMatchObject({ label: '倾听门外动静', kind: 'interact' })
    await controls.perform(option, '没有作者交互')
    expect(
      sim
        .events()
        .some(e => e.eventType === 'observation.upsert' && JSON.stringify(e.data).includes('听到了三下轻响。')),
    ).toBe(true)
  } finally {
    await sim.close()
  }
  const empty = await saveInteractionScript(root, { base: saved.base, config: {}, source: book.source })
  expect(empty.operations).toEqual([])
  expect((await autonomyBook(root)).operations.map(o => o.id)).not.toContain('porch:listen')
}, 60000)
it('retains an imported entry path and config, rejects stale or invalid saves, and preserves the existing operations', async () => {
  cpSync('examples/world-packs/investigation', root, { recursive: true })
  const raw = JSON.parse(readFileSync(join(root, file), 'utf8'))
  const path = 'scripts/authored-rules.cjs',
    old = raw.scripts.gameplay.entry
  cpSync(join(root, old), join(root, path))
  raw.scripts.gameplay.entry = path
  raw.assetFiles = raw.assetFiles.map((p: string) => (p === old ? path : p))
  writeFileSync(join(root, file), JSON.stringify(raw))
  const book = interactionScript(root),
    base = book.base
  expect(base.path).toBe(path)
  expect(book.operations.map(o => o.id)).toContain('investigation:search')
  const draft = draftInteraction(root, { id: 'house:knock', label: '敲门', source: book.source })
  const assisted = await assistInteractionScript(
    root,
    { source: book.source, prompt: '增加敲门', config: base.config, provider: 'codex' },
    undefined,
    async () => draft.source,
  )
  expect(interactionScript(root).source).toBe(book.source)
  const invalid = assisted.source.replace('id: "house:knock"', "id: 'investigation:search'")
  expect(invalid).not.toEqual(assisted.source)
  await expect(saveInteractionScript(root, { base, config: base.config, source: invalid })).rejects.toThrow()
  expect(interactionScript(root).base).toEqual(base)
  for (const responders of [{ 'unknown:op': [] }, { 'house:knock': ['character:missing'] }]) {
    await expect(
      saveInteractionScript(root, { base, source: assisted.source, config: base.config, responders }),
    ).rejects.toThrow()
    expect(interactionScript(root).base).toEqual(base)
  }
  const responders = { 'house:knock': [], 'investigation:search': [book.characters[0]!.id] }
  const saved = await saveInteractionScript(root, { base, source: assisted.source, config: base.config, responders })
  expect(interactionScript(root).base.responders).toEqual(responders)
  expect(saved.base.config).toEqual(raw.scripts.gameplay.config)
  expect(saved.operations.map(o => o.id)).toEqual([...book.operations.map(o => o.id), 'house:knock'])
  await expect(saveInteractionScript(root, { base, source: book.source, config: base.config })).rejects.toThrow(
    '字段已更改',
  )
  expect(readFileSync(join(root, path), 'utf8')).toBe(assisted.source)
}, 60000)
