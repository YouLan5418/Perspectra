export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'
export function thinkingLevel(value: unknown): ThinkingLevel {
  if (value === undefined) return 'off'
  if (value !== 'off' && value !== 'low' && value !== 'medium' && value !== 'high')
    throw new TypeError('思考强度须为关闭、低、中或高。')
  return value
}
