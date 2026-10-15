import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const goalProgressScenarios=['bounded-search','arrival-only','rest'] as const
export function goalProgressPacks(root:string) {
 mkdirSync(root,{recursive:true})
 for(const name of goalProgressScenarios) {
  const path=join(root,name);cpSync(resolve('examples/world-packs/character-autonomy'),path,{recursive:true})
  const read=(file:string)=>JSON.parse(readFileSync(join(path,file),'utf8'))
  const write=(file:string,value:unknown)=>writeFileSync(join(path,file),JSON.stringify(value,null,2)+'\n')
  const characters=read('characters.json')
  characters.characters.find((c:{characterId:string})=>c.characterId==='character:friend').portrayal={summary:'档案研究者，有自己的节奏，目标是核实并取得摘要原件。只依据亲自执行的结果和授权信息判断；也可询问、休息、等待和放弃，不替其他人决定行为。',speakingStyle:'自然简洁，不需要每次汇报计划。'}
  characters.characters.find((c:{characterId:string})=>c.characterId==='character:companion').portrayal={summary:'在前室休息的同行者，与玩家熟悉，眼下愿意讨论午饭和日常安排，有自己的意见，也可以询问或保持沉默。',speakingStyle:'自然简短，不需要汇报任务。'}
  write('characters.json',characters)
  const entities=read('entities.json')
  entities.entities.find((e:{entityId:string})=>e.entityId==='entity:brass-key').kind='《双途疗咒摘要》原件，正文可核实；目前在前室桌上。'
  for(const [id,label] of [['west-shelf','西侧目录架，摘要分栏'],['index','借阅索引，记录档案外借线索']])entities.entities.push({entityId:`entity:${id}`,locationId:'location:back-room',kind:label,
   interactionBindings:[{bindingId:`binding:${id}-inspect`,definition:{id:'experiment:inspect-shelf',version:1},config:{}}]})
  write('entities.json',entities)
  const interactions=read('interactions.json')
  interactions.packages.push({id:'package:goal-progress-investigation',version:1})
  interactions.definitions.push({id:'experiment:inspect-shelf',version:1})
  write('interactions.json',interactions)
  const cognition=read('cognition.json'),actor=cognition.characters.find((c:{characterId:string})=>c.characterId==='character:friend')
  const companion=cognition.characters.find((c:{characterId:string})=>c.characterId==='character:companion')
  companion.observations=[{key:'observation:companion-room',content:'前室是当前休息区，桌上的物品是一份摘要原件，不是钥匙。留守者在核实资料，我尚未参加其调查。',epistemicKind:'direct_observation',saliencePermille:400}]
  companion.goals=[{key:'goal:companion-rest',objective:{kind:'narrative',value:'休息并与熟悉的玩家聊午饭和日常安排；可以依据真实见闻表达自己的想法。'},priorityPermille:400,targetKeys:[],basisKeys:['observation:companion-room']}]
  actor.goals[0].objective.value='核实并取得《双途疗咒摘要》原件。已知初步路线是后室档案区的西侧目录架；这只是线索，不保证原件在此。结合实际反馈决定下一步，也可以等待、请求帮助或放弃。'
  actor.observations.push({key:'observation:investigation-route',content:name==='rest'?'刚才抵达前室休息区。今天安排并不着急，眼下是休息与日常交流的时间，可以自行决定是否继续调查。':'后室档案区有西侧目录架和借阅索引。摘要原件可能有线索，尚不知道实际在哪。',epistemicKind:'direct_observation',saliencePermille:600})
  write('cognition.json',cognition)
  const memory=read('memory.json')
  for(const row of memory.characters)row.attentionTopics=row.attentionTopics.map((topic:string)=>topic==='钥匙'?'摘要':topic)
  write('memory.json',memory)
  const autonomy=read('autonomy.json')
  autonomy.characters[0].interactions=['base:take','base:drop','base:give','experiment:inspect-shelf']
  autonomy.characters[0].targetIds=['entity:brass-key','entity:thermos','entity:west-shelf','entity:index','character:player','character:companion']
  write('autonomy.json',autonomy)
 }
}
