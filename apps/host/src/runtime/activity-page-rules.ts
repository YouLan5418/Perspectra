import type { PlayerView } from '@perspectra/frontend'
import type { Scalar } from '@perspectra/world-pack/editor-fields'

export type PageStep = string | { by: 'id' | 'key'; is: string }
export type PageField =
  | { source: 'phase' }
  | { source: 'held' | 'world' | 'available'; key: string }
  | { source: 'public' | 'personal' | 'stage'; path: PageStep[]; relativeTo?: string }
export interface PageRule {
  field: PageField
  compare: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
  value: Scalar
  effect: { kind: 'show' } | { kind: 'class' | 'image'; value: string }
}
export interface PageElement {
  id: string
  operation?: string
  rules?: PageRule[]
}

/** Standalone because the trusted browser client embeds this same evaluator. Only walk the player's projection. */
export function pageFieldValue(field: PageField, view: PlayerView): unknown {
  const active = view.activity
  if (!active?.active) return undefined
  switch (field.source) {
    case 'phase':
      return active.phase
    case 'held':
      return view.items?.some(i => i.id === field.key && i.where === 'held') ?? false
    case 'available':
      return view.actions.some(
        o =>
          o.kind === 'activity' &&
          o.target?.kind === 'activity' &&
          o.target.id === active.key &&
          (o.action.parameters.definitionRef as { id?: string })?.id === field.key,
      )
    case 'world':
      return view.statusBar?.find(v => v.holderId === null && v.key === field.key && v.current)?.value
  }
  let value: unknown =
    field.source === 'public'
      ? active.public
      : field.source === 'personal'
        ? active.private
        : view.activityStage?.payload
  let parent: unknown
  for (const step of field.path) {
    parent = value
    if (typeof step === 'string') {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, step)) return undefined
      value = (value as Record<string, unknown>)[step]
    } else {
      if (!Array.isArray(value)) return undefined
      const rows = value.filter(v => v && typeof v === 'object' && Object.hasOwn(v, step.by) && v[step.by] === step.is)
      if (rows.length !== 1) return undefined
      value = rows[0]
    }
  }
  if (field.relativeTo) {
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, field.relativeTo)) return undefined
    const max = (parent as Record<string, unknown>)[field.relativeTo]
    if (typeof value !== 'number' || typeof max !== 'number' || max <= 0) return undefined
    return (value / max) * 100
  }
  return value
}
export function pageRuleMatches(rule: PageRule, actual: unknown): boolean {
  if (actual === undefined || typeof actual !== typeof rule.value) return false
  if (rule.compare === 'eq') return actual === rule.value
  if (rule.compare === 'ne') return actual !== rule.value
  if (typeof actual !== 'number' || typeof rule.value !== 'number' || !Number.isFinite(actual)) return false
  switch (rule.compare) {
    case 'lt':
      return actual < rule.value
    case 'lte':
      return actual <= rule.value
    case 'gt':
      return actual > rule.value
    case 'gte':
      return actual >= rule.value
  }
}
