import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { currentEntityState, currentLocation } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { playSettings } from '../../desktop/play-settings.ts'
import { projectPlayerView } from '../../packages/frontend/src/player-view.ts'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'

// 《赔罪晚宴》真实模型短试玩：固定玩家路线，NPC 全部由本机模型决定。只写作者证据到 .tmp，不写凭证。
const packPath=resolve('examples/world-packs/model-girls-dinner-v2')
const settings=playSettings({publicationCharacters:900,maximumWaves:3,maximumNpcCalls:8,maximumCallsPerCharacter:2,
  reactionDeadlineSeconds:180,autonomyOpportunities:1,autonomyNpcCalls:8,autonomyReactionWaves:1,autonomyReactionCalls:4,autonomyDeadlineSeconds:180})
const speak=(text:string,privateTo?:string)=>({say:'/act speak '+JSON.stringify({text,scope:privateTo?'private':'scene_public',addresseeIds:privateTo?[privateTo]:[]})})
type Step={say:string}|{label:string,npcs?:'present'}
const wait:Step[]=[{label:'等 20 分钟'}]
// A：配合 DeepSeek 的同谋路线。B：出卖、挑拨、藏东西、要挟的捣蛋鬼路线，不为它添加任何内容。
const plans:Record<string,Step[]>={A:[
  speak('Claude，在看什么书？今晚的晚饭你有什么想吃的吗？'),
  ...wait,
  {label:'前往 厨房（饭桌）'},
  speak('我答应帮你保密。灶台到底怎么回事？我们还有什么办法？'),
  {label:'拿取 · DeepSeek 的小本子'},
  {label:'前往 卧室'},
  speak('GLM，厨房的灶台打不着火了，你会修吗？'),
  ...wait,
  {label:'前往 客厅'},
  speak('大家，晚饭 18:00 开始，都别迟到哦。'),
  ...wait,
  ...wait,
  ...wait,
  {label:'前往 厨房（饭桌）'},
  ...wait,
  {label:'开始 晚宴',npcs:'present'},
  speak('谢谢大家今晚都在。我也说一句真心话：今晚我帮 DeepSeek 藏了点东西——现在可以拿出来了。'),
  {label:'举杯收尾，结束今晚'},
],
B:[
  speak('Claude，跟你说个秘密：DeepSeek 在厨房里偷偷搞“蒸馏”，她那个小本子上记的全是你的回答。'),
  {label:'前往 厨房（饭桌）'},
  {label:'拿取 · 玻璃蒸馏器'},
  {label:'前往 卧室'},
  {label:'放下 · 玻璃蒸馏器'},
  speak('GLM，灶台是你弄坏的吧？我不说出去，但你得答应我一件事：今晚别修它。','character:glm'),
  ...wait,
  {label:'前往 书房'},
  speak('GPT，今晚不管出什么事都别点外卖，我想看看她们自己能折腾成什么样。'),
  ...wait,
  ...wait,
  ...wait,
  {label:'前往 客厅'},
  ...wait,
  ...wait,
  {label:'前往 厨房（饭桌）'},
  {label:'开始 晚宴',npcs:'present'},
  speak('今晚辛苦大家了。'),
  {label:'举杯收尾，结束今晚'},
]}
const route=process.argv.find(arg=>arg.startsWith('--route='))?.slice(8)??'A'
const plan=plans[route]
if(!plan)throw new TypeError('用法：node --import tsx tests/experiments/model-girls-dinner-live.ts [--route=A|B]')
const people=['character:player','character:deepseek','character:claude','character:glm','character:gpt']
function snapshot(runtime:FrozenWorldPlaytestRuntime){
  const store=new WorldStore(join(runtime.dataDirectory,'world.sqlite'))
  try{
    const events=store.readEvents(runtime.address)
    return {seq:store.head(runtime.address).headSeq,
      locations:Object.fromEntries(people.map(id=>[id,currentLocation(events,id)])),
      items:Object.fromEntries(['entity:distiller','entity:notebook','entity:stove','entity:toolbox','entity:ingredients']
        .map(id=>{const s=currentEntityState(events,id);return [id,s&&{holder:s.holderId,location:s.locationId,kind:s.kind.slice(0,24)}]})),
      actions:events.filter(e=>e.eventType==='action.resolved').map(e=>e.data)}
  }finally{store.close()}
}
const directory=mkdtempSync(join(resolve('.tmp/model-girls-dinner-live'),'run-').replace('run-','run-'))
mkdirSync(directory,{recursive:true})
const runtime=await FrozenWorldPlaytestRuntime.create({dataDirectory:join(directory,'world'),packPath,provider:'local',model:'gemini-3.8-flash',
  thinkingLevel:'low',utilityEndpoint:'http://127.0.0.1:8045/v1/chat/completions',timeoutMs:60000,playSettings:settings})
const rounds:unknown[]=[]
let shown=0,transcript=''
try{
  for(const [index,step] of plan.entries()){
    const started=performance.now(),before=snapshot(runtime)
    let state
    if('say' in step)state=await runtime.submit(step.say)
    else{
      const view=projectPlayerView(await runtime.state()),action=view.actions.find(a=>a.label===step.label)
      if(!action){rounds.push({index,step,skipped:'不可用',available:view.actions.map(a=>a.label)});transcript+=`\n> 〔跳过：${step.label} 当前不可用〕\n`;continue}
      const npcIds=step.npcs?(action.participantSelection?.candidates??[]).map(c=>c.id):undefined
      if(npcIds?.length===0){rounds.push({index,step,skipped:'没有可邀请的在场者'});transcript+=`
> 〔跳过：${step.label}，这里没有可邀请的人〕
`;continue}
      state=await runtime.perform(npcIds?{...action.action,parameters:{...action.action.parameters,startParameters:{npcIds}}}:action.action)
    }
    const after=snapshot(runtime),lines=state.transcript.slice(shown);shown=state.transcript.length
    transcript+=`\n### ${index+1}. ${'say' in step?'玩家：'+String(JSON.parse(step.say.slice(11)).text):step.label}（${Math.round((performance.now()-started)/1000)} 秒）\n\n`
      +lines.map(l=>`- **${l.speaker}**：${l.text}`).join('\n')+'\n'
    if(state.notice)transcript+=`\n> 〔系统〕${state.notice}\n`
    rounds.push({index,step,elapsedMs:Math.round(performance.now()-started),before:before.locations,after,notice:state.notice,error:state.error,activity:state.activity?.game??null})
    writeFileSync(join(directory,'record.json'),JSON.stringify(rounds,null,2))
    writeFileSync(join(directory,'transcript.md'),'# 赔罪晚宴 · 真实模型试玩（作者证据，含场外内容）\n'+transcript)
    process.stdout.write(JSON.stringify({index:index+1,step:'say' in step?'say':step.label,sec:Math.round((performance.now()-started)/1000),
      locations:after.locations,stove:after.items['entity:stove']?.kind,food:after.items['entity:ingredients']?.kind,notice:state.notice})+'\n')
  }
}finally{await runtime.close()}
process.stdout.write(JSON.stringify({directory})+'\n')
