import { canonicalizeWorldJson, type WorldJsonValue } from '@harness-world/contracts'
import type { GameplayPlayerView } from '@harness-world/plugin-sdk'

/** Validate a finite display document, after the author has received only the player's authorized state. */
export function gameplayPresentation(value: GameplayPlayerView): GameplayPlayerView {
  canonicalizeWorldJson(value as unknown as WorldJsonValue)
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 262144)
    throw new TypeError('GAMEPLAY_PRESENTATION_INVALID')
  const text = (part: unknown): part is string => typeof part === 'string' && part.length <= 16384
  const rows = <T>(parts: readonly T[] | undefined, valid: (row: T) => boolean): void => {
    if (parts === undefined) return
    if (!Array.isArray(parts) || parts.length > 256 || parts.some(row => !row || !valid(row)))
      throw new TypeError('GAMEPLAY_PRESENTATION_INVALID')
  }
  const unique = (parts: readonly { id: string }[] | undefined) => {
    if (parts && new Set(parts.map(row => row.id)).size !== parts.length)
      throw new TypeError('GAMEPLAY_PRESENTATION_DUPLICATE')
  }
  rows(value.panels, panel => {
    if (!text(panel.id) || !panel.id || !text(panel.title)) return false
    if (panel.kind === 'property-table') {
      rows(panel.properties, row => text(row.key) && text(row.label) && row.value !== undefined)
      return Array.isArray(panel.properties)
    }
    if (panel.kind === 'entry-list') {
      rows(panel.entries, row => text(row.id) && text(row.title) && text(row.content))
      unique(panel.entries)
      return Array.isArray(panel.entries)
    }
    return false
  })
  rows(value.controls, control => {
    if (
      !text(control.id) ||
      !control.id ||
      !text(control.label) ||
      (control.disabled !== undefined && typeof control.disabled !== 'boolean') ||
      (control.description !== undefined && !text(control.description)) ||
      !control.operation ||
      !text(control.operation.id) ||
      !text(control.operation.argument) ||
      !control.operation.argument
    )
      return false
    if (control.kind === 'boolean') return typeof control.value === 'boolean'
    if (control.kind === 'select') {
      rows(control.options, option => text(option.value) && text(option.label))
      return (
        Array.isArray(control.options) &&
        control.options.length > 0 &&
        new Set(control.options.map(option => option.value)).size === control.options.length &&
        control.options.some(option => option.value === control.value)
      )
    }
    return false
  })
  unique(value.panels)
  unique(value.controls)
  return structuredClone(value)
}
