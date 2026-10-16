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
 {key:'autonomyOpportunities',label:'每角色自主处理机会',default:1,min:0,max:10,group:'自主行动'},
 {key:'autonomyNpcCalls',label:'自主行动模型调用总预算',default:3,min:2,max:40,group:'自主行动'},
 {key:'autonomyReactionWaves',label:'自主行动后最多反应波次',default:1,min:0,max:10,group:'自主行动'},
 {key:'autonomyReactionCalls',label:'自主行动后反应调用总预算',default:4,min:2,max:40,group:'自主行动'},
 {key:'autonomyDeadlineSeconds',label:'自主行动及后续反应总时限（秒）',default:60,min:5,max:300,group:'自主行动'},
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

/** 界面主题色；只改变启动器、官方舞台与控制台的配色，不影响游戏内容。 */
export const PALETTES = ['sakura', 'lamp', 'moon', 'forest'] as const
export type Palette = typeof PALETTES[number]
export const DEFAULT_PALETTE: Palette = 'sakura'
export function palettePreference(value: unknown): Palette {
 if (typeof value !== 'string' || !(PALETTES as readonly string[]).includes(value)) throw new TypeError('主题色无效。')
 return value as Palette
}

/** Presentation preferences only. Templates decide whether to provide audio playback. */
export interface AudioPreferences {volume:number;muted:boolean;voiceEnabled:boolean}
export const DEFAULT_AUDIO: AudioPreferences={volume:80,muted:false,voiceEnabled:false}
export function audioPreferences(value:unknown):AudioPreferences{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('音频设置无效。')
 const v=value as Record<string,unknown>
 if(Object.keys(v).sort().join(',')!=='muted,voiceEnabled,volume'||typeof v.volume!=='number'||!Number.isInteger(v.volume)||v.volume<0||v.volume>100
 ||typeof v.muted!=='boolean'||typeof v.voiceEnabled!=='boolean')throw new TypeError('音量须为 0–100 的整数，静音和语音开关须为布尔值。')
 return {volume:v.volume,muted:v.muted,voiceEnabled:v.voiceEnabled}
}
