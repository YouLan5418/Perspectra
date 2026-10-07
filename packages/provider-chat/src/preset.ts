import { validatePresetMacros } from './preset-macros.ts'
/** User-editable portrayal settings; never transport credentials, tools or world rules. */
export interface RolePreset {
  prompt?: string
  nodes?: PromptNode[]
  textRules?: TextRule[]
  temperature?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  maxOutputTokens?: number
  stop?: string[]
}
export interface PromptNode {
  id: string
  name: string
  enabled: boolean
  role: 'system' | 'user' | 'assistant'
  position: 'beforeContext' | 'afterContext'
  content: string
}
export interface TextRule {
  id: string
  name: string
  enabled: boolean
  stage: 'input' | 'history' | 'output' | 'display'
  target: 'speech' | 'narration' | 'both'
  pattern: string
  flags: string
  replacement: string
}
export function rolePreset(value:unknown, checkMacros = true):RolePreset{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('预设必须是对象。')
 const r=value as Record<string,unknown>,out:RolePreset={}
 const keys=['nodes','textRules','prompt','temperature','topP','frequencyPenalty','presencePenalty','maxOutputTokens','stop']
 if(Object.keys(r).some(k=>!keys.includes(k)))throw new TypeError('预设包含不支持的字段。')
 if(r.prompt!==undefined){if(typeof r.prompt!=='string'||r.prompt.length>16000)throw new TypeError('附加提示最多 16000 个字符。');out.prompt=r.prompt}
 for(const [key,min,max] of [['temperature',0,2],['topP',0,1],['frequencyPenalty',-2,2],['presencePenalty',-2,2],['maxOutputTokens',1,32768]] as const){
  const value=r[key]
  if(value!==undefined){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||(key==='maxOutputTokens'&&!Number.isInteger(value)))throw new TypeError(key+' 超出范围。');out[key]=value}
 }
 if(r.stop!==undefined){if(!Array.isArray(r.stop)||r.stop.length>4||r.stop.some(v=>typeof v!=='string'||!v.length||v.length>100))throw new TypeError('停止词最多 4 条，每条 1–100 字符。');out.stop=[...r.stop] as string[]}
 if(r.nodes!==undefined)out.nodes=entries(r.nodes,64,'提示节点',v=>{
  exact(v,['id','name','enabled','role','position','content'])
  if(typeof v.role!=='string'||typeof v.position!=='string'||!['system','user','assistant'].includes(String(v.role))||!['beforeContext','afterContext'].includes(String(v.position)))throw new TypeError('节点身份或位置无效。')
  return {...identity(v),role:v.role as PromptNode['role'],position:v.position as PromptNode['position'],content:shortText(v.content,16000,'节点内容')}
 })
 for(const node of out.nodes??[])if(checkMacros && node.enabled){try{validatePresetMacros(node.content)}catch(error){throw new TypeError('提示节点「'+node.name+'」：'+(error instanceof Error?error.message:'宏语法无效。'))}}
 if((out.nodes??[]).reduce((n,v)=>n+v.content.length,out.prompt?.length??0)>32000)throw new TypeError('提示总长度最多 32000 字符。')
 if(r.textRules!==undefined)out.textRules=entries(r.textRules,32,'文本规则',v=>{
  exact(v,['id','name','enabled','stage','target','pattern','flags','replacement'])
  if(typeof v.stage!=='string'||typeof v.target!=='string'||!['input','history','output','display'].includes(String(v.stage))||!['speech','narration','both'].includes(String(v.target)))throw new TypeError('文本规则阶段或字段无效。')
  const pattern=shortText(v.pattern,1000,'正则表达式'),flags=shortText(v.flags,6,'正则标志')
  if(!pattern||!/^[gimsu]*$/.test(flags)||new Set(flags).size!==flags.length)throw new TypeError('正则表达式或标志无效。')
  try{new RegExp(pattern,flags)}catch{throw new TypeError('正则表达式无法编译。')}
  return {...identity(v),stage:v.stage as TextRule['stage'],target:v.target as TextRule['target'],pattern,flags,replacement:shortText(v.replacement,4000,'替换文本')}
 })
 return out
}
function shortText(value:unknown,max:number,label:string):string{
 if(typeof value!=='string'||value.length>max)throw new TypeError(label+'无效或过长。')
 return value
}
function exact(value:Record<string,unknown>,keys:string[]):void{
 if(Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw new TypeError('节点或规则字段无效。')
}
function identity(value:Record<string,unknown>){
 const id=shortText(value.id,100,'标识'),name=shortText(value.name,80,'名称')
 if(!id.trim()||!name.trim()||typeof value.enabled!=='boolean')throw new TypeError('标识、名称或开关无效。')
 return {id,name,enabled:value.enabled}
}
function entries<T extends {id:string}>(value:unknown,max:number,label:string,parse:(v:Record<string,unknown>)=>T):T[]{
 if(!Array.isArray(value)||value.length>max)throw new TypeError(label+'数量超限。')
 const result=value.map(v=>parse(record(v)))
 if(new Set(result.map(v=>v.id)).size!==result.length)throw new TypeError(label+'标识重复。')
 return result
}

/** Complete overrides for one instance; group membership is UI configuration, never world state. */
export interface RolePresetGroup { name: string; preset: RolePreset }
export interface RolePresetMapping {
  characters?: Record<string, RolePreset>
  groups?: Record<string, RolePresetGroup>
  memberships?: Record<string, string>
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('角色预设映射无效。')
  return value as Record<string, unknown>
}
export function characterPresets(value: unknown, checkMacros = true): Record<string, RolePreset> {
  return Object.fromEntries(Object.entries(record(value)).map(([id, preset]) => {
    if (!id || id.length > 200) throw new TypeError('角色 ID 无效。')
    return [id, rolePreset(preset, checkMacros)]
  }))
}
export function rolePresetMapping(value: unknown, checkMacros = true): RolePresetMapping {
  const data = record(value), result: RolePresetMapping = {}
  if (Object.keys(data).some(key => !['characters', 'groups', 'memberships'].includes(key))) throw new TypeError('角色映射包含不支持的字段。')
  if (data.characters !== undefined) result.characters = characterPresets(data.characters, checkMacros)
  if (data.groups !== undefined) result.groups = Object.fromEntries(Object.entries(record(data.groups)).map(([id, value]) => {
    const group = record(value)
    if (!/^[a-f0-9-]{36}$/.test(id) || Object.keys(group).sort().join(',') !== 'name,preset'
      || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80) throw new TypeError('角色组无效。')
    return [id, { name: group.name.trim(), preset: rolePreset(group.preset, checkMacros) }]
  }))
  if (data.memberships !== undefined) result.memberships = Object.fromEntries(Object.entries(record(data.memberships)).map(([id, group]) => {
    if (!id || id.length > 200 || typeof group !== 'string' || !Object.hasOwn(result.groups ?? {}, group)) throw new TypeError('角色组引用无效。')
    return [id, group]
  }))
  return result
}
export function characterPreset(base: RolePreset, mapping: RolePresetMapping, id: string): RolePreset {
  if (Object.hasOwn(mapping.characters ?? {}, id)) return mapping.characters![id]!
  const group = Object.hasOwn(mapping.memberships ?? {}, id) ? mapping.memberships![id] : undefined
  if (group && Object.hasOwn(mapping.groups ?? {}, group)) return mapping.groups![group]!.preset
  return base
}
