import type { LensField, LensSection, LensView } from './view.ts'

type FieldValue = LensField['value']
export type LensChange =
  | { readonly kind: 'added'; readonly id: string }
  | { readonly kind: 'removed'; readonly id: string; readonly title: string; readonly section: LensSection }
  | {
      readonly kind: 'changed'
      readonly id: string
      readonly fields: readonly {
        readonly key: string
        readonly label: string
        readonly before: FieldValue | null
        readonly after: FieldValue | null
      }[]
    }

/** Array fields are compared as sets: order and duplicates do not count as a change. */
export function sameFieldValue(a: FieldValue | null, b: FieldValue | null): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const left = new Set<string>(a)
    const right = new Set<string>(b)
    return left.size === right.size && [...left].every(entry => right.has(entry))
  }
  return a === b
}

/** Compares two views item by item (matched by id, then field by key). `source` is deliberately ignored. */
export function diffLensViews(base: LensView, next: LensView): readonly LensChange[] {
  const before = new Map(base.items.map(item => [item.id, item]))
  const after = new Map(next.items.map(item => [item.id, item]))
  const changes: LensChange[] = []
  for (const item of next.items) if (!before.has(item.id)) changes.push({ kind: 'added', id: item.id })
  for (const item of base.items)
    if (!after.has(item.id)) changes.push({ kind: 'removed', id: item.id, title: item.title, section: item.section })
  for (const item of next.items) {
    const old = before.get(item.id)
    if (old === undefined) continue
    const oldFields = new Map(old.fields.map(field => [field.key, field]))
    const newFields = new Map(item.fields.map(field => [field.key, field]))
    const fields: { key: string; label: string; before: FieldValue | null; after: FieldValue | null }[] = []
    for (const field of old.fields) {
      const now = newFields.get(field.key)
      if (!sameFieldValue(field.value, now?.value ?? null))
        fields.push({ key: field.key, label: field.label, before: field.value, after: now?.value ?? null })
    }
    for (const field of item.fields)
      if (!oldFields.has(field.key))
        fields.push({ key: field.key, label: field.label, before: null, after: field.value })
    if (fields.length > 0) changes.push({ kind: 'changed', id: item.id, fields })
  }
  return changes
}
