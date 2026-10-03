import { createServer } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { interactionPackageDescription } from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { PackVariables } from '../experiments/pack-variables.ts'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'

const roots:string[]=[]
const original=resolve('examples/world-packs/ai-girls-awaken-v10')
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})})
async function fixture(sourceTransform=(s:string)=>s) {
  const root=mkdtempSync(join(tmpdir(),'pack-vars-'));roots.push(root)
  const packPath=join(root,'pack'),data=join(root,'data')
  cpSync(original,packPath,{recursive:true});mkdirSync(data)
  const script=join(packPath,'scripts/variables.js')
  writeFileSync(script,sourceTransform(readFileSync(script,'utf8')),'utf8')
  const pack=await compileWorldPackSource(packPath,[interactionPackageDescription(createBasicInteractionPackage())]) as CompiledWorldPackV5
  return {packPath,data,pack}
}
const richer=(s:string)=>s.replace("private: {}","private: { secret: '', number: 0, flag: false }")
describe('pack-owned variables',()=>{
  it('keeps ordinary objects out of compiled entities and initializes the package script',async()=>{
    const f=await fixture(),vars=PackVariables.load(f.packPath,f.data,f.pack)!
    expect(f.pack.content.entities).toEqual([])
    expect(vars.getVariables('character:player')).toEqual({public:{剧情:{阶段:'初见'}},private:{}})
  })
  it('persists numeric, boolean and text updates while separating character-private values',async()=>{
    const f=await fixture(richer),vars=PackVariables.load(f.packPath,f.data,f.pack)!
    vars.applyPatch('character:gpt',[{op:'replace',path:'/private/secret',value:'only-gpt'},
      {op:'replace',path:'/private/number',value:3},{op:'replace',path:'/private/flag',value:true}])
    expect(vars.getVariables('character:claude').private).toEqual({secret:'',number:0,flag:false})
    expect(JSON.stringify(vars.getVariables('character:player'))).not.toContain('only-gpt')
    const restored=PackVariables.load(f.packPath,f.data,f.pack)!
    expect(restored.getVariables('character:gpt').private).toEqual({secret:'only-gpt',number:3,flag:true})
    expect(()=>restored.getVariables('character:unknown')).toThrow(/角色/u)
  })
  it('rejects a mixed invalid batch, forged owner path, prototype keys and stale old value without saving',async()=>{
    const f=await fixture(richer),vars=PackVariables.load(f.packPath,f.data,f.pack)!
    const file=join(f.data,'pack-variables.json'),before=readFileSync(file,'utf8')
    for(const operations of [
      [{op:'replace',path:'/public/剧情/阶段',value:'早餐'},{op:'replace',path:'/private/flag',value:'wrong type'}],
      [{op:'replace',path:'/characters/character:gpt/secret',value:'leak'}],
      [{op:'replace',path:'/private/__proto__',value:{}}],
      [{op:'test',path:'/public/剧情/阶段',value:'wrong'},{op:'replace',path:'/public/剧情/阶段',value:'早餐'}],
    ])expect(()=>vars.applyPatch('character:player',operations)).toThrow()
    expect(readFileSync(file,'utf8')).toBe(before)
    expect(vars.getVariables('character:player').public).toEqual({剧情:{阶段:'初见'}})
  })
  it('refuses tampered scripts and a save belonging to a different pack',async()=>{
    const f=await fixture(),vars=PackVariables.load(f.packPath,f.data,f.pack)!
    expect(vars).toBeDefined()
    writeFileSync(join(f.packPath,'scripts/variables.js'),'globalThis.packScript={}')
    expect(()=>PackVariables.load(f.packPath,f.data,f.pack)).toThrow(/编译/u)
    cpSync(join(original,'scripts/variables.js'),join(f.packPath,'scripts/variables.js'))
    const file=join(f.data,'pack-variables.json'),saved=JSON.parse(readFileSync(file,'utf8'))
    saved.packHash='other-pack';writeFileSync(file,JSON.stringify(saved))
    expect(()=>PackVariables.load(f.packPath,f.data,f.pack)).toThrow(/不匹配/u)
  })
  it('fails bounded execution without providing node or world handles to the script',async()=>{
    const f=await fixture(s=>s.replace("initialize: () => clone(initial)",
      "initialize: () => { if(typeof process !== 'undefined' || typeof require !== 'undefined' || typeof WorldStore !== 'undefined') throw new Error('host leaked'); for(;;){} }"))
    expect(()=>PackVariables.load(f.packPath,f.data,f.pack)).toThrow(/timed out/u)
  })
  it('delivers only the acting character variables and keeps variable updates out of world commits',async()=>{
    const f=await fixture(s=>richer(s).replace("initialize: () => clone(initial)",
      "initialize: id => ({public: clone(initial.public),private:{secret:id+'-private',number:0,flag:false}})"))
    const requests:Record<string,unknown>[]=[]
    const server=createServer((req,res)=>{
      let body=''
      req.on('data',chunk=>{body+=String(chunk)})
      req.on('end',()=>{
        const wire=JSON.parse(body),input=JSON.parse(wire.messages.at(-1).content)
        requests.push(input)
        res.writeHead(200,{'content-type':'application/json'})
        res.end(JSON.stringify({message:{content:JSON.stringify({decision:'abstain'})}}))
      })
    })
    await new Promise<void>(ready=>server.listen(0,'127.0.0.1',ready))
    const address=server.address()
    if(!address || typeof address==='string')throw new Error('no endpoint')
    const runtime=await FrozenWorldPlaytestRuntime.create({packPath:f.packPath,dataDirectory:f.data,
      provider:'ollama',model:'fixture',utilityEndpoint:'http://127.0.0.1:'+address.port+'/api/chat'})
    try {
      const before=await runtime.state()
      const updated=await runtime.submit('/vars [{"op":"replace","path":"/public/剧情/阶段","value":"早餐"}]')
      expect(updated.debug.headSeq).toBe(before.debug.headSeq)
      expect(requests).toHaveLength(0)
      expect(JSON.stringify(updated)).not.toContain('character:gpt-private')
      expect(updated.packVariables?.private.secret).toBe('character:player-private')
      expect(updated.availableActions?.flatMap(a=>a.interactions ?? [])).toEqual([])
      await runtime.submit('/act speak {"text":"早上好。"}')
      expect(requests).toHaveLength(4)
      for(const request of requests) {
        const context=request.context as {character:{characterId:string};packVariables:{public:unknown;private:{secret:string}}}
        expect(context.packVariables.public).toEqual({剧情:{阶段:'早餐'}})
        expect(context.packVariables.private.secret).toBe(context.character.characterId+'-private')
        expect(JSON.stringify(request)).not.toContain('character:player-private')
      }
    } finally {await runtime.close();await new Promise<void>(done=>server.close(()=>done()))}
  },30_000)
})
