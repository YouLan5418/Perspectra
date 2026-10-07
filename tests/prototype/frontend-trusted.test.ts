import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { createTrustedFrontendServer, type FrontendPolicy } from '../experiments/playtest-frontend-assets.ts'
import { loadPackWeb } from '../experiments/playtest-pack-web.ts'
import { createPlaytestServer, type PlaytestState, type PlaytestRuntime } from '../experiments/playtest-server.ts'
import { resolve } from 'node:path'
const servers:ReturnType<typeof createPlaytestServer>[]=[]
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))}})
it('keeps trusted static resources on a separate origin with no Core routes, and revokes in the live stream',async()=>{
 const web=(await loadPackWeb(resolve('tests/fixtures/frontend-adversarial')))!
 const state:PlaytestState={busy:false,paused:false,error:false,notice:'',phaseLabel:'',transcript:[],world:{title:'test',playerName:'player',npcNames:[]},debug:{canary:'PRIVATE_CORE'}}
 const runtime:PlaytestRuntime={state:async()=>state,submit:async()=>state,pause:async()=>state,resume:async()=>state,close:async()=>{}}
 const policy:FrontendPolicy={mode:'trusted',origin:'',revision:0},token='f'.repeat(64)
 let hostOrigin=''
 const host=createPlaytestServer(runtime,token,web,policy),child=createTrustedFrontendServer(web,policy,()=>hostOrigin);servers.push(host,child)
 host.listen(0,'127.0.0.1');await once(host,'listening');hostOrigin='http://127.0.0.1:'+(host.address() as AddressInfo).port
 child.listen(0,'127.0.0.1');await once(child,'listening');policy.origin='http://127.0.0.1:'+(child.address() as AddressInfo).port
 const headers={'x-playtest-token':token}
 const init=await (await fetch(hostOrigin+'/frontend-api/v1/init',{headers})).json()
 expect(init.capabilities).toContain('external-network');expect(init.capabilities).toContain('browser-storage')
 expect(init.frontendOrigin).toBe(policy.origin);expect(init.frontendMode).toBe('trusted');expect(JSON.stringify(init)).not.toContain(token)
 const page=await fetch(policy.origin+'/frontend/custom/index.html')
 expect(page.headers.get('content-security-policy')).toContain('allow-scripts allow-same-origin')
 expect((await fetch(policy.origin+'/api/state',{headers})).status).toBe(404)
 expect((await fetch(policy.origin+'/frontend-api/v1/view',{headers})).status).toBe(404)
 expect((await fetch(hostOrigin+'/api/state',{headers:{...headers,origin:policy.origin}})).status).toBe(403)
 expect((await (await fetch(hostOrigin+'/frontend-api/v1/init?template=default',{headers})).json()).frontendMode).toBe('sandbox')
 const controller=new AbortController()
 const stream=await fetch(hostOrigin+'/frontend-api/v1/events',{headers,signal:controller.signal}),reader=stream.body!.getReader()
 await reader.read()
 policy.mode='sandbox';policy.revision++
 const chunk=await reader.read()
 expect(new TextDecoder().decode(chunk.value)).toContain('frontend-policy')
 controller.abort()
 expect((await fetch(policy.origin+'/frontend/custom/index.html')).status).toBe(410)
 expect((await (await fetch(hostOrigin+'/frontend-api/v1/init',{headers})).json()).frontendMode).toBe('sandbox')
})
