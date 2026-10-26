import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ModelPresets, packPreset } from '../../desktop/model-presets.ts'
import { LauncherCore } from '../../desktop/launcher-core.ts'
import { rolePreset } from '../../packages/provider-chat/src/preset.ts'
import { createChatProvider } from '../../packages/provider-chat/src/provider.ts'
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'role-presets-'))
  roots.push(dir)
  return dir
}
it('rejects protocol, credentials and invalid generation settings', () => {
  for (const value of [
    { tools: [] },
    { apiKey: 'secret' },
    { endpoint: 'http://example' },
    { temperature: 3 },
    { maxOutputTokens: 1.5 },
    { stop: [''] },
    { prompt: 'x'.repeat(16001) },
  ])
    expect(() => rolePreset(value)).toThrow()
  expect(rolePreset({ temperature: 0, topP: 1, prompt: 'a\nb', stop: ['END'] })).toEqual({
    temperature: 0,
    topP: 1,
    prompt: 'a\nb',
    stop: ['END'],
  })
})
it('resolves recommendation, ignores it when selected and persists complete instance overrides', async () => {
  const dir = await root(),
    id = randomUUID(),
    settings = new ModelPresets(dir)
  await settings.load()
  expect(settings.effective(id, {})).toEqual({})
  await settings.save({ prompt: 'global', temperature: 0.3 }, {})
  expect(settings.effective(id, { prompt: 'pack', topP: 0.8 })).toEqual({ prompt: 'pack', temperature: 0.3, topP: 0.8 })
  await settings.save(settings.global, { [id]: { mode: 'global', override: {} } })
  expect(settings.effective(id, { temperature: 0.9 })).toEqual(settings.global)
  await settings.save(settings.global, { [id]: { mode: 'custom', override: { prompt: 'instance' } } })
  const restored = new ModelPresets(dir)
  await restored.load()
  expect(restored.effective(id, { temperature: 0.9 })).toEqual({ prompt: 'instance' })
  const bytes = '{"global":{"tools":[]},"instances":{}}'
  await writeFile(join(dir, 'preset-settings.json'), bytes)
  await expect(new ModelPresets(dir).load()).rejects.toThrow('未覆盖')
  expect(await readFile(join(dir, 'preset-settings.json'), 'utf8')).toBe(bytes)
})
it('loads optional package recommendations and Launcher selections without changing world hash', async () => {
  const dir = await root(),
    pack = join(dir, 'pack')
  await cp(resolve('examples/world-packs/prototype-g1'), pack, { recursive: true })
  expect(await packPreset(pack)).toEqual({})
  const core = new LauncherCore(resolve('.'), join(dir, 'launcher'))
  await core.initialize()
  await core.handle({ operation: 'load', path: pack })
  const hash = core.snapshot().packs[0]!.hash
  await writeFile(join(pack, 'model-preset.json'), JSON.stringify({ prompt: 'pack', temperature: 0.6 }))
  await core.handle({ operation: 'load', path: pack })
  expect(core.snapshot().packs[0]!.hash).toBe(hash)
  await core.handle({ operation: 'create', packageId: core.snapshot().packs[0]!.id, name: 'preset' })
  const id = core.snapshot().instances[0]!.id
  await core.handle({ operation: 'preset-global', preset: { topP: 0.9 } })
  await core.handle({
    operation: 'preset-instance',
    instanceId: id,
    choice: { mode: 'custom', override: { prompt: 'instance' } },
  })
  const restored = new LauncherCore(resolve('.'), join(dir, 'launcher'))
  await restored.initialize()
  expect(restored.snapshot().presets).toEqual(core.snapshot().presets)
  await expect(
    core.handle({ operation: 'preset-instance', instanceId: 'other', choice: { mode: 'auto', override: {} } }),
  ).rejects.toThrow('实例不存在')
  await writeFile(join(pack, 'model-preset.json'), '{"tools":[]}')
  await core.handle({ operation: 'preset-inspect' })
  expect(core.snapshot().packDetails['pack:prototype-g1']?.error).toContain('世界包')
  expect(core.snapshot().presets.global).toEqual({ topP: 0.9 })
  expect(core.snapshot().presets.instances[id]).toEqual({ mode: 'custom', override: { prompt: 'instance' } })
})
it('adds portrayal settings only to character calls and keeps Host messages, schema and intent limits', async () => {
  const sent: Record<string, unknown>[] = []
  const provider = createChatProvider({
    endpoint: new URL('http://example.test/chat'),
    model: 'role-model',
    preset: {
      prompt: '简短对白',
      temperature: 0.7,
      topP: 0.8,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      maxOutputTokens: 333,
      stop: ['END'],
    },
    fetch: (async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }))
    }) as typeof fetch,
  })
  const call = {
    messages: [
      { role: 'system' as const, content: 'Core contract' },
      { role: 'user' as const, content: 'private character context' },
    ],
    description: 'Host schema',
    schema: { type: 'object' as const, additionalProperties: false },
  }
  await provider.decide(call, new AbortController().signal)
  expect(sent[0]).toMatchObject({
    model: 'role-model',
    temperature: 0.7,
    top_p: 0.8,
    frequency_penalty: 0.1,
    presence_penalty: 0.2,
    max_tokens: 333,
    stop: ['END'],
    tool_choice: { type: 'function', function: { name: 'submit_actions' } },
  })
  expect(sent[0]!.messages).toEqual([
    call.messages[0],
    { role: 'system', content: '角色表现预设：简短对白' },
    call.messages[1],
  ])
  expect(sent[0]!.tools).toEqual([
    { type: 'function', function: { name: 'submit_actions', description: call.description, parameters: call.schema } },
  ])
  await provider.dispatch(
    { contract: 'intent', sourceText: 'hello', responseSchema: { type: 'object' } },
    { modelId: 'intent-model', timeoutMs: 1000, maxOutputTokens: 64 },
    new AbortController().signal,
  )
  expect(sent[1]).toMatchObject({ model: 'intent-model', temperature: 0.3, max_tokens: 64 })
  for (const key of ['top_p', 'frequency_penalty', 'presence_penalty', 'stop']) expect(sent[1]).not.toHaveProperty(key)
  expect(JSON.stringify(sent[1]!.messages)).not.toContain('简短对白')
})

it('uses character over group over instance and keeps a second instance independent', async () => {
  const dir = await root(),
    first = randomUUID(),
    second = randomUUID(),
    group = randomUUID()
  const settings = new ModelPresets(dir)
  await settings.save(
    { prompt: 'global' },
    {
      [first]: {
        mode: 'custom',
        override: { prompt: 'instance', temperature: 0.3 },
        groups: { [group]: { name: '同组', preset: { prompt: 'group', temperature: 0.5 } } },
        memberships: { 'character:companion': group, 'character:friend': group },
        characters: { 'character:companion': { prompt: 'character', topP: 0.9 } },
      },
      [second]: { mode: 'global', override: {} },
    },
  )
  const restored = new ModelPresets(dir)
  await restored.load()
  expect(restored.effectiveCharacter(first, {}, 'character:companion')).toEqual({ prompt: 'character', topP: 0.9 })
  expect(restored.effectiveCharacter(first, {}, 'character:friend')).toEqual({ prompt: 'group', temperature: 0.5 })
  expect(restored.effectiveCharacter(first, {}, 'character:other')).toEqual({ prompt: 'instance', temperature: 0.3 })
  expect(restored.effectiveCharacter(second, {}, 'character:companion')).toEqual({ prompt: 'global' })
  const choice = restored.instances[first]!
  delete choice.characters!['character:companion']
  expect(restored.effectiveCharacter(first, {}, 'character:companion').prompt).toBe('group')
  choice.groups = {}
  choice.memberships = {}
  expect(restored.effectiveCharacter(first, {}, 'character:companion').prompt).toBe('instance')
})
it('checks group references and NPC IDs before saving any instance mappings', async () => {
  const core = new LauncherCore(resolve('.'), await root())
  await core.initialize()
  await core.handle({ operation: 'load', path: resolve('examples/world-packs/prototype-g1') })
  await core.handle({ operation: 'create', packageId: core.snapshot().packs[0]!.id, name: '角色配置' })
  const instanceId = core.snapshot().instances[0]!.id,
    group = randomUUID()
  const metadata = core.snapshot().presets.characters['pack:prototype-g1']!
  expect(metadata.map(c => c.id)).toEqual(['character:companion', 'character:friend'])
  expect(metadata.every(c => Object.keys(c).sort().join(',') === 'id,name')).toBe(true)
  const choice = {
    mode: 'auto',
    override: {},
    groups: { [group]: { name: '组', preset: { prompt: 'group' } } },
    memberships: { 'character:companion': group },
  }
  await core.handle({ operation: 'preset-instance', instanceId, choice })
  const bytes = await readFile(join(core.root, 'preset-settings.json'), 'utf8')
  for (const bad of [
    { ...choice, characters: { 'character:player': {} } },
    { ...choice, characters: { 'character:foreign': {} } },
    { ...choice, memberships: { 'character:foreign': group } },
    { ...choice, memberships: { 'character:companion': 'missing' } },
    { ...choice, groups: { [group]: { name: '组', preset: { tools: [] } } } },
    { ...choice, mode: ['auto'] },
  ])
    await expect(core.handle({ operation: 'preset-instance', instanceId, choice: bad })).rejects.toThrow()
  expect(await readFile(join(core.root, 'preset-settings.json'), 'utf8')).toBe(bytes)
})
it('routes each real Core character call to its selected preset without cross-character prompts', async () => {
  const calls: { actor: string; wire: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', (async (_url: unknown, init: RequestInit) => {
    const wire = JSON.parse(String(init.body)) as Record<string, unknown>
    const input = JSON.parse((wire.messages as { content: string }[]).at(-1)!.content) as {
      context: { character: { characterId: string } }
    }
    calls.push({ actor: input.context.character.characterId, wire })
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ decision: 'abstain' }) } }))
  }) as typeof fetch)
  const group = randomUUID(),
    dir = await root()
  const runtime = await WorldHostRuntime.create({
    packPath: resolve('examples/world-packs/prototype-g1'),
    dataDirectory: join(dir, 'world'),
    provider: 'ollama',
    model: 'fixture',
    preset: { prompt: 'instance only', temperature: 0.2 },
    presetMapping: {
      groups: { [group]: { name: '组', preset: { prompt: 'group only', temperature: 0.5 } } },
      memberships: { 'character:companion': group, 'character:friend': group },
      characters: { 'character:companion': { prompt: 'companion only', temperature: 0.8 } },
    },
  })
  try {
    await runtime.submit('你好，可以介绍这里吗？')
    expect(calls.map(call => call.actor).sort()).toEqual(['character:companion', 'character:friend'])
    const first = calls.find(call => call.actor === 'character:companion')
    const second = calls.find(call => call.actor === 'character:friend')
    expect(JSON.stringify(first!.wire.messages)).toContain('companion only')
    expect(JSON.stringify(first!.wire.messages)).not.toContain('group only')
    expect(JSON.stringify(second!.wire.messages)).toContain('group only')
    expect(JSON.stringify(second!.wire.messages)).not.toContain('companion only')
    expect(JSON.stringify(calls)).not.toContain('instance only')
    expect(first!.wire.options).toMatchObject({ temperature: 0.8 })
    expect(second!.wire.options).toMatchObject({ temperature: 0.5 })
  } finally {
    await runtime.close()
  }
  await expect(
    WorldHostRuntime.create({
      packPath: resolve('examples/world-packs/prototype-g1'),
      dataDirectory: join(dir, 'foreign'),
      provider: 'ollama',
      presetMapping: { characters: { 'character:foreign': { prompt: 'not allowed' } } },
    }),
  ).rejects.toThrow('此包之外')
})
it("routes each character's decision call to its own model and endpoint", async () => {
  const calls: { url: string; model: unknown; key: string | null; actor: string }[] = []
  vi.stubGlobal('fetch', (async (url: unknown, init: RequestInit) => {
    const wire = JSON.parse(String(init.body)) as {
      model?: unknown
      messages: { content: unknown }[]
      tools: { input_schema?: { oneOf?: unknown; properties?: { decision?: { enum?: string[] } } } }[]
    }
    const headers = new Headers(init.headers),
      anthropic = String(url).includes('/v1/messages')
    const input = JSON.parse(String(wire.messages.at(-1)!.content)) as {
      context: { character: { characterId: string } }
    }
    calls.push({
      url: String(url),
      model: wire.model,
      key: headers.get('authorization') ?? headers.get('x-api-key'),
      actor: input.context.character.characterId,
    })
    // The gateway keeps only the first root oneOf branch (abstain). A flat
    // decision enum must preserve publish for an Anthropic character override.
    const canPublish = anthropic && wire.tools[0]?.input_schema?.properties?.decision?.enum?.includes('publish')
    const answer = canPublish
      ? { decision: 'publish', segments: [{ type: 'speech', text: '我也想回应。' }] }
      : { decision: 'abstain' }
    return new Response(
      JSON.stringify(
        anthropic
          ? { content: [{ type: 'tool_use', name: 'submit_actions', input: answer }] }
          : {
              choices: [
                {
                  message: {
                    tool_calls: [{ function: { name: 'submit_actions', arguments: JSON.stringify(answer) } }],
                  },
                },
              ],
            },
      ),
    )
  }) as typeof fetch)
  const dir = await root()
  const other = {
    protocol: 'anthropic' as const,
    endpoint: 'https://other.test/v1/messages',
    model: 'strong',
    apiKey: 'K2',
  }
  const runtime = await WorldHostRuntime.create({
    packPath: resolve('examples/world-packs/prototype-g1'),
    dataDirectory: join(dir, 'world'),
    provider: 'local',
    model: 'base',
    utilityEndpoint: 'http://default.test/v1/chat/completions',
    apiKey: 'K1',
    roleModels: { characters: { 'character:companion': { decision: other, memory: other } } },
  })
  try {
    const result = await runtime.submit('你好，可以介绍这里吗？')
    expect(result.transcript.some(line => line.text.includes('我也想回应。'))).toBe(true)
    const companion = calls.filter(call => call.actor === 'character:companion'),
      friend = calls.filter(call => call.actor === 'character:friend')
    expect(companion.length).toBeGreaterThan(0)
    expect(friend.length).toBeGreaterThan(0)
    for (const call of companion) expect(call).toMatchObject({ url: other.endpoint, model: 'strong', key: 'K2' })
    for (const call of friend)
      expect(call).toMatchObject({ url: 'http://default.test/v1/chat/completions', model: 'base', key: 'Bearer K1' })
    expect(JSON.stringify(friend)).not.toContain('K2')
  } finally {
    await runtime.close()
  }
  await expect(
    WorldHostRuntime.create({
      packPath: resolve('examples/world-packs/prototype-g1'),
      dataDirectory: join(dir, 'foreign'),
      provider: 'local',
      roleModels: { characters: { 'character:foreign': { decision: other, memory: other } } },
    }),
  ).rejects.toThrow('此包之外')
})
it('offers package role presets and assigns them to one instance without touching other mappings', async () => {
  const dir = await root(),
    pack = join(dir, 'pack')
  await cp(resolve('examples/world-packs/model-girls-sweet-days'), pack, { recursive: true })
  await rm(join(pack, 'role-presets.json'))
  const core = new LauncherCore(resolve('.'), join(dir, 'launcher'))
  await core.initialize()
  await core.handle({ operation: 'load', path: pack })
  const packId = core.snapshot().packs[0]!.id,
    hash = core.snapshot().packs[0]!.hash
  expect(core.snapshot().presets.bundled?.[packId]).toBeUndefined()
  await core.handle({ operation: 'create', packageId: packId, name: '第一次游玩' })
  const instanceId = core.snapshot().instances[0]!.id
  await expect(core.handle({ operation: 'preset-apply-bundle', instanceId })).rejects.toThrow('没有随包角色预设')

  // An existing mapping: Claude has its own preset, DeepSeek sits in a same-named group, GPT is untouched.
  const groupId = randomUUID()
  await core.handle({
    operation: 'preset-instance',
    instanceId,
    choice: {
      mode: 'auto',
      override: {},
      characters: { 'character:claude': { prompt: 'old claude' } },
      groups: { [groupId]: { name: '日常组', preset: { prompt: 'old group' } } },
      memberships: { 'character:deepseek': groupId },
    },
  })
  await writeFile(
    join(pack, 'role-presets.json'),
    JSON.stringify({
      characters: { 'character:gpt': { prompt: 'gpt' }, 'character:claude': { prompt: 'claude' } },
      groups: [{ name: '日常组', preset: { prompt: 'group' }, members: ['character:deepseek'] }],
    }),
  )
  // Loading the same package again: the file is Launcher metadata and leaves the world hash alone.
  await core.handle({ operation: 'load', path: pack })
  expect(core.snapshot().packs[0]!.hash).toBe(hash)
  expect(Object.keys(core.snapshot().presets.bundled![packId]!.characters)).toEqual([
    'character:gpt',
    'character:claude',
  ])

  for (let round = 0; round < 2; round++)
    await core.handle({ operation: 'preset-apply-bundle', instanceId, library: round === 0 })
  const choice = core.snapshot().presets.instances[instanceId]!
  expect(choice).toEqual({
    mode: 'auto',
    override: {},
    characters: { 'character:gpt': { prompt: 'gpt' }, 'character:claude': { prompt: 'claude' } },
    groups: { [groupId]: { name: '日常组', preset: { prompt: 'group' } } },
    memberships: { 'character:deepseek': groupId },
  })
  // Only the first round asked for library copies.
  const title = core.snapshot().packs[0]!.title
  expect(core.snapshot().presets.library.map(entry => entry.name)).toEqual([
    title + ' · GPT 专属',
    title + ' · Claude 专属',
    title + ' · 日常组',
  ])
  const restored = new LauncherCore(resolve('.'), join(dir, 'launcher'))
  await restored.initialize()
  expect(restored.snapshot().presets.instances[instanceId]).toEqual(choice)
  expect(restored.snapshot().presets.bundled?.[packId]).toEqual(core.snapshot().presets.bundled?.[packId])
})
it.each([
  ['a character outside the package', { characters: { 'character:foreign': {} } }, '此包之外'],
  [
    'a character in two groups',
    {
      groups: [
        { name: 'A', preset: {}, members: ['character:gpt'] },
        { name: 'B', preset: {}, members: ['character:gpt'] },
      ],
    },
    '无效',
  ],
  ['an unknown field', { characters: {}, instance: {} }, '无效'],
  ['an empty file', {}, '无效'],
])('rejects role presets naming %s before the package enters the index', async (_label, value, message) => {
  const dir = await root(),
    pack = join(dir, 'pack')
  await cp(resolve('examples/world-packs/model-girls-sweet-days'), pack, { recursive: true })
  await writeFile(join(pack, 'role-presets.json'), JSON.stringify(value))
  const core = new LauncherCore(resolve('.'), join(dir, 'launcher'))
  await core.initialize()
  await expect(core.handle({ operation: 'load', path: pack })).rejects.toThrow(message)
  expect(core.snapshot().packs).toHaveLength(0)
  expect(core.snapshot().presets.bundled ?? {}).toEqual({})
})
