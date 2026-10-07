import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface FrontendIdentity { instanceId: string; packageId: string; packageVersion: string; digest: string }
interface Claims extends FrontendIdentity { authorizationId: string; grantedAt: string; mode: 'trusted'; protocolVersion: 1 }
interface RecordFile { claims: Claims; signature: string }
const uuid = /^[a-f0-9-]{36}$/
/** Windows account protection. Key bytes only travel through private stdin/stdout, never argv or browser. */
async function dpapi(bytes: Buffer, operation: 'Protect' | 'Unprotect'): Promise<Buffer> {
  if (process.platform !== 'win32') throw new Error('受信任授权目前仅支持 Windows。')
  const script = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;try{$inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());$result=[Security.Cryptography.ProtectedData]::"+operation+"($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($result))}catch{exit 1}"
  return new Promise((done,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','ignore']})
    let output=''
    const fail=()=>reject(new Error('本机授权密钥不可用；保持沙箱，不自动修复。'))
    child.stdout.on('data',chunk=>{output+=String(chunk)})
    child.once('error',fail)
    child.once('close',code=>{if(code!==0)fail();else done(Buffer.from(output.trim(),'base64'))})
    child.stdin.on('error',fail);child.stdin.end(bytes.toString('base64'))
  })
}
async function atomic(path:string,value:unknown):Promise<void>{
  const temporary=path+'.'+randomUUID()+'.tmp'
  await writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600})
  await rename(temporary,path)
}
function signature(claims:Claims,purpose:'master'|'instance',key:Buffer):string {
  // Reconstruct fixed fields; no dependency on disk JSON property order.
  const body=JSON.stringify([purpose,claims.protocolVersion,claims.authorizationId,claims.instanceId,claims.packageId,claims.packageVersion,claims.digest,claims.mode,claims.grantedAt])
  return createHmac('sha256',key).update(body).digest('hex')
}
function parse(value:unknown):RecordFile{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('record')
  const r=value as Record<string,unknown>,c=r.claims as Claims
  if(Object.keys(r).sort().join(',')!=='claims,signature'||!c||typeof c!=='object'||Array.isArray(c)
    ||Object.keys(c).sort().join(',')!=='authorizationId,digest,grantedAt,instanceId,mode,packageId,packageVersion,protocolVersion'
    ||!uuid.test(c.authorizationId)||!uuid.test(c.instanceId)||!/^[a-f0-9]{64}$/.test(c.digest)
    ||c.protocolVersion!==1||c.mode!=='trusted'||typeof c.packageId!=='string'||typeof c.packageVersion!=='string'
    ||typeof c.grantedAt!=='string'||!Number.isFinite(Date.parse(c.grantedAt))||typeof r.signature!=='string'||!/^[a-f0-9]{64}$/.test(r.signature))throw new Error('record')
  return {claims:c,signature:r.signature}
}
export class FrontendAuthorizations {
  constructor(readonly root:string) {}
  #reference(instanceId:string):string {if(!uuid.test(instanceId))throw new Error('实例 ID 无效。');return join(this.root,'frontend-instance-authorizations',instanceId+'.json')}
  async #key(create=false):Promise<Buffer>{
    const path=join(this.root,'frontend-authorization-key.dpapi')
    let sealed:Buffer
    try{sealed=await readFile(path)}
    catch(error:unknown){
      if(!create||!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error
      // Missing key must never resurrect old records: a new key makes all old signatures invalid.
      const key=randomBytes(32)
      sealed=await dpapi(key,'Protect')
      await writeFile(path,sealed,{flag:'wx',mode:0o600})
      return key
    }
    const key=await dpapi(sealed,'Unprotect')
    if(key.length!==32)throw new Error('授权密钥无效。')
    return key
  }
  async valid(identity:FrontendIdentity):Promise<boolean>{
    try{
      const reference=parse(JSON.parse(await readFile(this.#reference(identity.instanceId),'utf8')))
      const master=parse(JSON.parse(await readFile(join(this.root,'frontend-authorizations',reference.claims.authorizationId+'.json'),'utf8')))
      const key=await this.#key()
      for(const [purpose,r] of [['master',master],['instance',reference]] as const){
        const expected=Buffer.from(signature(r.claims,purpose,key),'hex')
        if(!timingSafeEqual(expected,Buffer.from(r.signature,'hex')))return false
        if(r.claims.instanceId!==identity.instanceId||r.claims.packageId!==identity.packageId||r.claims.packageVersion!==identity.packageVersion||r.claims.digest!==identity.digest)return false
      }
      return JSON.stringify(master.claims)===JSON.stringify(reference.claims)
    }catch{return false}
  }
  async grant(identity:FrontendIdentity):Promise<void>{
    const path=this.#reference(identity.instanceId)
    if(!/^[a-f0-9]{64}$/.test(identity.digest))throw new Error('前端摘要无效。')
    const key=await this.#key(true)
    const claims:Claims={...identity,authorizationId:randomUUID(),grantedAt:new Date().toISOString(),mode:'trusted',protocolVersion:1}
    await mkdir(join(this.root,'frontend-authorizations'),{recursive:true})
    await mkdir(join(this.root,'frontend-instance-authorizations'),{recursive:true})
    await atomic(join(this.root,'frontend-authorizations',claims.authorizationId+'.json'),{claims,signature:signature(claims,'master',key)})
    await atomic(path,{claims,signature:signature(claims,'instance',key)})
  }
  async revoke(instanceId:string):Promise<void>{
    const path=this.#reference(instanceId)
    let id:string|undefined
    try{const reference=parse(JSON.parse(await readFile(path,'utf8')));const key=await this.#key();if(reference.claims.instanceId===instanceId&&timingSafeEqual(Buffer.from(signature(reference.claims,'instance',key),'hex'),Buffer.from(reference.signature,'hex')))id=reference.claims.authorizationId}catch{/* Invalid references are removed without repair. */}
    if(id)await rm(join(this.root,'frontend-authorizations',id+'.json'),{force:true})
    await rm(path,{force:true})
  }
}
