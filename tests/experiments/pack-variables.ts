import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { createContext, Script } from 'node:vm'
import type { WorldJsonObject } from '@harness-world/contracts'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'

type View = { public: WorldJsonObject; private: WorldJsonObject }
type Saved = { packHash:string; public:WorldJsonObject; characters:Record<string,WorldJsonObject> }
function object(value:unknown):WorldJsonObject {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new TypeError('包变量必须是对象')
  return value as WorldJsonObject
}
function view(value:unknown):View {
  const data=object(value)
  if (Object.keys(data).sort().join(',')!=='private,public') throw new TypeError('包变量必须只有 public/private')
  return {public:object(data.public),private:object(data.private)}
}

/** Fixed experimental script entry, JSON-only inputs, no WorldStore or credentials.
 * VM is for a bounded execution context, not a security sandbox for hostile packs.
 */
export class PackVariables {
  readonly #script:Script
  readonly #savePath:string
  readonly #characterIds:Set<string>
  #saved:Saved
  private constructor(source:string, savePath:string, pack:CompiledWorldPackV5) {
    this.#script=new Script(source+'\nJSON.stringify(packScript[__method](...JSON.parse(__args)))',
      {filename:'scripts/variables.js'})
    this.#savePath=savePath
    this.#characterIds=new Set(pack.content.characters.map(c=>c.characterId))
    const initial=[...this.#characterIds].map(id=>[id,this.#call('initialize',[id])] as const)
    if (!initial.length) throw new TypeError('包变量需要已声明角色')
    const publicVariables=initial[0]![1].public
    if (initial.some(([,v])=>JSON.stringify(v.public)!==JSON.stringify(publicVariables))) {
      throw new TypeError('初始化公开变量必须一致')
    }
    this.#saved={packHash:pack.packHash,public:publicVariables,
      characters:Object.fromEntries(initial.map(([id,v])=>[id,v.private]))}
    if (existsSync(savePath)) {
      const saved=object(JSON.parse(readFileSync(savePath,'utf8')))
      if (Object.keys(saved).sort().join(',')!=='characters,packHash,public' || saved.packHash!==pack.packHash) {
        throw new TypeError('包变量存档与当前包不匹配，请使用新存档目录')
      }
      const characters=object(saved.characters)
      if (Object.keys(characters).sort().join('\0')!==[...this.#characterIds].sort().join('\0')) {
        throw new TypeError('包变量存档的角色不匹配')
      }
      this.#saved={packHash:pack.packHash,public:object(saved.public),
        characters:Object.fromEntries(Object.entries(characters).map(([id,v])=>[id,object(v)]))}
      for (const id of this.#characterIds) this.getVariables(id)
    } else this.#save(this.#saved)
  }
  static load(packPath:string,dataDirectory:string,pack:CompiledWorldPackV5):PackVariables|undefined {
    const entry='scripts/variables.js'
    const lock=pack.assets.find(asset=>asset.path===entry)
    if (!lock) return undefined // Undeclared local files are never executed.
    const filename=resolve(packPath,entry)
    if (!lstatSync(filename).isFile()) throw new TypeError('变量脚本必须是普通文件')
    const path=relative(realpathSync(packPath),realpathSync(filename))
    if (path.startsWith('..') || path!==entry.split('/').join(sep)) {
      throw new TypeError('变量脚本必须位于包内')
    }
    const bytes=readFileSync(filename)
    if (bytes.length>64*1024 || bytes.length!==lock.size
        || 'sha256:'+createHash('sha256').update(bytes).digest('hex')!==lock.contentHash) {
      throw new TypeError('变量脚本与已编译的包不一致')
    }
    return new PackVariables(bytes.toString('utf8'),resolve(dataDirectory,'pack-variables.json'),pack)
  }
  #call(method:'initialize'|'getVariables'|'applyPatch',args:unknown[]):View {
    const input=JSON.stringify(args)
    if (input.length>64*1024) throw new RangeError('变量输入过长')
    const context=createContext(Object.assign(Object.create(null),{__method:method,__args:input}),
      {codeGeneration:{strings:false,wasm:false},microtaskMode:'afterEvaluate'})
    let output:unknown
    try { output=this.#script.runInContext(context,{timeout:100}) }
    catch(error) { throw new TypeError(error instanceof Error ? error.message : String(error)) }
    if (typeof output!=='string' || output.length>64*1024) throw new TypeError('变量脚本必须返回有限 JSON')
    return view(JSON.parse(output))
  }
  #current(characterId:string):View {
    if (!this.#characterIds.has(characterId)) throw new TypeError('变量访问者不是本包角色')
    return {public:this.#saved.public,private:this.#saved.characters[characterId]!}
  }
  getVariables(characterId:string):View {
    return this.#call('getVariables',[this.#current(characterId),characterId])
  }
  applyPatch(characterId:string,operations:unknown):View {
    // The script sees public values and only this actor's private values.
    const next=this.#call('applyPatch',[this.#current(characterId),operations,characterId])
    const saved={packHash:this.#saved.packHash,public:next.public,
      characters:{...this.#saved.characters,[characterId]:next.private}}
    this.#save(saved) // Publish in memory only after a successful atomic file replacement.
    this.#saved=saved
    return next
  }
  #save(saved:Saved):void {
    const temporary=this.#savePath+'.tmp'
    writeFileSync(temporary,JSON.stringify(saved,null,2)+'\n','utf8')
    renameSync(temporary,this.#savePath)
  }
}
