import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { FrontendAuthorizations, type FrontendIdentity } from '../../desktop/frontend-authorization.ts'
import { loadPackWeb } from '../experiments/playtest-pack-web.ts'
import { LauncherCore } from '../../desktop/launcher-core.ts'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'frontend-auth-'));roots.push(root)
 const pack=join(root,'pack');await mkdir(pack)
 await cp(resolve('tests/fixtures/frontend-adversarial/frontend'),join(pack,'frontend'),{recursive:true})
 const web=(await loadPackWeb(pack))!
 const identity:FrontendIdentity={instanceId:randomUUID(),packageId:'fixture',packageVersion:'1',digest:web.digest}
 return {root,pack,web,identity,auth:new FrontendAuthorizations(root),reference:join(root,'frontend-instance-authorizations',identity.instanceId+'.json')}
}
it('binds the digest to every loaded file, path and manifest without changing world identity',async()=>{
 const f=await fixture();expect((await loadPackWeb(f.pack))!.digest).toBe(f.web.digest)
 await writeFile(join(f.pack,'frontend/assets/banner.svg'),'<svg>changed</svg>')
 expect((await loadPackWeb(f.pack))!.digest).not.toBe(f.web.digest)
 const before=(await loadPackWeb(f.pack))!.digest
 await rename(join(f.pack,'frontend/assets/banner.svg'),join(f.pack,'frontend/assets/renamed.svg'))
 expect((await loadPackWeb(f.pack))!.digest).not.toBe(before)
 const next=(await loadPackWeb(f.pack))!.digest
 await writeFile(join(f.pack,'frontend/manifest.json'),JSON.stringify({apiVersion:1,capabilities:['view']}))
 expect((await loadPackWeb(f.pack))!.digest).not.toBe(next)
})
it.skipIf(process.platform!=='win32')('requires both signed records, exact identity and current content; never repairs invalid records',async()=>{
 const f=await fixture()
 expect(await f.auth.valid(f.identity)).toBe(false)
 await f.auth.grant(f.identity)
 expect(await f.auth.valid(f.identity)).toBe(true)
 expect(await f.auth.valid({...f.identity,digest:'f'.repeat(64)})).toBe(false)
 expect(await f.auth.valid({...f.identity,packageVersion:'2'})).toBe(false)
 const bytes=await readFile(f.reference,'utf8'),reference=JSON.parse(bytes)
 const main=join(f.root,'frontend-authorizations',reference.claims.authorizationId+'.json')
 const master=await readFile(main,'utf8')
 // Two files cannot be made valid by copying the global signature into the instance reference.
 await writeFile(f.reference,master)
 expect(await f.auth.valid(f.identity)).toBe(false)
 expect(await readFile(f.reference,'utf8')).toBe(master)
 await writeFile(f.reference,bytes)
 reference.claims.digest='f'.repeat(64);await writeFile(f.reference,JSON.stringify(reference))
 expect(await f.auth.valid({...f.identity,digest:'f'.repeat(64)})).toBe(false)
 await writeFile(f.reference,bytes);await rm(main)
 expect(await f.auth.valid(f.identity)).toBe(false)
 expect(await readFile(f.reference,'utf8')).toBe(bytes)
})
it.skipIf(process.platform!=='win32')('does not transfer authorization to another instance and revokes both records',async()=>{
 const f=await fixture();await f.auth.grant(f.identity)
 const other={...f.identity,instanceId:randomUUID()}
 const path=join(f.root,'frontend-instance-authorizations',other.instanceId+'.json')
 await cp(f.reference,path);expect(await f.auth.valid(other)).toBe(false)
 await f.auth.revoke(other.instanceId);expect(await f.auth.valid(f.identity)).toBe(true)
 await f.auth.revoke(f.identity.instanceId)
 expect(await f.auth.valid(f.identity)).toBe(false)
 expect(await readdir(join(f.root,'frontend-authorizations'))).toHaveLength(0)
 await expect(readFile(f.reference)).rejects.toMatchObject({code:'ENOENT'})
})
it.skipIf(process.platform!=='win32')('fails closed when the local protected key is damaged and does not replace it',async()=>{
 const f=await fixture();await f.auth.grant(f.identity)
 const path=join(f.root,'frontend-authorization-key.dpapi');await writeFile(path,'damaged')
 expect(await f.auth.valid(f.identity)).toBe(false)
 await expect(f.auth.grant(f.identity)).rejects.toThrow()
 expect(await readFile(path,'utf8')).toBe('damaged')
})
it.skipIf(process.platform!=='win32')('requires explicit Launcher confirmation against the displayed digest and checks changes before startup',async()=>{
 const f=await fixture()
 const source=join(f.root,'source');await cp(resolve('examples/world-packs/prototype-g1'),source,{recursive:true})
 await cp(join(f.pack,'frontend'),join(source,'frontend'),{recursive:true})
 const root=join(f.root,'launcher'),core=new LauncherCore(resolve('.'),root);await core.initialize()
 await core.handle({operation:'load',path:source})
 await core.handle({operation:'create',packageId:core.snapshot().packs[0]!.id,name:'test'})
 const instanceId=core.snapshot().instances[0]!.id
 await core.handle({operation:'frontend-inspect',instanceId})
 const digest=core.snapshot().frontends[instanceId]!.digest
 await expect(core.handle({operation:'frontend-grant',instanceId,expectedDigest:digest,confirmed:false})).rejects.toThrow('确认')
 await expect(core.handle({operation:'frontend-grant',instanceId,expectedDigest:'f'.repeat(64),confirmed:true})).rejects.toThrow('变化')
 await core.handle({operation:'frontend-grant',instanceId,expectedDigest:digest,confirmed:true})
 expect(core.snapshot().frontends[instanceId]!.mode).toBe('trusted')
 await writeFile(join(source,'frontend/assets/banner.svg'),'<svg>new content</svg>')
 await core.handle({operation:'frontend-inspect',instanceId})
 expect(core.snapshot().frontends[instanceId]!.mode).toBe('sandbox')
 // The old authorization is left untouched; there is no silent regeneration.
 await core.handle({operation:'frontend-revoke',instanceId})
 expect(core.snapshot().frontends[instanceId]!.mode).toBe('sandbox')
 expect(JSON.stringify(core.snapshot())).not.toContain('signature')
})
