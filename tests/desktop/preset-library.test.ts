import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { LauncherCore } from '../../desktop/launcher-core.ts'
import { ModelPresets } from '../../desktop/model-presets.ts'
import { importPresets, exportPresets, PRESET_FORMAT, PRESET_SCHEMA_VERSION } from '../../packages/provider-chat/src/preset-library.ts'
const roots:string[]=[]
async function root(){const path=await mkdtemp(join(tmpdir(),'preset-library-'));roots.push(path);return path}
afterEach(async()=>{for(const path of roots.splice(0))await rm(path,{recursive:true,force:true})})
const natural={name:'自然对白',preset:{prompt:'简短对白',temperature:0.4}}
it('round trips native named/single/library JSON and rejects unsupported authority fields',()=>{
 expect(JSON.parse(exportPresets([natural],true))).toEqual({format:PRESET_FORMAT,schemaVersion:PRESET_SCHEMA_VERSION,...natural})
 expect(JSON.parse(exportPresets([natural]))).toEqual({format:PRESET_FORMAT,schemaVersion:PRESET_SCHEMA_VERSION,presets:[natural]})
 expect(importPresets(exportPresets([natural],true))).toEqual([natural])
 expect(importPresets(JSON.stringify(natural))).toEqual([natural])
 expect(importPresets(JSON.stringify([natural]))).toEqual([natural])
 expect(importPresets(exportPresets([natural,{name:'白描',preset:{}}]))).toEqual([natural,{name:'白描',preset:{}}])
 expect(importPresets('{"prompt":"测试"}','文件名称')).toEqual([{name:'文件名称',preset:{prompt:'测试'}}])
 for(const value of ['[]','bad','{"name":"","preset":{}}','{"name":"测试","preset":{"apiKey":"secret"}}','{"name":"测试","preset":{},"characters":{}}','{"prompts":[]}'])expect(()=>importPresets(value)).toThrow()
})
it('rejects incomplete, foreign, unsupported and ambiguous exchange envelopes',()=>{
 const valid={format:PRESET_FORMAT,schemaVersion:1,...natural}
 for(const schemaVersion of [undefined,0,2,'1',null,true])expect(()=>importPresets(JSON.stringify({...valid,schemaVersion}))).toThrow('schemaVersion')
 for(const format of [undefined,'tavern-preset',1])expect(()=>importPresets(JSON.stringify({...valid,format}))).toThrow('format')
 for(const bad of [{format:PRESET_FORMAT,schemaVersion:1},{...valid,presets:[natural]},{format:PRESET_FORMAT,schemaVersion:1,presets:[]},{format:PRESET_FORMAT,schemaVersion:1,presets:natural},{...valid,apiKey:'secret'},{...valid,preset:{tools:[]}}])expect(()=>importPresets(JSON.stringify(bad))).toThrow()
})
it('persists names with collision copies and keeps applied instances independent from updates and deletion',async()=>{
 const path=await root(),core=new LauncherCore(resolve('.'),path);await core.initialize()
 await core.handle({operation:'load',path:resolve('examples/world-packs/prototype-g1')})
 await core.handle({operation:'create',packageId:core.snapshot().packs[0]!.id,name:'预设库'})
 const instanceId=core.snapshot().instances[0]!.id
 await core.handle({operation:'preset-library-add',entry:natural})
 const entry=core.snapshot().presets.library[0]!
 await core.handle({operation:'preset-save',instanceId,global:{topP:0.9},choice:{mode:'custom',override:entry.preset}})
 await core.handle({operation:'preset-library-import',text:exportPresets([natural,natural])})
 expect(core.snapshot().presets.library.map(e=>e.name)).toEqual(['自然对白','自然对白 (2)','自然对白 (3)'])
 await core.handle({operation:'preset-library-update',id:entry.id,entry:{name:'新名称',preset:{prompt:'另一种表达'}}})
 expect(core.snapshot().presets.instances[instanceId]!.override).toEqual(natural.preset)
 await core.handle({operation:'preset-library-remove',id:entry.id})
 expect(core.snapshot().presets.instances[instanceId]!.override).toEqual(natural.preset)
 const restored=new LauncherCore(resolve('.'),path);await restored.initialize()
 expect(restored.snapshot().presets).toEqual(core.snapshot().presets)
 const target=join(path,'export.json')
 await restored.handle({operation:'preset-export-file',path:target,text:exportPresets(restored.snapshot().presets.library)})
 const exported=JSON.parse(await readFile(target,'utf8'))
 expect(exported).toMatchObject({format:PRESET_FORMAT,schemaVersion:1,presets:expect.any(Array)})
 const singleTarget=join(path,'single.json')
 await restored.handle({operation:'preset-export-file',path:singleTarget,text:exportPresets([natural],true)})
 expect(JSON.parse(await readFile(singleTarget,'utf8'))).toEqual({format:PRESET_FORMAT,schemaVersion:1,...natural})
 const oneItemLibrary=join(path,'one-item-library.json')
 await restored.handle({operation:'preset-export-file',path:oneItemLibrary,text:exportPresets([natural])})
 expect(JSON.parse(await readFile(oneItemLibrary,'utf8')).presets).toEqual([natural])
 expect(importPresets(await readFile(target,'utf8')).map(e=>e.name)).toEqual(['自然对白 (2)','自然对白 (3)'])
 expect(await readFile(target,'utf8')).not.toContain('"id"')
})
it('validates the entire import and batch save before writing any existing data',async()=>{
 const path=await root(),core=new LauncherCore(resolve('.'),path);await core.initialize()
 await core.handle({operation:'preset-library-add',entry:natural})
 const before=await readFile(join(path,'preset-library.json'),'utf8'),id=core.snapshot().presets.library[0]!.id
 await expect(core.handle({operation:'preset-library-import',text:JSON.stringify([natural,{name:'坏项',preset:{tools:[]}}])})).rejects.toThrow()
 await expect(core.handle({operation:'preset-library-import',text:JSON.stringify({format:PRESET_FORMAT,schemaVersion:2,presets:[natural]})})).rejects.toThrow('schemaVersion')
 expect(await readFile(join(path,'preset-library.json'),'utf8')).toBe(before)
 await expect(core.handle({operation:'preset-library-update',id,entry:{name:'坏项',preset:{endpoint:'secret'}}})).rejects.toThrow()
 await core.handle({operation:'load',path:resolve('examples/world-packs/prototype-g1')})
 await core.handle({operation:'create',packageId:core.snapshot().packs[0]!.id,name:'批量编辑'})
 const instanceId=core.snapshot().instances[0]!.id
 await core.handle({operation:'preset-save',instanceId,global:{prompt:'原全局'},choice:{mode:'custom',override:{prompt:'原实例'}}})
 const settings=await readFile(join(path,'preset-settings.json'),'utf8')
 await expect(core.handle({operation:'preset-save',instanceId,global:{prompt:'新全局'},choice:{mode:'custom',override:{prompt:'新实例'},characters:{'character:foreign':{}}}})).rejects.toThrow()
 expect(await readFile(join(path,'preset-settings.json'),'utf8')).toBe(settings)
})
it('does not overwrite a corrupt library on loading',async()=>{
 const path=await root(),bytes='[{"id":"bad","name":"坏项","preset":{}}]'
 await writeFile(join(path,'preset-library.json'),bytes)
 await expect(new ModelPresets(path).loadLibrary()).rejects.toThrow('未覆盖')
 expect(await readFile(join(path,'preset-library.json'),'utf8')).toBe(bytes)
})
