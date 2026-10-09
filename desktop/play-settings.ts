/** Local player settings; never change a pack, its rules or committed world facts. */
export const PLAY_SETTING_FIELDS = [
 {key:'playerInputCharacters',label:'玩家输入字符上限',default:2000,min:100,max:16000,group:'表达与等待'},
 {key:'publicationCharacters',label:'角色单次发布字符上限',default:2000,min:100,max:16000,group:'表达与等待'},
 {key:'modelTimeoutSeconds',label:'单次模型请求超时（秒）',default:60,min:5,max:300,group:'表达与等待'},
 {key:'activationTimeoutSeconds',label:'单角色激活总时限（秒）',default:120,min:5,max:600,group:'表达与等待'},
 {key:'maximumWaves',label:'反应周期最多波次',default:3,min:1,max:10,group:'普通反应周期'},
 {key:'maximumNpcCalls',label:'NPC 模型调用总预算',default:8,min:2,max:40,group:'普通反应周期'},
 {key:'maximumCallsPerCharacter',label:'每角色最多激活次数',default:2,min:1,max:10,group:'普通反应周期'},
 {key:'reactionDeadlineSeconds',label:'全部角色反应总时限（秒）',default:120,min:5,max:300,group:'普通反应周期'},
 {key:'activityOpportunities',label:'活动连续处理机会',default:4,min:1,max:20,group:'Activity'},
 {key:'activityDeadlineSeconds',label:'活动处理总时限（秒）',default:90,min:5,max:600,group:'Activity'},
 {key:'memoryTriggerTokens',label:'整理触发阈值（估算 Token）',default:170000,min:4000,max:1000000,group:'Core 记忆'},
 {key:'memoryCompactTokens',label:'单批整理目标（估算 Token）',default:120000,min:1000,max:900000,group:'Core 记忆'},
 {key:'memoryRecentTokens',label:'近期原文保留目标（估算 Token）',default:16000,min:0,max:500000,group:'Core 记忆'},
 {key:'memoryMaxItems',label:'长期记忆最多交付条数',default:6,min:1,max:30,group:'Core 记忆'},
 {key:'memoryMaxJsonChars',label:'长期记忆交付体积（JSON 字符）',default:12000,min:1000,max:64000,group:'Core 记忆'},
] as const
export type PlaySettings = Record<typeof PLAY_SETTING_FIELDS[number]['key'], number>
export const DEFAULT_PLAY_SETTINGS = Object.fromEntries(PLAY_SETTING_FIELDS.map(field=>[field.key,field.default])) as PlaySettings
export function playSettings(value: unknown): PlaySettings {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('游玩参数必须是对象。')
 const record=value as Record<string,unknown>,result={...DEFAULT_PLAY_SETTINGS}
 if(Object.keys(record).some(key=>!PLAY_SETTING_FIELDS.some(field=>field.key===key)))throw new TypeError('存在未知游玩参数。')
 for(const field of PLAY_SETTING_FIELDS){
  const v=record[field.key]===undefined?field.default:record[field.key]
  if(typeof v!=='number'||!Number.isSafeInteger(v)||v<field.min||v>field.max)throw new TypeError(`${field.label}必须是 ${field.min}–${field.max} 的整数。`)
  result[field.key]=v
 }
 if(result.memoryCompactTokens>=result.memoryTriggerTokens)throw new TypeError('单批整理目标必须小于整理触发阈值。')
 if(result.memoryRecentTokens>=result.memoryTriggerTokens)throw new TypeError('近期原文保留目标必须小于整理触发阈值。')
 return result
}
export interface ReadingPreferences {fontSize:number;lineHeight:number;autoFollow:boolean}
export const DEFAULT_READING: ReadingPreferences={fontSize:17,lineHeight:1.9,autoFollow:true}
export function readingPreferences(value:unknown):ReadingPreferences{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('阅读设置无效。')
 const v=value as Record<string,unknown>
 if(Object.keys(v).sort().join(',')!=='autoFollow,fontSize,lineHeight'||typeof v.fontSize!=='number'||!Number.isInteger(v.fontSize)||v.fontSize<14||v.fontSize>28
 ||typeof v.lineHeight!=='number'||!Number.isFinite(v.lineHeight)||v.lineHeight<1.4||v.lineHeight>2.4||typeof v.autoFollow!=='boolean')throw new TypeError('阅读字号须为 14–28，行距须为 1.4–2.4。')
 return {fontSize:v.fontSize,lineHeight:v.lineHeight,autoFollow:v.autoFollow}
}
