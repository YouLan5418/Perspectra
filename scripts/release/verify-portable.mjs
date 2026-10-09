import {spawn} from 'node:child_process'
import {resolve,join} from 'node:path'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {DEFAULT_PAGE,DEFAULT_STYLE,DEFAULT_SCRIPT} from '../../packages/frontend/src/default-template.ts'
import {HOST_ACTIVITY_PAGE} from '../../tests/experiments/playtest-host-page.ts'
const root=resolve(process.argv[2]),data=resolve(process.argv[3]);await mkdir(data,{recursive:true})
const official=process.argv[4]==='official',packName=official?'大模型变成美少女了':'前室与后室'
const runtime=join(root,'runtime');const env={...process.env,PATH:'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0',PERSPECTRA_RUNTIME_ROOT:runtime,HCW_HINDSIGHT_PYTHON:join(runtime,'python/python.exe'),HCW_HINDSIGHT_CORE_DIR:join(runtime,'experiments/hindsight-core'),HCW_HINDSIGHT_ONNX_DIR:join(runtime,'models/e5-small'),HCW_HINDSIGHT_CACHE_DIR:join(data,'cache'),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONHOME:undefined,PYTHONPATH:undefined}
const child=spawn(join(runtime,'node.exe'),[join(runtime,'launcher.mjs'),join(data,'launcher')],{cwd:runtime,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
let buffer='';const queue=[];const next=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('IPC deadline')),60000);queue.push(v=>{clearTimeout(timer);resolve(v)})});child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;for(;;){const i=buffer.indexOf('\n');if(i<0)break;const line=buffer.slice(0,i);buffer=buffer.slice(i+1);queue.shift()?.(JSON.parse(line))}})
let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',e=>{throw e});child.on('exit',()=>{while(queue.length)queue.shift()({ok:false,error:'Portable bridge exited before reply'})})
const request=async value=>{const pending=next();child.stdin.write(JSON.stringify(value)+'\n');const reply=await pending;if(!reply.ok)throw Error(reply.error);return reply.result}
try{
const first=await request({operation:'snapshot'});if(first.packs.length!==0)throw Error('not a fresh root')
await request({operation:'load',path:join(root,'examples',packName)});const snapshot=await request({operation:'snapshot'});await request({operation:'create',packageId:snapshot.packs[0].id,name:'便携验证'})
const connection=process.argv[5]==='offline'?{message:'Skipped: offline verification'}:await request({operation:'test-model',model:{endpoint:'http://127.0.0.1:8046/v1/chat/completions',model:'gemini-3.7-flash'}})
const started=await request({operation:'start',instanceId:(await request({operation:'snapshot'})).instances[0].id})
if(started.core.state!=='running')throw Error('Core not running')
const opened=await request({operation:'open'}),origin=new URL(opened.url).origin
for(const [path,expected] of [['/',HOST_ACTIVITY_PAGE],['/frontend/default.html',DEFAULT_PAGE],['/frontend/default.css',DEFAULT_STYLE],['/frontend/default.js',DEFAULT_SCRIPT]]){
 const response=await fetch(origin+path,{signal:AbortSignal.timeout(15000)})
 if(!response.ok||await response.text()!==expected)throw Error('Portable frontend differs from current source: '+path)
}
let prologue
if(official){
 for(const file of ['index.html','style.css','app.js']){
  const response=await fetch(origin+'/frontend/custom/'+file,{signal:AbortSignal.timeout(15000)})
  if(!response.ok||await response.text()!==await readFile(join(root,'examples',packName,'frontend',file),'utf8'))throw Error('Official frontend asset mismatch: '+file)
 }
 const headers={'x-playtest-token':new URL(opened.url).hash.slice('#token='.length),'content-type':'application/json'}
 const api=async(path,action)=>{const response=await fetch(origin+path,{headers,...(action?{method:'POST',body:JSON.stringify(action)}:{}),signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('Official action failed: '+response.status);return response.json()}
 let state=await api('/api/state'),steps=0
 const start=(await api('/frontend-api/v1/view')).actions.find(a=>a.label.startsWith('开始 '));if(!start)throw Error('Missing prologue start')
 state=await api('/api/perform',start.action)
 while(state.activity?.game?.active){const next=(await api('/frontend-api/v1/view')).actions.find(a=>a.label==='继续');if(!next||++steps>112)throw Error('Invalid prologue cursor');state=await api('/api/perform',next.action);if(state.error)throw Error('Prologue failed')}
 if(state.debug.providerCalls!==0||state.transcript.filter(line=>line.player).length!==5||state.transcript.at(-1)?.text!=='你愿意让我们暂时留下来吗？')throw Error('Prologue handover mismatch')
 prologue={steps,playerExpressions:5,providerCalls:0,phase:state.activity.game.phase,customFrontendMatches:true}
 console.log('Bundled official prologue passed')
}
await request({operation:'stop'});await writeFile(join(data,'smoke-result.json'),JSON.stringify({fresh:true,packLoaded:true,instanceCreated:true,modelConnection:connection.message,coreStarted:true,coreStopped:true,frontendMatchesSource:true,packName,...(prologue?{prologue}:{})},null,2));console.log('Portable Node/Core smoke passed')
}finally{child.stdin.end();if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve))}
const python=spawn(join(runtime,'python/python.exe'),['-I','-B',resolve('scripts/release/verify-python.py'),runtime],{cwd:runtime,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
let output='',error='';python.stdout.on('data',s=>output+=s);python.stderr.on('data',s=>error+=s);const code=await new Promise(resolve=>python.once('exit',resolve));if(code!==0)throw Error('Python smoke failed: '+error.slice(-1500));await writeFile(join(data,'python-result.json'),output);console.log(output.trim())
