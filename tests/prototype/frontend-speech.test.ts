import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { brandId } from '@harness-world/contracts'
import { createPlaytestServer, type PlaytestState } from '../experiments/playtest-server.ts'
import type { FrontendHostServices, FrontendSpeechAudio } from '../../packages/frontend/src/speech.ts'
import { loadHostPlugins } from '../../desktop/host-plugins.ts'

const servers: ReturnType<typeof createPlaytestServer>[] = [], token = 'c'.repeat(64)
const wav: FrontendSpeechAudio = {contentType:'audio/wav',bytes:new Uint8Array([82,73,70,70])}
afterEach(async()=>{
  for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))}
})
async function fixture(services:FrontendHostServices={}){
  let state:PlaytestState={busy:false,paused:false,error:false,notice:'PRIVATE_NOTICE',phaseLabel:'',debug:{secret:'PRIVATE_DEBUG'},
    world:{title:'测试',playerName:'玩家',npcNames:['PRIVATE_NPC']},
    transcript:[{seq:7,speaker:'同名角色（电话）',speakerId:brandId('character:remote','CharacterId'),text:'你好。',player:false,
      segments:[{type:'narration',text:'轻轻开口。'},{type:'speech',text:'你好。'}]}]}
  const submit=vi.fn(async()=>state)
  const runtime={state:async()=>state,submit,pause:async()=>state,resume:async()=>state,close:async()=>{}}
  const server=createPlaytestServer(runtime,token,undefined,undefined,services);servers.push(server)
  let url=''
  for(let attempt=0;attempt<8;attempt++){
    server.listen(0,'127.0.0.1');await once(server,'listening')
    url='http://127.0.0.1:'+(server.address() as AddressInfo).port
    try{await fetch(url);break}catch(error){
      if(!(error instanceof Error)||!(error.cause instanceof Error)||error.cause.message!=='bad port'||attempt===7)throw error
      await new Promise<void>(done=>server.close(()=>done()))
    }
  }
  const send=(payload:unknown,headers:Record<string,string>={'x-playtest-token':token})=>fetch(url+'/frontend-api/v1/speech',
    {method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(payload)})
  return {url,send,submit,replace:()=>{state={...state,transcript:[]}}}
}
const paragraph={seq:7,segmentIndex:1,text:'你好。'}
it('does not advertise or invoke synthesis when no host adapter is installed',async()=>{
  const {url,send}=await fixture()
  const init=await(await fetch(url+'/frontend-api/v1/init',{headers:{'x-playtest-token':token}})).json()
  expect(init.capabilities).not.toContain('speech')
  expect((await send(paragraph)).status).toBe(404)
})
it('sends only authorized segment text and identity to an injected adapter and returns binary audio',async()=>{
  const synthesizeSpeech=vi.fn(async()=>wav),{url,send,submit}=await fixture({synthesizeSpeech})
  const init=await(await fetch(url+'/frontend-api/v1/init',{headers:{'x-playtest-token':token}})).json()
  expect(init.capabilities).toContain('speech')
  expect((await send(paragraph,{})).status).toBe(401)
  expect((await send(paragraph,{'x-playtest-token':token,origin:'null'})).status).toBe(403)
  for(const payload of [{...paragraph,seq:99},{...paragraph,text:'PRIVATE_NPC 的秘密'},
    {...paragraph,segmentIndex:9},{...paragraph,speakerId:'character:forged'}])expect((await send(payload)).status).toBe(400)
  expect(synthesizeSpeech).not.toHaveBeenCalled()
  const response=await send(paragraph)
  expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe('audio/wav')
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(wav.bytes)
  const [input,signal]=synthesizeSpeech.mock.calls[0] as unknown as [unknown,AbortSignal]
  expect(input).toEqual({seq:7,segmentIndex:1,text:'你好。',type:'speech',speakerId:'character:remote'})
  expect(signal).toBeInstanceOf(AbortSignal)
  expect(submit).not.toHaveBeenCalled()
})
it('rejects audio after a candidate removes the paragraph and hides adapter failures',async()=>{
  let release!:(audio:FrontendSpeechAudio)=>void
  const synthesizeSpeech=vi.fn(()=>new Promise<FrontendSpeechAudio>(done=>{release=done}))
  const {send,replace}=await fixture({synthesizeSpeech})
  const pending=send(paragraph)
  await vi.waitFor(()=>expect(synthesizeSpeech).toHaveBeenCalledOnce())
  replace();release(wav)
  expect((await pending).status).toBe(409)
  const failed=await fixture({synthesizeSpeech:async()=>{throw new TypeError('PRIVATE_PROVIDER_KEY')}})
  const response=await failed.send(paragraph)
  expect(response.status).toBe(502);expect(await response.text()).not.toContain('PRIVATE_PROVIDER_KEY')
})

it('serves a dynamically loaded Cordis plugin through the same authorization boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perspectra-speech-plugin-'))
  const path = join(root, 'speech.mjs'), inputPath = join(root, 'input.json')
  await writeFile(path, `import { writeFileSync } from 'node:fs';
    export default function(ctx) {
      ctx.effect(() => ctx.frontendServices.registerSpeech(async input => {
        writeFileSync(new URL('./input.json', import.meta.url), JSON.stringify(input));
        return {contentType:'audio/wav',bytes:new Uint8Array([82,73,70,70])};
      }));
    }`)
  const session = await loadHostPlugins([{id:'tts',path,enabled:true}])
  try {
    const {url,send,submit} = await fixture(session.services)
    expect((await send({...paragraph,text:'PRIVATE_DEBUG'})).status).toBe(400)
    await expect(readFile(inputPath)).rejects.toThrow()
    const response = await send(paragraph)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(wav.bytes)
    expect(JSON.parse(await readFile(inputPath,'utf8'))).toEqual({
      ...paragraph,type:'speech',speakerId:'character:remote',
    })
    expect(submit).not.toHaveBeenCalled()
    await session.close()
    const init=await(await fetch(url+'/frontend-api/v1/init',{headers:{'x-playtest-token':token}})).json()
    expect(init.capabilities).not.toContain('speech')
    expect((await send(paragraph)).status).toBe(404)
  } finally { await session.close(); await rm(root,{recursive:true,force:true}) }
})
