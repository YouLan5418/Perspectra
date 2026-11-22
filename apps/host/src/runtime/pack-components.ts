// Optional, presentation-only data for the official stage. Never forward unchecked pack values.
const regions = {
  inventory: ['index', 'toolbar', 'story'],
  nearby: ['toolbar', 'story'],
  sendAudience: ['footer-end', 'footer-inset'],
  identity: ['waist', 'above-waist'],
  location: ['heading', 'toolbar'],
  history: ['toolbar', 'story'],
  activity: ['story', 'toolbar'],
  statusSummary: ['heading', 'toolbar'],
} as const
type Component = keyof typeof regions
type Style = Partial<Record<'anchor' | 'size' | 'tone' | 'shape' | 'icon' | 'label', string>> & { order?: number }
export type PackComponents = Partial<Record<Component, Style & { narrow?: Style }>>
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const symbols = {
  inventory: ['bag'],
  nearby: ['diamond'],
  sendAudience: ['arrow'],
  identity: ['dots'],
  location: ['compass'],
  history: ['book'],
  activity: ['flag'],
  statusSummary: ['meter'],
} as const
const safeKey = (s: string) => s.replace(/[^A-Za-z0-9_-]/gu, '?').slice(0, 40)
export const stageComponents = Object.keys(regions) as Component[]
export function componentStyle(id: Component) {
  return {
    movable: ['inventory', 'nearby', 'location', 'statusSummary', 'history', 'activity'].includes(id),
    renameable: ['inventory', 'nearby', 'history', 'activity'].includes(id),
    choices: {
      anchor: regions[id],
      icon: symbols[id],
      size: ['standard', 'large'],
      tone: ['forest', 'indigo'],
      ...(id === 'sendAudience' ? {} : { shape: ['soft', 'pill'] }),
    } as Record<string, readonly string[]>,
  }
}

export function readPackComponents(
  bytes: Buffer,
  warn: (message: string) => void = console.warn,
): PackComponents | undefined {
  const issue = (s: string) => warn('frontend/components.json：' + s)
  if (bytes.length > 8192) {
    issue('超过 8 KiB，已使用默认组件。')
    return
  }
  let data: unknown
  try {
    data = JSON.parse(bytes.toString('utf8'))
  } catch {
    issue('无法解析 JSON，已使用默认组件。')
    return
  }
  if (!isRecord(data) || data.version !== 1 || !isRecord(data.components)) {
    issue('需要 version: 1 与 components 对象，已使用默认组件。')
    return
  }
  for (const key of Object.keys(data))
    if (!['version', 'components'].includes(key)) issue('忽略顶层字段 ' + safeKey(key))
  function style(id: Component, value: unknown, path: string, allowNarrow: boolean): Style & { narrow?: Style } {
    const result: Style & { narrow?: Style } = {}
    if (!isRecord(value)) {
      issue(path + ' 应为对象，已忽略。')
      return result
    }
    const { movable, renameable, choices } = componentStyle(id)
    for (const [key, v] of Object.entries(value)) {
      if (key === 'narrow' && allowNarrow) {
        const override = style(id, v, path + '.narrow', false)
        if (Object.keys(override).length) result.narrow = override
        continue
      }
      if (key === 'order' && movable && typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 9) {
        result.order = v
        continue
      }
      if (key === 'label' && renameable && typeof v === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ·-]{0,5}$/u.test(v)) {
        result.label = v
        continue
      }
      const allowed = Object.hasOwn(choices, key) ? choices[key]! : []
      if (typeof v === 'string' && allowed.includes(v)) {
        result[key as 'anchor' | 'icon' | 'size' | 'tone' | 'shape'] = v
      } else {
        const hint = allowed.length
          ? '可选 ' + allowed.join(' / ')
          : key === 'order' && movable
            ? '需要 0–9 的整数'
            : key === 'label' && renameable
              ? '需要 1–6 个字，以文字或数字开头'
              : '不支持此字段'
        issue(path + '.' + safeKey(key) + '：' + hint + '，已忽略。')
      }
    }
    return result
  }
  const result: PackComponents = {}
  for (const [id, v] of Object.entries(data.components)) {
    if (!Object.hasOwn(regions, id)) {
      issue('忽略未知组件 ' + safeKey(id))
      continue
    }
    const parsed = style(id as Component, v, id, true)
    if (Object.keys(parsed).length) result[id as Component] = parsed
  }
  return Object.keys(result).length ? result : undefined
}
