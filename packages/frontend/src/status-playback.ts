import type { PlayerPanel, PlayerView } from './player-view.ts'

type StatusView = Pick<PlayerView, 'statusBar' | 'panels' | 'history'>
type StatusSnapshot = {
  statusBar: NonNullable<PlayerView['statusBar']>
  panels: NonNullable<PlayerView['panels']>
}

/** Embedded with toString, so all runtime helpers live here. A live view may withdraw an
 * observed row during an unread batch, but only a settled read position may add or update one. */
export function createStatusPlayback() {
  let current: StatusSnapshot | null = null
  let history: string[] = []
  let checked: StatusView | undefined
  let wasSettled = false

  const helpers = {
    rowId(entry: { holderId: string | null; key: string }) {
      return JSON.stringify([entry.holderId, entry.key])
    },
  }

  return {
    invalidate() {
      current = null
      history = []
      checked = undefined
    },
    update(view: StatusView | undefined, settled: boolean) {
      if (!view || (checked === view && wasSettled === settled)) return current
      checked = view
      wasSettled = settled
      if (settled) {
        history = view.history.map(row => JSON.stringify(row))
        current = structuredClone({ statusBar: view.statusBar ?? [], panels: view.panels ?? [] })
      } else if (current) {
        if (history.some((row, index) => row !== JSON.stringify(view.history[index]))) {
          current = null
          history = []
          return current
        }
        const visibleStatus = new Set((view.statusBar ?? []).map(helpers.rowId))
        const visiblePanels = new Map((view.panels ?? []).map(panel => [panel.id, panel]))
        current = {
          statusBar: current.statusBar.filter(row => visibleStatus.has(helpers.rowId(row))),
          panels: current.panels.flatMap<PlayerPanel>(panel => {
            const visible = visiblePanels.get(panel.id)
            if (panel.kind === 'property-table' && visible?.kind === 'property-table') {
              const keys = new Set(visible.properties.map(row => row.key))
              return [{ ...panel, properties: panel.properties.filter(row => keys.has(row.key)) }]
            }
            if (panel.kind === 'entry-list' && visible?.kind === 'entry-list') {
              const ids = new Set(visible.entries.map(row => row.id))
              return [{ ...panel, entries: panel.entries.filter(row => ids.has(row.id)) }]
            }
            return []
          }),
        }
      }
      return current
    },
  }
}
