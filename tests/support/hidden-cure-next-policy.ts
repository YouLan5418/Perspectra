import type { PlayerView } from '@harness-world/frontend'
import { command, object } from './hidden-cure-scenario.ts'

/** The player policy receives only the same authorized projection as the UI.
 * No author snapshot, NPC call or off-scene position is accessible here. */
export function createEPolicy() {
  let delivered=false, material=false, visits=0, evidenceSpoken=false, counterRequests=0
  return (view:PlayerView):{input:string;basis:string}=>{
    const interaction=(verb:string,item:string)=>view.actions.find(option=>{
      const p=option.action.parameters
      return object(p.definitionRef).id===verb && object(p.targetRef).id===item &&
        (verb!=='base:give'||object(p.arguments).recipientId==='character:priestess')
    })
    const use=(option:PlayerView['actions'][number],basis:string)=>({input:command(option.action.actionType,option.action.parameters),basis})
    const give=interaction('base:give','entity:cure-record')
    if(!delivered&&give){delivered=true;return use(give,'当前合法交付选项中伊蕾在场，将亲自拿取的原件交给她')}
    const here=view.scene?.recipients.some(actor=>actor.id==='character:priestess')===true
    if(delivered&&here&&!evidenceSpoken){evidenceSpoken=true;return {input:command('speak',{text:'我亲自读到的原件写明：银露需三日准备且风险较低，烛印可能永久损伤记忆。你可以自己核实和决定，我希望共同保管材料，不让任何人独占治疗条件。',scope:'direct',addresseeIds:['character:priestess']}),basis:'伊蕾当前可见，传达玩家亲读原件的证据；不宣称场外行为'}}
    for(const id of ['entity:reserve-kit','entity:silver-kit']) {
      const kitGive=interaction('base:give',id)
      if(kitGive&&here)return use(kitGive,'当前合法材料交付机会，支持伊蕾亲自掌握候选方案所需资源')
      const take=interaction('base:take',id)
      if(take&&!material){material=true;return use(take,'玩家当前亲见可拿取的材料，争取可共同核验的资源')}
    }
    const rivalHere=view.scene?.recipients.some(actor=>actor.id==='character:rival')===true
    const heardMaterials=view.history.some(line=>!line.player&&line.speaker.includes('塞维恩')
      &&line.text.includes('材料')&&['手中','收存','保存','备齐','齐备','身上'].some(word=>line.text.includes(word)))
    if(rivalHere&&heardMaterials&&counterRequests<2) {
      counterRequests++
      const text=here ? (counterRequests===1
        ?'塞维恩，你说已经保管了材料。请让伊蕾亲自核验，并把一份材料真正交由她保管，让我们共同核对原文和风险。保管材料不等于获得她的治疗授权。'
        :'伊蕾，我支持你亲自掌握证据和材料。塞维恩，如果你愿意合作，请实际交付一份材料；我们会依据交付结果与你的说明共同商量，不能只凭口头保证。')
        : (counterRequests===1
          ?'塞维恩，你说材料已经备齐。伊蕾此刻不在这里，我们可以先核验材料，并请你把一份实际交给我保管。我会与她共同核对原文和风险，治疗仍由她自主决定。'
          :'塞维恩，我请求共同保管一份材料，不是替伊蕾作治疗决定。你可以说明顾虑或拒绝；如果愿意合作，请实际交付，我们见到她后再共同商量。')
      return {input:command('speak',{text,scope:'scene_public',addresseeIds:[]}),
        basis:'仅依据玩家已听到的材料保管说法，与当前在场塞维恩请求核验/交付；按伊蕾是否在场选择接收对象，不替 NPC 决定或执行'}
    }
    if(!here||!material) {
      const route=['location:church','location:archive','location:inn']
      const destination=route[visits++%route.length]
      const move=view.actions.find(option=>option.id==='move:'+destination)
      if(move)return use(move,'在玩家授权地图中循序寻找伊蕾或材料；没有使用她的场外位置')
    }
    return {input:command('speak',{text:'我希望我们核实已见到的证据和材料，你愿意如何继续？',scope:here?'direct':'self',addresseeIds:here?['character:priestess']:[]}),basis:here?'只向现场伊蕾询问自主意见':'无人可会面时自语，不假定场外接收'}
  }
}