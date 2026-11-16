/** Explicit trusted demo composition; no real models or world-pack executable UI. */
import { randomBytes, randomUUID } from 'node:crypto'
import { openStageLab, labRenderer } from '../support/activity-stage-fixture.ts'
import { openRpgFixture } from '../support/rpg-fixture.ts'
import { addRpgValuesExample } from '../support/rpg-values-fixture.ts'
import { officialStageRenderers } from '../../apps/host/src/official-bundle.ts'
import { FrontendActions, projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { createHostServer } from '../../apps/host/src/runtime/http-server.ts'
import { listenOnSafePort } from '../../apps/host/src/safe-port.ts'
const mode=process.argv[2] ?? 'lab'
if(!['lab','rpg','fallback'].includes(mode))throw Error('Choose lab, rpg or fallback')
const f=mode==='rpg'?await openRpgFixture({config:addRpgValuesExample,places:{'character:player':'location:ruin-1','character:cheng':'location:living-room'}}):await openStageLab(mode==='fallback'?'render-error':'normal')
if(mode==='rpg')await f.runtime.submit('准备战斗。')
else {
 const view=projectPlayerView(await f.runtime.state()),start=view.actions.find(a=>a.label==='开始 登记实验')!
 await new FrontendActions(f.runtime).perform({requestId:randomUUID(),actionId:randomUUID(),operation:'perform',payload:{optionId:start.id}})
}
const token=randomBytes(32).toString('hex'),server=createHostServer(f.runtime,token,undefined,undefined,{},null,[...officialStageRenderers,labRenderer]),port=await listenOnSafePort(server)
console.log(`Activity stage ${mode}: http://127.0.0.1:${port}/#token=${token}`)
console.log('Temporary SQLite and loopback fake model only. Ctrl+C closes and cleans up.')
let closing=false
const close=async()=>{if(closing)return;closing=true;server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await f.close()}
process.once('SIGINT',close);process.once('SIGTERM',close)
