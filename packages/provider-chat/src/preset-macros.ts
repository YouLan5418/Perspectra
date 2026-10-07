/** A fresh environment for each role request; no access to world variables or files. */
export function presetMacros(values: Readonly<Record<string, string>>, random = Math.random) {
  return macroEvaluator(values, random, false)
}
/** Checks syntax without evaluating request values or expansion size. */
export function validatePresetMacros(text: string): void {
  macroEvaluator({char:'',user:'',scene:'',date:'',time:''}, () => 0, true)(text)
}
function macroEvaluator(values: Readonly<Record<string, string>>, random: () => number, syntaxOnly: boolean) {
  const variables = new Map<string, string>()
  return (text: string): string => {
    let trim = false
    const expanded = text.replace(/\{\{([\s\S]*?)\}\}/g, (_match, body: string) => {
      if (body.includes('{{')) throw new TypeError('首版不支持嵌套宏。')
      if (body.startsWith('//')) return ''
      const [kind, key, ...rest] = body.split('::')
      if (kind === 'trim') { trim = true; return '' }
      if (kind === 'setvar' && key && rest.length > 0) { if (!syntaxOnly) variables.set(key, rest.join('::')); return '' }
      if (kind === 'getvar' && key) return variables.get(key) ?? ''
      if (kind === 'random' && key !== undefined) {
        const choices = [key, ...rest]; return choices[Math.floor(random() * choices.length)]!
      }
      if (kind === 'roll' && key && /^\d{1,2}d\d{1,4}$/.test(key)) {
        const [count, sides] = key.split('d').map(Number)
        if (!count || !sides || count > 20) throw new TypeError('骰子宏范围无效。')
        if (syntaxOnly) return ''
        return String(Array.from({ length: count }, () => 1 + Math.floor(random() * sides)).reduce((a, b) => a + b, 0))
      }
      if (Object.hasOwn(values, body)) return values[body]!
      throw new TypeError('不支持的预设宏：' + body.slice(0, 80))
    })
    if (!syntaxOnly && expanded.length > 64000) throw new RangeError('宏展开后的提示过长。')
    return trim ? expanded.trim() : expanded
  }
}
