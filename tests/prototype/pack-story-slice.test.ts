import { createServer, type Server } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { compileWorldPackSource } from '@harness-world/world-pack'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { PackKnowledge } from '../../desktop/host/pack-knowledge.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'

const roots: string[] = [], runtimes: WorldHostRuntime[] = [], servers: Server[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) {server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))}
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true})
})
async function packFixture() {
  const root = mkdtempSync(join(tmpdir(),'pack-story-slice-')); roots.push(root)
  const path = join(root,'pack'); cpSync(resolve('examples/world-packs/prototype-g1'),path,{recursive:true})
  const source = JSON.parse(readFileSync(join(path,'worldpack.source.json'),'utf8'))
  const write = (name: string, value: unknown) => writeFileSync(join(path,name),JSON.stringify(value))
  writeFileSync(join(path,'setting.md'),'只有同行者知道的青竹密约')
  writeFileSync(join(path,'lore.md'),'黑海岸是一处研究基地。'.repeat(12))
  write('documents.json',{schemaVersion:'worldpack-documents/v2',documents:[
    {documentId:'document:secret',contentRef:'setting.md',usage:'world_context',audience:'character_private',characterIds:['character:companion']},
    {documentId:'document:lore',contentRef:'lore.md',usage:'world_context',audience:'public'}]})
  const knowledgeConfig = {maximumCharacters:500,entries:[
    {documentId:'document:secret',keywords:[],constant:true,priority:100},
    {documentId:'document:lore',keywords:['黑海岸'],constant:false,priority:20}]}
  write('knowledge.json',knowledgeConfig)
  source.documentFiles=['documents.json'];source.markdownFiles=['setting.md','lore.md'];source.assetFiles=['knowledge.json']
  write('worldpack.source.json',source)
  const pack = await compileWorldPackSource(path,createInstalledInteractionPackages().map(interactionPackageDescription))
  return {root,path,pack,knowledgeConfig}
}
const context = (actor: string, speech = ''): WorldJsonObject => ({character:{characterId:actor},observations:[{value:{content:{speech}}}]})
const fields = (properties: WorldJsonObject): WorldJsonObject => ({ type: 'object', required: Object.keys(properties), properties })
const contains = (properties: WorldJsonObject): WorldJsonObject => ({ type: 'array', contains: fields(properties) })

it('checks knowledge audience before matching and skips whole entries exceeding the budget',async()=>{
  const f=await packFixture(), knowledge=PackKnowledge.load(f.path,f.pack)!
  expect(JSON.stringify(knowledge.select(context('character:friend','青竹 黑海岸')))).not.toContain('密约')
  expect(JSON.stringify(knowledge.select(context('character:friend')))).not.toContain('研究基地')
  expect(JSON.stringify(knowledge.select(context('character:companion','黑海岸')))).toContain('密约')
  expect(JSON.stringify(knowledge.select(context('character:companion','黑海岸')))).toContain('研究基地')
  const limited=PackKnowledge.parse({...f.knowledgeConfig,maximumCharacters:100},f.pack)
  const delivered=limited.select(context('character:companion','黑海岸')).entries as WorldJsonObject[]
  expect(delivered.reduce((n,row)=>n+String(row.content).length,0)).toBeLessThanOrEqual(100)
  expect(JSON.stringify(delivered)).not.toContain('研究基地')
  expect(()=>PackKnowledge.parse({...f.knowledgeConfig,entries:[{...f.knowledgeConfig.entries[0],requireState:{id:'trust',minimum:52}}]},f.pack)).toThrow('条目无效')
  writeFileSync(join(f.path,'knowledge.json'),'{}')
  expect(()=>PackKnowledge.load(f.path,f.pack)).toThrow('编译包不一致')
})

it('gates knowledge by the receiver known nested state without exposing another role secrets', async () => {
  const f = await packFixture()
  const when = JSON.parse(readFileSync(resolve('examples/world-packs/status-market/knowledge.json'), 'utf8')).entries[0].when
  const knowledge = PackKnowledge.parse({ ...f.knowledgeConfig, entries: f.knowledgeConfig.entries.map(entry =>
    ({ ...entry, constant: true, when })) }, f.pack)
  const state = (actor: string, holderId: string, stage: string): WorldJsonObject => ({ ...context(actor), knownStatus: [
    { key: 'quests', label: '委托', holderId, value: { market: { stage, notes: [] } }, current: false } ] })
  expect(knowledge.select(context('character:friend')).entries).toEqual([])
  expect(knowledge.select(state('character:friend', 'character:companion', 'done')).entries).toEqual([])
  expect(knowledge.select(state('character:friend', 'character:friend', 'active')).entries).toEqual([])
  const friend = JSON.stringify(knowledge.select(state('character:friend', 'character:friend', 'done')))
  expect(friend).toContain('研究基地')
  expect(friend).not.toContain('密约')
  expect(JSON.stringify(knowledge.select(state('character:companion', 'character:companion', 'done')))).toContain('密约')
  expect(() => PackKnowledge.parse({ ...f.knowledgeConfig, entries: [{ ...f.knowledgeConfig.entries[0], when: [] }] }, f.pack)).toThrow('条件')
})

it('selects setting by current scene, items, activity, stimulus and known status freshness', async () => {
  const f = await packFixture(), actor = 'character:companion'
  const visible: WorldJsonObject = { ...context(actor), character: { characterId: actor, locationId: 'location:front-room' },
    scene: { people: [{ characterId: 'character:player' }] },
    items: { current: [{ entityId: 'entity:brass-key', holderId: actor }], lastObserved: [] },
    activity: { activityKey: 'market', game: { phase: 'reward', private: { clue: '本人线索' } } },
    stimulus: [{ content: { actorId: 'character:player', speech: { segments: [{ type: 'speech', text: '徽章' }] } } }],
    knownStatus: [{ key: 'money', holderId: actor, value: 100, current: true }] }
  const predicates = {
    characterId: { const: actor }, locationId: { const: 'location:front-room' },
    scene: fields({ people: contains({ characterId: { const: 'character:player' } }) }),
    items: fields({ current: contains({ entityId: { const: 'entity:brass-key' }, holderId: { const: actor } }) }),
    activity: fields({ activityKey: { const: 'market' }, game: fields({ phase: { const: 'reward' }, private: fields({ clue: { const: '本人线索' } }) }) }),
    stimulus: { type: 'array', contains: fields({ content: fields({ actorId: { const: 'character:player' },
      speech: fields({ segments: contains({ type: { const: 'speech' }, text: { type: 'string', pattern: '徽章' } }) }) }) }) },
    knownStatus: contains({ key: { const: 'money' }, holderId: { const: actor }, current: { const: true } }),
  }
  const knowledge = PackKnowledge.parse({ ...f.knowledgeConfig, entries: f.knowledgeConfig.entries.map(entry =>
    ({ ...entry, constant: true, when: fields(predicates) })) }, f.pack)
  const selected = (value: WorldJsonObject) => (knowledge.select(value).entries as WorldJsonObject[]).map(row => row.documentId)
  expect(selected(visible)).toEqual(['document:secret', 'document:lore'])
  // Each source must be current and authorized; old observations and past stimulus cannot fill missing inputs.
  for (const change of [
    { character: { characterId: actor, locationId: 'location:back-room' } }, { scene: { people: [] } },
    { items: { current: [], lastObserved: [{ entityId: 'entity:brass-key', holderId: actor }] } },
    { items: { current: [{ entityId: 'entity:brass-key', holderId: 'character:player' }] } },
    { activity: null }, { activity: { activityKey: 'other', game: { phase: 'reward', private: { clue: '本人线索' } } } },
    { stimulus: [], observations: visible.stimulus },
    { knownStatus: [{ key: 'money', holderId: actor, value: 100, current: false }] },
    { knownStatus: [] },
  ] as WorldJsonObject[]) expect(selected({ ...visible, ...change }), JSON.stringify(change)).toEqual([])
  expect(selected(context(actor))).toEqual([])
})

it('does not expose unrelated context or let scene predicates widen a private document audience', async () => {
  const f = await packFixture()
  const request: WorldJsonObject = { ...context('character:friend'),
    character: { characterId: 'character:friend', locationId: 'location:front-room' },
    truth: { answer: 73 }, cognition: { secret: 'private thought' }, knowledge: { entries: ['previous setting'] },
    observations: [{ content: { locationId: 'location:back-room' } }] }
  const select = (when: WorldJsonObject) => PackKnowledge.parse({ ...f.knowledgeConfig,
    entries: f.knowledgeConfig.entries.map(entry => ({ ...entry, constant: true, when })) }, f.pack).select(request).entries
  expect((select(fields({ locationId: { const: 'location:front-room' } })) as WorldJsonObject[])
    .map(row => row.documentId)).toEqual(['document:lore'])
  for (const key of ['truth', 'cognition', 'knowledge', 'observations']) {
    expect(select(fields({ [key]: {} }))).toEqual([])
  }
  expect(select(fields({ locationId: { const: 'location:back-room' } }))).toEqual([])
})

it('accepts a lorebook-sized pack: 600 entries, long keyword lists and a single entry near 40k characters',async()=>{
  const root = mkdtempSync(join(tmpdir(),'pack-lorebook-scale-')); roots.push(root)
  const path = join(root,'pack'); cpSync(resolve('examples/world-packs/prototype-g1'),path,{recursive:true})
  const source = JSON.parse(readFileSync(join(path,'worldpack.source.json'),'utf8'))
  mkdirSync(join(path,'lore'))
  const markdownFiles: string[] = [], documents: WorldJsonObject[] = [], entries: WorldJsonObject[] = []
  const keywords = Array.from({length: 200}, (_, index) => `别名${index}`)
  for (let index = 0; index < 600; index++) {
    const file = `lore/${index}.md`; markdownFiles.push(file)
    writeFileSync(join(path,file), index === 0 ? '长'.repeat(39_000) : `第${index}条设定。`)
    documents.push({documentId:`document:lore-${index}`,contentRef:file,usage:'world_context',audience:'public'})
    entries.push({documentId:`document:lore-${index}`,keywords:index === 0 ? ['巨型条目',...keywords] : [`条目${index}号`,...keywords.slice(0,8).map(key => `${key}-${index}`)],constant:false,priority:index === 0 ? 10 : 0})
  }
  writeFileSync(join(path,'documents.json'),JSON.stringify({schemaVersion:'worldpack-documents/v2',documents}))
  const config = JSON.stringify({maximumCharacters:40_000,entries})
  expect(Buffer.byteLength(config)).toBeGreaterThan(65536)
  writeFileSync(join(path,'knowledge.json'),config)
  writeFileSync(join(path,'worldpack.source.json'),JSON.stringify({...source,documentFiles:['documents.json'],markdownFiles,assetFiles:['knowledge.json']}))
  const pack = await compileWorldPackSource(path,createInstalledInteractionPackages().map(interactionPackageDescription))
  const delivered = PackKnowledge.load(path,pack)!.select(context('character:friend','提到巨型条目和条目599号')).entries as WorldJsonObject[]
  expect(delivered.map(row => row.documentId)).toEqual(['document:lore-0','document:lore-599'])
  expect(String(delivered[0]!.content)).toHaveLength(39_000)
  expect(()=>PackKnowledge.parse({maximumCharacters:65537,entries:[]},pack)).toThrow('知识配置无效')
},30000)

it.each(['ollama','local'] as const)('keeps private knowledge and direct speech isolated through the %s host, reopen and regeneration',async(provider)=>{
  const f=await packFixture(), data=join(f.root,'data'), requests:WorldJsonObject[]=[]
  const when = fields({ locationId: { const: 'location:front-room' },
    scene: fields({ people: contains({ characterId: { const: 'character:companion' } }) }),
    items: fields({ current: contains({ entityId: { const: 'entity:brass-key' } }) }),
    stimulus: { type: 'array', contains: fields({ content: fields({ actorId: { const: 'character:player' }, speech: {
      anyOf: [fields({ text: { type: 'string', pattern: '黑海岸' } }),
        fields({ segments: contains({ type: { const: 'speech' }, text: { type: 'string', pattern: '黑海岸' } }) })],
    } }) }) } })
  writeFileSync(join(f.path,'knowledge.json'), JSON.stringify({ ...f.knowledgeConfig,
    entries: f.knowledgeConfig.entries.map(entry => entry.documentId === 'document:lore' ? { ...entry, when } : entry) }))
  const server=createServer((request,response)=>{
    let body='';request.on('data',chunk=>{body+=String(chunk)});request.on('end',()=>{
      try{
        expect(body).not.toContain('character-state:update')
        const messages=JSON.parse(body).messages as {role:string;content:string}[]
        const input=JSON.parse(messages.findLast(m=>m.role==='user')!.content) as WorldJsonObject
        requests.push(input);const c=input.context as WorldJsonObject, actor=String((c.character as WorldJsonObject).characterId)
        expect(c.characterState).toBeUndefined()
        const output=actor==='character:companion'?{decision:'publish',segments:[{type:'speech',text:'我听见了，也会有自己的想法。'}]}:{decision:'abstain'}
        response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(provider==='ollama'?{message:{content:JSON.stringify(output)}}
          :{choices:[{message:{tool_calls:[{id:'fixture-call',type:'function',function:{name:'submit_actions',arguments:JSON.stringify(output)}}]}}]}))
      }catch(error){response.writeHead(500);response.end(String(error))}
    })
  });servers.push(server);await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  const options={packPath:f.path,dataDirectory:data,provider,model:'fixture',timeoutMs:5000,
    utilityEndpoint:'http://127.0.0.1:'+(server.address() as {port:number}).port+(provider==='ollama'?'/api/chat':'/v1/chat/completions')}
  const runtime=await WorldHostRuntime.create(options);runtimes.push(runtime)
  const result=await runtime.submit('/act speak {"text":"黑海岸的暗号是紫藤雨，只告诉你。","scope":"direct","addresseeIds":["character:companion"]}')
  expect(result.error,JSON.stringify(result.debug)).toBe(false)
  const view=projectPlayerView(result)
  expect(view).not.toHaveProperty('characterStates')
  const friends=requests.filter(r=>((r.context as WorldJsonObject).character as WorldJsonObject).characterId==='character:friend')
  expect(friends.length).toBeGreaterThan(0)
  expect(JSON.stringify(friends)).not.toContain('密约')
  expect(JSON.stringify(friends)).not.toContain('紫藤雨')
  expect(JSON.stringify(friends)).not.toContain('研究基地')
  const companion=requests.find(r=>((r.context as WorldJsonObject).character as WorldJsonObject).characterId==='character:companion')!
  expect(JSON.stringify(companion)).toContain('密约')
  expect(JSON.stringify(companion)).toContain('研究基地')
  await runtime.close();runtimes.splice(runtimes.indexOf(runtime),1)
  const reopened=await WorldHostRuntime.create(options);runtimes.push(reopened)
  const tail=await reopened.state()
  expect(projectPlayerView(tail).history).toEqual(view.history)
  const regenerated=await reopened.regenerate(tail.tailRound!.id!,'offline-regeneration')
  expect(regenerated.error).toBe(false)
  expect(projectPlayerView(regenerated)).not.toHaveProperty('characterStates')
},30000)
