import type { ProviderProtocol } from './protocol.ts'
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'
export function thinkingLevel(value: unknown): ThinkingLevel {
  if (value === undefined) return 'off'
  if (value !== 'off' && value !== 'low' && value !== 'medium' && value !== 'high') throw new TypeError('思考强度须为关闭、低、中或高。')
  return value
}
export function thinkingRequest(protocol: ProviderProtocol, model: string, level: ThinkingLevel): Record<string, unknown> {
  if (level === 'off' && /gemini-(?:[3-9]|2\.5-pro)/i.test(model)) throw new TypeError('此 Gemini 型号不支持完全关闭思考，请选择低、中或高。')
  if (protocol === 'openai') {
    if (model.toLowerCase().includes('deepseek')) return level === 'off' ? {thinking:{type:'disabled'}}
      : {thinking:{type:'enabled'},reasoning_effort:{low:'low',medium:'high',high:'max'}[level]}
    return {reasoning_effort:level === 'off' ? 'none' : level}
  }
  if (protocol === 'anthropic') return {thinking: level === 'off' ? {type:'disabled'}
    : {type:'enabled',budget_tokens:{low:1024,medium:4096,high:16384}[level]}}
  const gemini3 = /gemini-[3-9]/i.test(model)
  if ((gemini3 || /gemini-2\.5-pro/i.test(model)) && level === 'off') throw new TypeError('此 Gemini 型号不支持完全关闭思考，请选择低、中或高。')
  return {thinkingConfig:gemini3 ? {thinkingLevel:level} : {thinkingBudget:{off:0,low:1024,medium:4096,high:16384}[level]}}
}
