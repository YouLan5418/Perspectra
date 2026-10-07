import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ModelPresets, packPreset } from '../../desktop/model-presets.ts'
import { LauncherCore } from '../../desktop/launcher-core.ts'
import { rolePreset } from '../../packages/provider-chat/src/preset.ts'
import { createChatProvider } from '../../packages/provider-chat/src/provider.ts'
const roots:string[]=[]
afterEach(async()=>{vi.unstubAllGlobals();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function root(){const dir=await mkdtemp(join(tmpdir(),'role-presets-'));roots.push(dir);return dir}
it('rejects protocol, credentials and invalid generation settings',()=>{
 for(const value of [{tools:[]},{apiKey:'secret'},{endpoint:'http://example'},{temperature:3},{maxOutputTokens:1.5},{stop:['']},{prompt:'x'.repeat(16001)}])expect(()=>rolePreset(value)).toThrow()
 expect(rolePreset({temperature:0,topP:1,prompt:'a\nb',stop:['END']})).toEqual({temperature:0,topP:1,prompt:'a\nb',stop:['END']})
})
it('resolves recommendation, ignores it when selected and persists complete instance overrides',async()=>{
 const dir=await root(),id=randomUUID(),settings=new ModelPresets(dir)
 await settings.load();expect(settings.effective(id,{})).toEqual({})
 await settings.save({prompt:'global',temperature:.3},{})
 expect(settings.effective(id,{prompt:'pack',topP:.8})).toEqual({prompt:'pack',temperature:.3,topP:.8})
 await settings.save(settings.global,{[id]:{mode:'global',override:{}}})
 expect(settings.effective(id,{temperature:.9})).toEqual(settings.global)
 await settings.save(settings.global,{[id]:{mode:'custom',override:{prompt:'instance'}}})
 const restored=new ModelPresets(dir);await restored.load()
 expect(restored.effective(id,{temperature:.9})).toEqual({prompt:'instance'})
 const bytes='{"global":{"tools":[]},"instances":{}}';await writeFile(join(dir,'preset-settings.json'),bytes)
 await expect(new ModelPresets(dir).load()).rejects.toThrow('未覆盖')
 expect(await readFile(join(dir,'preset-settings.json'),'utf8')).toBe(bytes)
})
it('loads optional package recommendations and Launcher selections without changing world hash',async()=>{
 const dir=await root(),pack=join(dir,'pack')
 await cp(resolve('examples/world-packs/prototype-g1'),pack,{recursive:true})
 expect(await packPreset(pack)).toEqual({})
 const core=new LauncherCore(resolve('.'),join(dir,'launcher'));await core.initialize()
 await core.handle({operation:'load',path:pack})
 const hash=core.snapshot().packs[0]!.hash
 await writeFile(join(pack,'model-preset.json'),JSON.stringify({prompt:'pack',temperature:.6}))
 await core.handle({operation:'load',path:pack})
 expect(core.snapshot().packs[0]!.hash).toBe(hash)
 await core.handle({operation:'create',packageId:core.snapshot().packs[0]!.id,name:'preset'})
 const id=core.snapshot().instances[0]!.id
 await core.handle({operation:'preset-global',preset:{topP:.9}})
 await core.handle({operation:'preset-instance',instanceId:id,choice:{mode:'custom',override:{prompt:'instance'}}})
 const restored=new LauncherCore(resolve('.'),join(dir,'launcher'));await restored.initialize()
 expect(restored.snapshot().presets).toEqual(core.snapshot().presets)
 await expect(core.handle({operation:'preset-instance',instanceId:'other',choice:{mode:'auto',override:{}}})).rejects.toThrow('实例不存在')
 await writeFile(join(pack,'model-preset.json'),'{"tools":[]}')
 await expect(core.handle({operation:'preset-inspect'})).rejects.toThrow('model-preset.json')
})
it('adds portrayal settings only to character calls and keeps Host messages, schema and intent limits',async()=>{
 const sent:Record<string,unknown>[]=[]
 const provider=createChatProvider({endpoint:new URL('http://example.test/chat'),model:'role-model',preset:{prompt:'简短对白',temperature:.7,topP:.8,frequencyPenalty:.1,presencePenalty:.2,maxOutputTokens:333,stop:['END']},fetch:(async(_url,init)=>{sent.push(JSON.parse(String(init?.body)) as Record<string,unknown>);return new Response(JSON.stringify({choices:[{message:{content:'{}'}}]}))}) as typeof fetch})
 const call={messages:[{role:'system' as const,content:'Core contract'},{role:'user' as const,content:'private character context'}],description:'Host schema',schema:{type:'object' as const,additionalProperties:false}}
 await provider.decide(call,new AbortController().signal)
 expect(sent[0]).toMatchObject({model:'role-model',temperature:.7,top_p:.8,frequency_penalty:.1,presence_penalty:.2,max_tokens:333,stop:['END'],tool_choice:{type:'function',function:{name:'submit_actions'}}})
 expect(sent[0]!.messages).toEqual([call.messages[0],{role:'system',content:'角色表现预设：简短对白'},call.messages[1]])
 expect(sent[0]!.tools).toEqual([{type:'function',function:{name:'submit_actions',description:call.description,parameters:call.schema}}])
 await provider.dispatch({contract:'intent',sourceText:'hello',responseSchema:{type:'object'}},{modelId:'intent-model',timeoutMs:1000,maxOutputTokens:64},new AbortController().signal)
 expect(sent[1]).toMatchObject({model:'intent-model',temperature:.3,max_tokens:64})
 for(const key of ['top_p','frequency_penalty','presence_penalty','stop'])expect(sent[1]).not.toHaveProperty(key)
 expect(JSON.stringify(sent[1]!.messages)).not.toContain('简短对白')
})

it('uses character over group over instance and keeps a second instance independent', async () => {
  const dir=await root(),first=randomUUID(),second=randomUUID(),group=randomUUID()
  const settings=new ModelPresets(dir)
  await settings.save({prompt:'global'},{
    [first]:{mode:'custom',override:{prompt:'instance',temperature:.3},
      groups:{[group]:{name:'同组',preset:{prompt:'group',temperature:.5}}},
      memberships:{'character:companion':group,'character:friend':group},
      characters:{'character:companion':{prompt:'character',topP:.9}}},
    [second]:{mode:'global',override:{}},
  })
  const restored=new ModelPresets(dir);await restored.load()
  expect(restored.effectiveCharacter(first,{},'character:companion')).toEqual({prompt:'character',topP:.9})
  expect(restored.effectiveCharacter(first,{},'character:friend')).toEqual({prompt:'group',temperature:.5})
  expect(restored.effectiveCharacter(first,{},'character:other')).toEqual({prompt:'instance',temperature:.3})
  expect(restored.effectiveCharacter(second,{},'character:companion')).toEqual({prompt:'global'})
  const choice=restored.instances[first]!
  delete choice.characters!['character:companion']
  expect(restored.effectiveCharacter(first,{},'character:companion').prompt).toBe('group')
  choice.groups={};choice.memberships={}
  expect(restored.effectiveCharacter(first,{},'character:companion').prompt).toBe('instance')
})
it('checks group references and NPC IDs before saving any instance mappings',async()=>{
  const core=new LauncherCore(resolve('.'),await root());await core.initialize()
  await core.handle({operation:'load',path:resolve('examples/world-packs/prototype-g1')})
  await core.handle({operation:'create',packageId:core.snapshot().packs[0]!.id,name:'角色配置'})
  const instanceId=core.snapshot().instances[0]!.id,group=randomUUID()
  const metadata=core.snapshot().presets.characters['pack:prototype-g1']!
  expect(metadata.map(c=>c.id)).toEqual(['character:companion','character:friend'])
  expect(metadata.every(c=>Object.keys(c).sort().join(',')==='id,name')).toBe(true)
  const choice={mode:'auto',override:{},groups:{[group]:{name:'组',preset:{prompt:'group'}}},memberships:{'character:companion':group}}
  await core.handle({operation:'preset-instance',instanceId,choice})
  const bytes=await readFile(join(core.root,'preset-settings.json'),'utf8')
  for(const bad of [
    {...choice,characters:{'character:player':{}}},
    {...choice,characters:{'character:foreign':{}}},
    {...choice,memberships:{'character:foreign':group}},
    {...choice,memberships:{'character:companion':'missing'}},
    {...choice,groups:{[group]:{name:'组',preset:{tools:[]}}}},
    {...choice,mode:['auto']},
  ])await expect(core.handle({operation:'preset-instance',instanceId,choice:bad})).rejects.toThrow()
  expect(await readFile(join(core.root,'preset-settings.json'),'utf8')).toBe(bytes)
})
it('routes each real Core character call to its selected preset without cross-character prompts',async()=>{
  const calls:{actor:string;wire:Record<string,unknown>}[]=[]
  vi.stubGlobal('fetch',(async(_url:unknown,init:RequestInit)=>{
    const wire=JSON.parse(String(init.body)) as Record<string,unknown>
    const input=JSON.parse((wire.messages as {content:string}[]).at(-1)!.content) as {context:{character:{characterId:string}}}
    calls.push({actor:input.context.character.characterId,wire})
    return new Response(JSON.stringify({message:{content:JSON.stringify({decision:'abstain'})}}))
  }) as typeof fetch)
  const group=randomUUID(),dir=await root()
  const runtime=await FrozenWorldPlaytestRuntime.create({
    packPath:resolve('examples/world-packs/prototype-g1'),dataDirectory:join(dir,'world'),provider:'ollama',model:'fixture',
    preset:{prompt:'instance only',temperature:.2},
    presetMapping:{groups:{[group]:{name:'组',preset:{prompt:'group only',temperature:.5}}},
      memberships:{'character:companion':group,'character:friend':group},
      characters:{'character:companion':{prompt:'companion only',temperature:.8}}},
  })
  try{
    await runtime.submit('你好，可以介绍这里吗？')
    expect(calls.map(call=>call.actor)).toEqual(['character:companion','character:friend'])
    const [first,second]=calls
    expect(JSON.stringify(first!.wire.messages)).toContain('companion only')
    expect(JSON.stringify(first!.wire.messages)).not.toContain('group only')
    expect(JSON.stringify(second!.wire.messages)).toContain('group only')
    expect(JSON.stringify(second!.wire.messages)).not.toContain('companion only')
    expect(JSON.stringify(calls)).not.toContain('instance only')
    expect(first!.wire.options).toMatchObject({temperature:.8})
    expect(second!.wire.options).toMatchObject({temperature:.5})

  }finally{await runtime.close()}
  await expect(FrozenWorldPlaytestRuntime.create({packPath:resolve('examples/world-packs/prototype-g1'),dataDirectory:join(dir,'foreign'),provider:'ollama',
    presetMapping:{characters:{'character:foreign':{prompt:'not allowed'}}}})).rejects.toThrow('此包之外')
})
