import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LauncherCore, localModel } from '../../desktop/launcher-core.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function service() {
  const root = await mkdtemp(join(tmpdir(), 'perspectra-launcher-'))
  roots.push(root)
  const core = new LauncherCore(resolve('.'), root)
  await core.initialize()
  return core
}
describe('real Launcher metadata and authority boundary', () => {
  it('loads real packs and persists independent instances and their model choices', async () => {
    const core = await service()
    await core.handle({ operation: 'load', path: resolve('examples/world-packs/prototype-g1') })
    const pack = core.snapshot().packs[0]!
    await core.handle({ operation: 'create', packageId: pack.id, name: 'first' })
    await core.handle({ operation: 'create', packageId: pack.id, name: 'second' })
    const [first, second] = core.snapshot().instances
    expect(first!.id).not.toBe(second!.id)
    await core.handle({ operation: 'configure', instanceId: first!.id, model: { model: 'my-model', endpoint: 'http://127.0.0.1:8046/v1/chat/completions' }, apiKey: 'must-not-persist' })
    const restored = new LauncherCore(resolve('.'), core.root)
    await restored.initialize()
    expect(restored.snapshot().instances[0]!.model.model).toBe('my-model')
    expect(restored.snapshot().instances[1]!.model.model).toBe('gemini-3.7-flash')
    const disk = await readFile(join(core.root, 'launcher.json'), 'utf8')
    expect(disk).not.toContain('must-not-persist')
    expect(disk).not.toContain('apiKey')
    expect(restored.snapshot().core.state).toBe('idle')
  })
  it('rejects invalid packs without altering the index', async () => {
    const core = await service()
    await expect(core.handle({ operation: 'load', path: core.root })).rejects.toThrow()
    expect(core.snapshot().packs).toHaveLength(0)
  })
  it('does not overwrite corrupt metadata or accept an instance path as an ID', async () => {
    const core = await service()
    const original = JSON.stringify({ packs: [], instances: [{ id: '../outside' }], defaults: {} })
    await writeFile(join(core.root, 'launcher.json'), original)
    await expect(new LauncherCore(resolve('.'), core.root).initialize()).rejects.toThrow('配置损坏')
    expect(await readFile(join(core.root, 'launcher.json'), 'utf8')).toBe(original)
    await expect(core.handle({ operation: 'start', instanceId: '../outside' })).rejects.toThrow('实例不存在')
  })
  it('does not expose world writes or share/fork operations', async () => {
    const core = await service()
    for (const operation of ['fork', 'export', 'writeEvent', 'runCommand']) {
      await expect(core.handle({ operation })).rejects.toThrow('不支持')
    }
    await expect(core.handle({ operation: 'open' })).rejects.toThrow('尚未启动')
  })
  it('rejects credential-bearing endpoints and non-chat URLs', () => {
    for (const endpoint of ['file:///tmp/x', 'http://key:secret@localhost/v1/chat/completions', 'http://localhost/v1/chat/completions?key=secret', 'http://localhost/v1']) {
      expect(() => localModel({ model: 'test', endpoint })).toThrow()
    }
  })
})

it('persists large text, restores an old index with defaults and rejects invalid preferences',async()=>{
 const core=await service(),model=core.snapshot().defaults
 await core.handle({operation:'settings',model,largeText:true,apiKey:'must-not-persist'})
 const restored=new LauncherCore(resolve('.'),core.root);await restored.initialize()
 expect(restored.snapshot().preferences.largeText).toBe(true)
 await restored.handle({operation:'settings',model})
 expect(restored.snapshot().preferences.largeText).toBe(true)
 await expect(restored.handle({operation:'settings',model,largeText:'true'})).rejects.toThrow('字体')
 expect(restored.snapshot().preferences.largeText).toBe(true)
 await restored.handle({operation:'settings',model,largeText:false})
 const again=new LauncherCore(resolve('.'),core.root);await again.initialize()
 expect(again.snapshot().preferences.largeText).toBe(false)
 const disk=JSON.parse(await readFile(join(core.root,'launcher.json'),'utf8'))
 expect(JSON.stringify(disk)).not.toContain('must-not-persist');expect(JSON.stringify(disk)).not.toContain('apiKey')
 delete disk.preferences;await writeFile(join(core.root,'launcher.json'),JSON.stringify(disk))
 const old=new LauncherCore(resolve('.'),core.root);await old.initialize()
 expect(old.snapshot().preferences.largeText).toBe(false)
})

 it('isolates corrupt story history without changing files or blocking healthy instances',async()=>{
  const core=await service();await core.handle({operation:'load',path:resolve('examples/world-packs/prototype-g1')})
  for(const name of ['broken','healthy'])await core.handle({operation:'create',packageId:core.snapshot().packs[0]!.id,name})
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
  await restored.handle({operation:'configure',instanceId:restored.snapshot().instances[1]!.id,model:{model:'healthy-model',endpoint:'http://127.0.0.1:8046/v1/chat/completions'}})
  expect(restored.snapshot().instances[1]!.model.model).toBe('healthy-model')
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
 const core=await service(),before=JSON.stringify(core.snapshot()),model={model:'fixture',endpoint:'http://127.0.0.1:8046/v1/chat/completions'}
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
 try{
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:'PRIVATE_RESPONSE'}}]}),{status:200}))
  expect(await core.handle({operation:'test-model',model,apiKey:'PRIVATE_KEY'})).toEqual({message:expect.stringContaining('已响应')})
  expect(fetch.mock.calls[0]![1].headers.authorization).toBe('Bearer PRIVATE_KEY')
  expect(JSON.parse(fetch.mock.calls[0]![1].body).messages).toEqual([{role:'user',content:expect.stringContaining('不包含游戏内容')}])
  for(const [status,expected] of [[401,'认证'],[429,'限流'],[500,'HTTP 500']] as const){fetch.mockResolvedValueOnce(new Response('PRIVATE_PROVIDER_ERROR',{status}));await expect(core.handle({operation:'test-model',model})).rejects.toThrow(expected)}
  fetch.mockResolvedValueOnce(new Response('{'));await expect(core.handle({operation:'test-model',model})).rejects.toThrow('JSON')
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({choices:[]})));await expect(core.handle({operation:'test-model',model})).rejects.toThrow('有效文本')
  fetch.mockRejectedValueOnce(new Error('PRIVATE_NETWORK'));await expect(core.handle({operation:'test-model',model})).rejects.toThrow('连接失败')
  expect(JSON.stringify(core.snapshot())).toBe(before)
 }finally{vi.unstubAllGlobals()}
})

it('persists native protocols and uses their headers and responses in connection tests', async () => {
 const core=await service()
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
 try {
  for(const protocol of ['anthropic','google'] as const) {
   const model={protocol,model:'selected',endpoint:protocol==='google'?'https://native.test/v1beta/models/old:generateContent':'https://native.test/v1/messages'}
   await core.handle({operation:'settings',model})
   const restored=new LauncherCore(resolve('.'),core.root);await restored.initialize()
   expect(restored.snapshot().defaults).toEqual(model)
   fetch.mockResolvedValueOnce(new Response(JSON.stringify(protocol==='anthropic'?{content:[{type:'text',text:'OK'}]}:{candidates:[{content:{parts:[{text:'OK'}]}}]})))
   await expect(core.handle({operation:'test-model',model,apiKey:'SESSION_ONLY'})).resolves.toEqual({message:expect.stringContaining('已响应')})
   const [url,init]=fetch.mock.calls.at(-1)!
   expect(String(url)).toContain(protocol==='google'?'/models/selected:generateContent':'/messages')
   if(protocol==='google')expect(JSON.parse(init.body)).not.toHaveProperty('systemInstruction')
   expect(init.headers).toMatchObject(protocol==='google'?{'x-goog-api-key':'SESSION_ONLY'}:{'x-api-key':'SESSION_ONLY'})
   expect(await readFile(join(core.root,'launcher.json'),'utf8')).not.toContain('SESSION_ONLY')
  }
  expect(()=>localModel({protocol:'invalid',model:'m',endpoint:'https://native.test/v1/messages'})).toThrow()
  expect(()=>localModel({protocol:'anthropic',model:'m',endpoint:'https://native.test/v1/chat/completions'})).toThrow()
 } finally {vi.unstubAllGlobals()}
})

it('persists appearance separately from models and rejects invalid theme without overwriting settings', async () => {
 const core = await service(), model = core.snapshot().defaults
 await core.handle({operation:'preferences',theme:'dark',largeText:true,apiKey:'must-not-persist'})
 await core.handle({operation:'settings',model})
 const restored = new LauncherCore(resolve('.'),core.root); await restored.initialize()
 expect(restored.snapshot().preferences).toEqual({theme:'dark',largeText:true})
 expect(restored.snapshot().defaults).toEqual(model)
 const before = await readFile(join(core.root,'launcher.json'),'utf8')
 expect(before).not.toContain('must-not-persist')
 await expect(core.handle({operation:'preferences',theme:'invalid',largeText:false})).rejects.toThrow('外观设置无效')
 expect(await readFile(join(core.root,'launcher.json'),'utf8')).toBe(before)
})

it('keeps package play settings separate, restores them and preserves model defaults and instances',async()=>{
 const core=await service()
 await core.handle({operation:'load',path:resolve('examples/world-packs/prototype-g1')})
 await core.handle({operation:'load',path:resolve('examples/world-packs/launcher-demo')})
 const [first,second]=core.snapshot().packs
 await core.handle({operation:'create',packageId:first!.id,name:'a'})
 await core.handle({operation:'create',packageId:first!.id,name:'b'})
 const before=core.snapshot()
 await core.handle({operation:'play-settings',packageId:first!.id,settings:{maximumWaves:5,playerInputCharacters:4000}})
 await core.handle({operation:'preferences',theme:'light',largeText:false,reading:{fontSize:22,lineHeight:2,autoFollow:false}})
 const restored=new LauncherCore(resolve('.'),core.root);await restored.initialize()
 expect(restored.snapshot().playSettings?.[first!.id]?.maximumWaves).toBe(5)
 expect(restored.snapshot().playSettings?.[second!.id]).toBeUndefined()
 expect(restored.snapshot().instances).toEqual(before.instances)
 expect(restored.snapshot().defaults).toEqual(before.defaults)
 expect(restored.snapshot().preferences.reading).toEqual({fontSize:22,lineHeight:2,autoFollow:false})
 await expect(core.handle({operation:'play-settings',packageId:first!.id,settings:{maximumWaves:0}})).rejects.toThrow()
 await expect(core.handle({operation:'play-settings',packageId:'foreign',settings:{}})).rejects.toThrow('载入')
 expect(core.snapshot().playSettings?.[first!.id]?.maximumWaves).toBe(5)
})
