import { mkdtemp, readFile, readdir, writeFile, rm, mkdir, cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LauncherCore } from '../../desktop/launcher-core.ts'
import { modelConnection } from '../../desktop/model-connections.ts'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'
import { projectPlayerView } from '../../packages/frontend/src/player-view.ts'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdir: vi.fn(actual.mkdir) }
})

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function service() {
  const root = await mkdtemp(join(tmpdir(), 'perspectra-launcher-'))
  roots.push(root)
  const core = new LauncherCore(resolve('.'), root)
  await core.initialize()
  return core
}
const local = { id: '6f1c2a4e-1d0b-4c39-9a51-0d6c1b7e2f10', name: '本地', protocol: 'openai', endpoint: 'http://127.0.0.1:8046/v1/chat/completions' } as const
const deepseek = { id: '7a2d3b5f-2e1c-4d4a-8b62-1e7d2c8f3a21', name: 'DeepSeek', protocol: 'openai', endpoint: 'https://api.deepseek.com/chat/completions' } as const
async function withPack(core: LauncherCore, names: string[] = ['first']) {
  await core.handle({ operation: 'load', path: resolve('examples/world-packs/prototype-g1') })
  for (const name of names) await core.handle({ operation: 'create', packageId: core.snapshot().packs[0]!.id, name })
  return core.snapshot().instances
}
async function runningService(customFrontend = false) {
  const core = await service()
  await core.handle({ operation: 'connection-save', connection: local })
  await core.handle({ operation: 'load', path: resolve(customFrontend ? 'examples/world-packs/launcher-demo' : 'examples/world-packs/prototype-g1') })
  const packageId = core.snapshot().packs[0]!.id
  await core.handle({ operation: 'create', packageId, name: '运行设置测试', models: { decision: { connectionId: local.id, model: 'before' } } })
  const instanceId = core.snapshot().instances[0]!.id
  const runtime = join(core.root, 'fake-runtime')
  await mkdir(runtime)
  await writeFile(join(runtime, 'playtest.mjs'), String.raw`
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.env.PERSPECTRA_PRESET_ROOT
const log = value => appendFileSync(join(root, 'child.jsonl'), JSON.stringify(value) + '\n')
const presetPath = join(root, 'preset-settings.json')
const snapshot = { models: JSON.parse(process.env.PERSPECTRA_ROLE_MODELS), reading: process.env.PERSPECTRA_READING,
  settings: process.argv.at(-1), presets: existsSync(presetPath) ? JSON.parse(readFileSync(presetPath, 'utf8')) : null }
log({ type: 'started', snapshot })
process.on('message', message => {
  if (message.type === 'frontend-revoke') { log(message); process.send({ type: 'frontend-revoked' }) }
  if (message.type === 'shutdown') { log({ type: 'stopped', snapshot }); process.disconnect() }
})
process.send({ type: 'ready', port: 12345, token: 'a'.repeat(64), frontendMode: process.env.PERSPECTRA_FRONTEND_APPROVED_SHA256 ? 'trusted' : 'sandbox' })
`)
  vi.stubEnv('PERSPECTRA_RUNTIME_ROOT', runtime)
  vi.stubEnv('HCW_HINDSIGHT_PYTHON', process.execPath)
  return { core, instanceId, packageId, log: async () => (await readFile(join(core.root, 'child.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
}
describe('real Launcher metadata and authority boundary', () => {
  it('explains denied save directory creation without starting Core or changing metadata', async () => {
    const core = await service()
    await core.handle({ operation: 'load', path: resolve('examples/world-packs/prototype-g1') })
    await core.handle({ operation: 'create', packageId: core.snapshot().packs[0]!.id, name: 'permission test' })
    const instanceId = core.snapshot().instances[0]!.id
    await core.handle({ operation: 'connection-save', connection: deepseek })
    await core.handle({ operation: 'configure', instanceId, models: { decision: { connectionId: deepseek.id, model: 'deepseek-chat' } } })
    const before = await readFile(join(core.root, 'launcher.json'), 'utf8')
    vi.stubEnv('HCW_HINDSIGHT_PYTHON', process.execPath)
    try {
      for (const code of ['EPERM', 'EACCES']) {
        vi.mocked(mkdir).mockRejectedValueOnce(Object.assign(new Error('private path and diagnostic'), { code }))
        await expect(core.handle({ operation: 'start', instanceId })).rejects.toThrow('无法创建游戏存档目录（权限不足）')
        expect(core.snapshot().core.state).toBe('idle')
        expect(core.snapshot().instances[0]!.lastPlayedAt).toBeNull()
        expect(await readFile(join(core.root, 'launcher.json'), 'utf8')).toBe(before)
      }
    } finally { vi.unstubAllEnvs(); await core.stop() }
  })

  it('loads real packs and persists independent instances and their model choices', async () => {
    const core = await service()
    await core.handle({ operation: 'connection-save', connection: local })
    const [first, second] = await withPack(core, ['first', 'second'])
    expect(first!.id).not.toBe(second!.id)
    expect(second!.needsModel).toBe(true)
    await core.handle({ operation: 'configure', instanceId: first!.id, models: { decision: { connectionId: local.id, model: 'my-model' } }, apiKeys: { [local.id]: 'must-not-persist' } })
    const restored = new LauncherCore(resolve('.'), core.root)
    await restored.initialize()
    expect(restored.snapshot().instances[0]!.models?.decision.model).toBe('my-model')
    expect(restored.snapshot().instances[1]!.needsModel).toBe(true)
    expect(restored.snapshot().lastModels).toEqual({ decision: { connectionId: local.id, model: 'my-model' } })
    const disk = await readFile(join(core.root, 'launcher.json'), 'utf8')
    expect(disk).not.toContain('must-not-persist')
    expect(disk).not.toContain('apiKey')
    expect(restored.snapshot().core.state).toBe('idle')
  })
  it('gives new instances the last saved choice, or the one the launcher proposes', async () => {
    const core = await service()
    await core.handle({ operation: 'connection-save', connection: local })
    await core.handle({ operation: 'load', path: resolve('examples/world-packs/prototype-g1') })
    const packageId = core.snapshot().packs[0]!.id
    await core.handle({ operation: 'create', packageId, name: 'proposed', models: { decision: { connectionId: local.id, model: 'listed-first' } } })
    expect(core.snapshot().instances[0]!.models?.decision.model).toBe('listed-first')
    await core.handle({ operation: 'configure', instanceId: core.snapshot().instances[0]!.id, models: { decision: { connectionId: local.id, model: 'chosen' } } })
    await core.handle({ operation: 'create', packageId, name: 'remembered', models: { decision: { connectionId: local.id, model: 'ignored' } } })
    expect(core.snapshot().instances[1]!.models?.decision.model).toBe('chosen')
  })
  it('reads the pack description and an optional root cover only for display', async () => {
    const core = await service()
    const path = join(core.root, 'pack-with-cover')
    await cp(resolve('examples/world-packs/launcher-demo'), path, { recursive: true })
    await writeFile(join(path, 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await core.handle({ operation: 'load', path })
    const pack = core.snapshot().packs[0]!
    expect(core.snapshot().packDetails[pack.id]).toEqual({ description: expect.stringContaining('黄铜钥匙'), hasCover: true })
    expect(await core.handle({ operation: 'pack-cover', packageId: pack.id })).toEqual({ packageId: pack.id, dataUrl: 'data:image/png;base64,iVBORw==' })
    await rm(join(path, 'cover.png'))
    const restored = new LauncherCore(resolve('.'), core.root)
    await restored.initialize()
    expect(restored.snapshot().packDetails[pack.id]!.hasCover).toBe(false)
    expect(await restored.handle({ operation: 'pack-cover', packageId: pack.id })).toEqual({ packageId: pack.id, dataUrl: null })
  })
  it('rejects invalid packs without altering the index', async () => {
    const core = await service()
    await expect(core.handle({ operation: 'load', path: core.root })).rejects.toThrow()
    expect(core.snapshot().packs).toHaveLength(0)
  })
  it.each(['missing', 'source', 'preset'])('isolates a %s package on initialization and clears its stale display data', async failure => {
    const core = await service()
    const path = join(core.root, 'broken-pack')
    await cp(resolve('examples/world-packs/launcher-demo'), path, { recursive: true })
    await writeFile(join(path, 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await core.handle({ operation: 'load', path })
    const brokenId = core.snapshot().packs[0]!.id
    await core.handle({ operation: 'create', packageId: brokenId, name: '保留实例' })
    const instanceId = core.snapshot().instances[0]!.id
    // The broken package comes first, so loading must continue to the healthy one.
    await core.handle({ operation: 'load', path: resolve('examples/world-packs/prototype-g1') })
    const before = await readFile(join(core.root, 'launcher.json'), 'utf8')
    if (failure === 'missing') await rm(path, { recursive: true })
    else await writeFile(join(path, failure === 'source' ? 'worldpack.source.json' : 'model-preset.json'), '{broken')
    const restored = new LauncherCore(resolve('.'), core.root)
    await expect(restored.initialize()).resolves.toBeUndefined()
    // Also refresh the already populated object: cached characters/cover must disappear.
    await expect(core.handle({ operation: 'preset-inspect' })).resolves.toBeDefined()
    for (const launcher of [core, restored]) {
      const snapshot = launcher.snapshot()
      expect(snapshot.packs).toHaveLength(2)
      expect(snapshot.instances[0]!.id).toBe(instanceId)
      expect(snapshot.packDetails[brokenId]).toMatchObject({ hasCover: false, error: expect.stringContaining('世界包') })
      expect(snapshot.presets.characters[brokenId] ?? []).toEqual([])
      expect(snapshot.presets.recommended[brokenId]).toBeUndefined()
      expect(snapshot.presets.characters['pack:prototype-g1']!.length).toBeGreaterThan(0)
      expect(await launcher.handle({ operation: 'pack-cover', packageId: brokenId })).toMatchObject({ dataUrl: null })
      await expect(launcher.handle({ operation: 'start', instanceId })).rejects.toThrow('世界包')
    }
    expect(await readFile(join(core.root, 'launcher.json'), 'utf8')).toBe(before)
    await rm(path, { recursive: true, force: true })
    await cp(resolve('examples/world-packs/launcher-demo'), path, { recursive: true })
    await restored.handle({ operation: 'load', path })
    expect(restored.snapshot().packDetails[brokenId]).not.toHaveProperty('error')
    expect(restored.snapshot().presets.characters[brokenId]!.length).toBeGreaterThan(0)
    expect(restored.snapshot().instances[0]!.id).toBe(instanceId)
  })
  it('does not overwrite corrupt metadata or accept an instance path as an ID', async () => {
    const core = await service()
    const original = JSON.stringify({ packs: [], instances: [{ id: '../outside' }], connections: [] })
    await writeFile(join(core.root, 'launcher.json'), original)
    await expect(new LauncherCore(resolve('.'), core.root).initialize()).rejects.toThrow('配置损坏')
    expect(await readFile(join(core.root, 'launcher.json'), 'utf8')).toBe(original)
    await expect(core.handle({ operation: 'start', instanceId: '../outside' })).rejects.toThrow('实例不存在')
  })
  it('does not expose world writes or share/fork operations', async () => {
    const core = await service()
    for (const operation of ['fork', 'export', 'writeEvent', 'runCommand', 'story-save']) {
      await expect(core.handle({ operation })).rejects.toThrow('不支持')
    }
    await expect(core.handle({ operation: 'open' })).rejects.toThrow('尚未启动')
    await expect(core.handle({ operation: 'open-creator' })).rejects.toThrow('游戏尚未启动')
    for (const operation of ['creator-debug', 'creator-history', 'creator-records', 'request-inspector']) {
      await expect(core.handle({ operation, instanceId: 'missing' })).rejects.toThrow('不支持')
    }
  })
  it('opens the creator page on the active host with the host token', async () => {
    const { core, instanceId } = await runningService()
    try {
      await core.handle({ operation: 'start', instanceId })
      expect(await core.handle({ operation: 'open-creator' })).toEqual({ url: 'http://127.0.0.1:12345/creator/#token=' + 'a'.repeat(64) })
      expect(await core.handle({ operation: 'open' })).toEqual({ url: 'http://127.0.0.1:12345/#token=' + 'a'.repeat(64) })
    } finally { await core.stop(); vi.unstubAllEnvs() }
  })
  it('rejects credential-bearing endpoints and non-chat URLs', () => {
    for (const endpoint of ['file:///tmp/x', 'http://key:secret@localhost/v1/chat/completions', 'http://localhost/v1/chat/completions?key=secret', 'http://localhost/v1']) {
      expect(() => modelConnection({ ...local, endpoint })).toThrow()
    }
  })
})

describe('model connections in the launcher index', () => {
  it('settings writes while running apply on next start', async () => {
    const { core, instanceId, packageId, log } = await runningService()
    try {
      await core.handle({ operation: 'start', instanceId })
      const before = (await log())[0].snapshot
      await core.handle({ operation: 'settings', largeText: true })
      await core.handle({ operation: 'preset-global', preset: { prompt: '全局新预设' } })
      await core.handle({ operation: 'preset-save', instanceId, global: { prompt: '全局新预设' }, choice: { mode: 'global', override: {} } })
      await core.handle({ operation: 'preset-instance', instanceId, choice: { mode: 'custom', override: { prompt: '实例新预设' } } })
      await core.handle({ operation: 'play-settings', packageId, settings: { maximumWaves: 2 } })
      await core.handle({ operation: 'preferences', theme: 'light', largeText: true, reading: { fontSize: 19, lineHeight: 1.9, autoFollow: true } })
      await core.handle({ operation: 'connection-save', connection: { ...local, endpoint: 'http://127.0.0.1:8047/v1/chat/completions' } })
      await core.handle({ operation: 'connection-save', connection: deepseek })
      await core.handle({ operation: 'connection-remove', connectionId: deepseek.id })
      await core.handle({ operation: 'configure', instanceId, models: { decision: { connectionId: local.id, model: 'after' } } })
      expect(await log()).toHaveLength(1)
      await core.stop()
      expect((await log())[1]).toEqual({ type: 'stopped', snapshot: before })
      await core.handle({ operation: 'start', instanceId })
      const after = (await log())[2].snapshot
      expect(after.models.default.decision).toMatchObject({ model: 'after', endpoint: 'http://127.0.0.1:8047/v1/chat/completions' })
      expect(JSON.parse(after.settings).maximumWaves).toBe(2)
      expect(after.presets.instances[instanceId]).toMatchObject({ mode: 'custom', override: { prompt: '实例新预设' } })
      expect(after.reading).not.toBe(before.reading)
    } finally { await core.stop(); vi.unstubAllEnvs() }
  })
  it('still refuses risky operations while running', async () => {
    const { core, instanceId } = await runningService()
    try {
      await core.handle({ operation: 'start', instanceId })
      for (const operation of ['story-select', 'story-fork', 'story-import', 'frontend-grant', 'create', 'load', 'start']) {
        await expect(core.handle({ operation, instanceId })).rejects.toThrow('请先结束当前游戏。')
      }
    } finally { await core.stop(); vi.unstubAllEnvs() }
  })
  it('revoke still applies immediately', async () => {
    const { core, instanceId, log } = await runningService(true)
    try {
      await core.handle({ operation: 'frontend-inspect', instanceId })
      const expectedDigest = core.snapshot().frontends[instanceId]!.digest
      await core.handle({ operation: 'frontend-grant', instanceId, expectedDigest, confirmed: true })
      await core.handle({ operation: 'start', instanceId })
      expect(core.snapshot().core).toMatchObject({ state: 'running', frontendMode: 'trusted' })
      await core.handle({ operation: 'frontend-revoke', instanceId })
      expect(core.snapshot().core).toMatchObject({ state: 'running', frontendMode: 'sandbox' })
      expect(await log()).toContainEqual({ type: 'frontend-revoke' })
    } finally { await core.stop(); vi.unstubAllEnvs() }
  })
  it('migrates an old single-endpoint index once and keeps a backup of the original file', async () => {
    const core = await service()
    await withPack(core)
    const current = JSON.parse(await readFile(join(core.root, 'launcher.json'), 'utf8')) as Record<string, unknown>
    const instances = current.instances as Record<string, unknown>[]
    const old = { packs: current.packs, preferences: current.preferences, defaults: { model: 'gemini-3.7-flash', endpoint: local.endpoint },
      instances: instances.map(({ models: _models, ...instance }) => ({ ...instance, model: { model: 'old-model', endpoint: 'https://api.deepseek.com/chat/completions', thinkingLevel: 'medium' } })) }
    const text = JSON.stringify(old)
    await writeFile(join(core.root, 'launcher.json'), text)
    const restored = new LauncherCore(resolve('.'), core.root); await restored.initialize()
    const snapshot = restored.snapshot()
    expect(snapshot.connections.map(c => c.name)).toEqual(['127.0.0.1:8046', 'api.deepseek.com'])
    expect(snapshot.instances[0]!.models).toEqual({ decision: { connectionId: snapshot.connections[1]!.id, model: 'old-model', thinkingLevel: 'medium' } })
    expect(snapshot.lastModels?.decision.connectionId).toBe(snapshot.connections[0]!.id)
    const backups = (await readdir(core.root)).filter(name => /^launcher\.backup-.+\.json$/.test(name))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(core.root, backups[0]!), 'utf8')).toBe(text)
    const disk = await readFile(join(core.root, 'launcher.json'), 'utf8')
    expect(disk).not.toContain('"defaults"')
    expect(disk).not.toContain('"model":{')
  })
  it('marks instances whose connection was removed and refuses to start them', async () => {
    const core = await service()
    await core.handle({ operation: 'connection-save', connection: local })
    const [instance] = await withPack(core)
    await core.handle({ operation: 'configure', instanceId: instance!.id, models: { decision: { connectionId: local.id, model: 'm' } } })
    await core.handle({ operation: 'connection-remove', connectionId: local.id })
    expect(core.snapshot().instances[0]!.brokenConnection).toBe(true)
    await expect(core.handle({ operation: 'start', instanceId: instance!.id })).rejects.toThrow('连接已删除')
    const restored = new LauncherCore(resolve('.'), core.root); await restored.initialize()
    expect(restored.snapshot().instances[0]!.brokenConnection).toBe(true)
  })
  it('refuses to start an instance without a model', async () => {
    const core = await service()
    const [instance] = await withPack(core)
    await expect(core.handle({ operation: 'start', instanceId: instance!.id })).rejects.toThrow('请先在模型配置中选择模型')
  })
  it('rejects choices that reference unknown connections or characters outside the pack', async () => {
    const core = await service()
    await core.handle({ operation: 'connection-save', connection: local })
    const [instance] = await withPack(core)
    const before = await readFile(join(core.root, 'launcher.json'), 'utf8')
    await expect(core.handle({ operation: 'configure', instanceId: instance!.id, models: { decision: { connectionId: deepseek.id, model: 'm' } } })).rejects.toThrow('连接不存在')
    await expect(core.handle({ operation: 'configure', instanceId: instance!.id, models: { decision: { connectionId: local.id, model: 'm' }, characters: { 'character:foreign': { decision: { connectionId: local.id, model: 'x' } } } } })).rejects.toThrow('此包之外')
    expect(await readFile(join(core.root, 'launcher.json'), 'utf8')).toBe(before)
  })
  it('lists models with the session key and never stores or exposes it', async () => {
    const core = await service()
    await core.handle({ operation: 'connection-save', connection: local })
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    try {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }] })))
      expect(await core.handle({ operation: 'list-models', connectionId: local.id, apiKeys: { [local.id]: 'PRIVATE_KEY' } })).toEqual({ models: ['a', 'b'] })
      expect(String(fetch.mock.calls[0]![0])).toBe('http://127.0.0.1:8046/v1/models')
      expect(fetch.mock.calls[0]![1].headers.authorization).toBe('Bearer PRIVATE_KEY')
      await expect(core.handle({ operation: 'list-models', connectionId: deepseek.id })).rejects.toThrow('连接不存在')
      expect(JSON.stringify(core.snapshot())).not.toContain('PRIVATE_KEY')
      expect(await readFile(join(core.root, 'launcher.json'), 'utf8')).not.toContain('PRIVATE_KEY')
    } finally { vi.unstubAllGlobals() }
  })
})

it('persists large text and rejects invalid preferences',async()=>{
 const core=await service()
 await core.handle({operation:'settings',largeText:true,apiKey:'must-not-persist'})
 const restored=new LauncherCore(resolve('.'),core.root);await restored.initialize()
 expect(restored.snapshot().preferences.largeText).toBe(true)
 await restored.handle({operation:'settings'})
 expect(restored.snapshot().preferences.largeText).toBe(true)
 await expect(restored.handle({operation:'settings',largeText:'true'})).rejects.toThrow('字体')
 expect(restored.snapshot().preferences.largeText).toBe(true)
 await restored.handle({operation:'settings',largeText:false})
 const again=new LauncherCore(resolve('.'),core.root);await again.initialize()
 expect(again.snapshot().preferences.largeText).toBe(false)
 const disk=JSON.parse(await readFile(join(core.root,'launcher.json'),'utf8'))
 expect(JSON.stringify(disk)).not.toContain('must-not-persist');expect(JSON.stringify(disk)).not.toContain('apiKey')
 delete disk.preferences;await writeFile(join(core.root,'launcher.json'),JSON.stringify(disk))
 const old=new LauncherCore(resolve('.'),core.root);await old.initialize()
 expect(old.snapshot().preferences.largeText).toBe(false)
})

 it('isolates corrupt story history without changing files or blocking healthy instances',async()=>{
  const core=await service();await core.handle({operation:'connection-save',connection:local})
  await withPack(core,['broken','healthy'])
  const broken=core.snapshot().instances[0]!,nodeId='11111111-1111-4111-8111-111111111111'
  const directory=join(core.root,'instances',broken.id,'story-nodes',nodeId);await mkdir(directory,{recursive:true});await writeFile(join(directory,'node.json'),'{')
  const index=await readFile(join(core.root,'launcher.json'),'utf8')
  const restored=new LauncherCore(resolve('.'),core.root);await restored.initialize()
  expect(restored.snapshot().instances).toHaveLength(2)
  expect(restored.snapshot().instances[0]).toMatchObject({storyError:expect.stringContaining('损坏'),nodes:[]})
  expect(restored.snapshot().instances[1]!.storyError).toBeUndefined()
  await expect(restored.handle({operation:'story-fork',instanceId:broken.id,nodeId,name:'forbidden'})).rejects.toThrow()
  expect(await readFile(join(directory,'node.json'),'utf8')).toBe('{')
  expect(await readFile(join(core.root,'launcher.json'),'utf8')).toBe(index)
  await restored.handle({operation:'configure',instanceId:restored.snapshot().instances[1]!.id,models:{decision:{connectionId:local.id,model:'healthy-model'}}})
  expect(restored.snapshot().instances[1]!.models?.decision.model).toBe('healthy-model')
 })
 it('rejects invalid enabled macros atomically on save and import',async()=>{
  const core=await service();await core.handle({operation:'load',path:resolve('examples/world-packs/prototype-g1')});await core.handle({operation:'create',packageId:core.snapshot().packs[0]!.id,name:'macro'})
  const bad={nodes:[{id:'bad',name:'错误节点',enabled:true,role:'system',position:'beforeContext',content:'{{unknown}}'}]}
  const before=JSON.stringify(core.snapshot().presets)
  await expect(core.handle({operation:'preset-save',instanceId:core.snapshot().instances[0]!.id,global:{prompt:'must-not-save'},choice:{mode:'custom',override:bad}})).rejects.toThrow('错误节点')
  await expect(core.handle({operation:'preset-library-import',text:JSON.stringify([{name:'good',preset:{}},{name:'bad',preset:bad}])})).rejects.toThrow('unknown')
  expect(JSON.stringify(core.snapshot().presets)).toBe(before)
 })

it('keeps stored invalid macros editable without weakening save or import checks',async()=>{
 const core=await service(),bad={nodes:[{id:'old',name:'已有错误节点',enabled:true,role:'system',position:'beforeContext',content:'{{unknown}}'}]}
 await writeFile(join(core.root,'preset-settings.json'),JSON.stringify({global:bad,instances:{}}))
 await writeFile(join(core.root,'preset-library.json'),JSON.stringify([{id:'11111111-1111-4111-8111-111111111111',name:'已有错误预设',preset:bad}]))
 const settings=await readFile(join(core.root,'preset-settings.json'),'utf8'),library=await readFile(join(core.root,'preset-library.json'),'utf8')
 const restored=new LauncherCore(resolve('.'),core.root);await restored.initialize()
 expect(restored.snapshot().presets.global).toEqual(bad);expect(restored.snapshot().presets.library).toHaveLength(1)
 await expect(restored.handle({operation:'preset-global',preset:bad})).rejects.toThrow('已有错误节点')
 expect(await readFile(join(core.root,'preset-settings.json'),'utf8')).toBe(settings);expect(await readFile(join(core.root,'preset-library.json'),'utf8')).toBe(library)
 await restored.handle({operation:'preset-global',preset:{prompt:'已修正'}})
 expect(restored.snapshot().presets.global).toEqual({prompt:'已修正'})
})

it('tests model connectivity without persisting secrets or echoing provider content',async()=>{
 const core=await service();await core.handle({operation:'connection-save',connection:local})
 const before=JSON.stringify(core.snapshot()),request={operation:'test-model',connectionId:local.id,model:'fixture'}
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
 try{
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:'PRIVATE_RESPONSE'}}]}),{status:200}))
  expect(await core.handle({...request,apiKeys:{[local.id]:'PRIVATE_KEY'}})).toEqual({message:expect.stringContaining('已响应')})
  expect(fetch.mock.calls[0]![1].headers.authorization).toBe('Bearer PRIVATE_KEY')
  expect(JSON.parse(fetch.mock.calls[0]![1].body).messages).toEqual([{role:'user',content:expect.stringContaining('不包含游戏内容')}])
  for(const [status,expected] of [[401,'认证'],[429,'限流'],[500,'HTTP 500']] as const){fetch.mockResolvedValueOnce(new Response('PRIVATE_PROVIDER_ERROR',{status}));await expect(core.handle(request)).rejects.toThrow(expected)}
  fetch.mockResolvedValueOnce(new Response('{'));await expect(core.handle(request)).rejects.toThrow('JSON')
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({choices:[]})));await expect(core.handle(request)).rejects.toThrow('有效文本')
  fetch.mockRejectedValueOnce(new Error('PRIVATE_NETWORK'));await expect(core.handle(request)).rejects.toThrow('连接失败')
  expect(JSON.stringify(core.snapshot())).toBe(before)
 }finally{vi.unstubAllGlobals()}
})

it('persists native protocols and uses their headers and responses in connection tests', async () => {
 const core=await service()
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
 try {
  for(const protocol of ['anthropic','google'] as const) {
   const connection={...local,protocol,endpoint:protocol==='google'?'https://native.test/v1beta/models/old:generateContent':'https://native.test/v1/messages'}
   await core.handle({operation:'connection-save',connection})
   const restored=new LauncherCore(resolve('.'),core.root);await restored.initialize()
   expect(restored.snapshot().connections).toEqual([connection])
   fetch.mockResolvedValueOnce(new Response(JSON.stringify(protocol==='anthropic'?{content:[{type:'text',text:'OK'}]}:{candidates:[{content:{parts:[{text:'OK'}]}}]})))
   await expect(core.handle({operation:'test-model',connectionId:local.id,model:'selected',apiKeys:{[local.id]:'SESSION_ONLY'}})).resolves.toEqual({message:expect.stringContaining('已响应')})
   const [url,init]=fetch.mock.calls.at(-1)!
   expect(String(url)).toContain(protocol==='google'?'/models/selected:generateContent':'/messages')
   if(protocol==='google')expect(JSON.parse(init.body)).not.toHaveProperty('systemInstruction')
   expect(init.headers).toMatchObject(protocol==='google'?{'x-goog-api-key':'SESSION_ONLY'}:{'x-api-key':'SESSION_ONLY'})
   expect(await readFile(join(core.root,'launcher.json'),'utf8')).not.toContain('SESSION_ONLY')
  }
  await expect(core.handle({operation:'connection-save',connection:{...local,protocol:'invalid'}})).rejects.toThrow()
  await expect(core.handle({operation:'connection-save',connection:{...local,protocol:'anthropic'}})).rejects.toThrow()
 } finally {vi.unstubAllGlobals()}
})

it('persists appearance separately from models and rejects invalid theme without overwriting settings', async () => {
 const core = await service()
 await core.handle({operation:'connection-save',connection:local})
 await core.handle({operation:'preferences',theme:'dark',largeText:true,apiKey:'must-not-persist'})
 const restored = new LauncherCore(resolve('.'),core.root); await restored.initialize()
 expect(restored.snapshot().preferences).toEqual({theme:'dark',largeText:true})
 expect(restored.snapshot().connections).toEqual([local])
 const before = await readFile(join(core.root,'launcher.json'),'utf8')
 expect(before).not.toContain('must-not-persist')
 await expect(core.handle({operation:'preferences',theme:'invalid',largeText:false})).rejects.toThrow('外观设置无效')
 expect(await readFile(join(core.root,'launcher.json'),'utf8')).toBe(before)
})

it('persists the interface palette and rejects unknown palettes without overwriting settings', async () => {
 const core = await service()
 await core.handle({operation:'preferences',theme:'system',largeText:false,palette:'moon'})
 const restored = new LauncherCore(resolve('.'),core.root); await restored.initialize()
 expect(restored.snapshot().preferences).toEqual({theme:'system',largeText:false,palette:'moon'})
 const before = await readFile(join(core.root,'launcher.json'),'utf8')
 await expect(core.handle({operation:'preferences',theme:'system',largeText:false,palette:'neon'})).rejects.toThrow('主题色无效')
 expect(await readFile(join(core.root,'launcher.json'),'utf8')).toBe(before)
})

it('keeps package play settings separate, restores them and preserves model connections and instances',async()=>{
 const core=await service()
 await core.handle({operation:'connection-save',connection:local})
 await core.handle({operation:'load',path:resolve('examples/world-packs/prototype-g1')})
 await core.handle({operation:'load',path:resolve('examples/world-packs/launcher-demo')})
 const [first,second]=core.snapshot().packs
 await core.handle({operation:'create',packageId:first!.id,name:'a'})
 await core.handle({operation:'create',packageId:first!.id,name:'b'})
 const before=core.snapshot()
 await core.handle({operation:'play-settings',packageId:first!.id,settings:{maximumWaves:5,playerInputCharacters:4000,autonomyNpcCalls:5,autonomyReactionWaves:2}})
 await core.handle({operation:'preferences',theme:'light',largeText:false,reading:{fontSize:22,lineHeight:2,autoFollow:false}})
 const restored=new LauncherCore(resolve('.'),core.root);await restored.initialize()
 expect(restored.snapshot().playSettings?.[first!.id]?.maximumWaves).toBe(5)
 expect(restored.snapshot().playSettings?.[first!.id]).toMatchObject({autonomyNpcCalls:5,autonomyReactionWaves:2})
 expect(restored.snapshot().playSettings?.[second!.id]).toBeUndefined()
 expect(restored.snapshot().instances).toEqual(before.instances)
 expect(restored.snapshot().connections).toEqual(before.connections)
 expect(restored.snapshot().preferences.reading).toEqual({fontSize:22,lineHeight:2,autoFollow:false})
 await expect(core.handle({operation:'play-settings',packageId:first!.id,settings:{maximumWaves:0}})).rejects.toThrow()
 await expect(core.handle({operation:'play-settings',packageId:'foreign',settings:{}})).rejects.toThrow('载入')
 expect(core.snapshot().playSettings?.[first!.id]?.maximumWaves).toBe(5)
})

it('restores global audio preferences and rejects invalid updates without changing saved metadata',async()=>{
 const core=await service(),audio={volume:35,muted:true,voiceEnabled:true}
 await core.handle({operation:'preferences',theme:'dark',largeText:false,audio})
 // Existing appearance requests must not erase audio preferences.
 await core.handle({operation:'preferences',theme:'light',largeText:true})
 const restored=new LauncherCore(resolve('.'),core.root);await restored.initialize()
 expect(restored.snapshot().preferences.audio).toEqual(audio)
 const runtime=await FrozenWorldPlaytestRuntime.create({dataDirectory:join(core.root,'presentation-world'),
  packPath:resolve('examples/world-packs/prototype-g1'),provider:'local',model:'fixture',
  audio:restored.snapshot().preferences.audio!})
 try{expect(projectPlayerView(await runtime.state()).settings?.audio).toEqual(audio)}finally{await runtime.close()}
 const before=await readFile(join(core.root,'launcher.json'),'utf8')
 await expect(core.handle({operation:'preferences',theme:'dark',largeText:false,audio:{...audio,volume:-1}})).rejects.toThrow('音量')
 expect(await readFile(join(core.root,'launcher.json'),'utf8')).toBe(before)
 expect(core.snapshot().preferences.audio).toEqual(audio)
})

it('persists thinking strength per instance and rejects unsupported explicit choices', async()=>{
 const core=await service()
 await core.handle({operation:'connection-save',connection:deepseek})
 const google={id:'8b3e4c60-3f2d-4e5b-9c73-2f8e3d904b32',name:'Google',protocol:'google',endpoint:'https://local.test/v1beta/models/gemini-3.7-flash:generateContent'}
 await core.handle({operation:'connection-save',connection:google})
 const [instance]=await withPack(core,['thinking test'])
 await core.handle({operation:'configure',instanceId:instance!.id,models:{decision:{connectionId:deepseek.id,model:'deepseek-flash',thinkingLevel:'medium'}}})
 const restored=new LauncherCore(resolve('.'),core.root);await restored.initialize()
 expect(restored.snapshot().instances[0]!.models?.decision.thinkingLevel).toBe('medium')
 await expect(core.handle({operation:'configure',instanceId:instance!.id,models:{decision:{connectionId:deepseek.id,model:'m',thinkingLevel:'unknown'}}})).rejects.toThrow('思考强度')
 await expect(core.handle({operation:'configure',instanceId:instance!.id,models:{decision:{connectionId:google.id,model:'gemini-3.7-flash',thinkingLevel:'off'}}})).rejects.toThrow('不支持')
})
