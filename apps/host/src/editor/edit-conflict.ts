import type { EditorGraph } from './activity-graph.ts'
export class EditConflict extends Error {
  recordCandidate?: {
    base: import('@perspectra/world-pack/editor-fields').Values
    values: import('@perspectra/world-pack/editor-fields').Values
  }
  candidate?: { base: EditorGraph; graph: EditorGraph }
  details() {
    return {
      error: this.message,
      field: this.field,
      base: this.base,
      current: this.current,
      proposed: this.proposed,
      candidate: this.candidate,
      recordCandidate: this.recordCandidate,
    }
  }
  constructor(
    readonly field: string,
    readonly base: unknown,
    readonly current: unknown,
    readonly proposed: unknown,
  ) {
    super('字段已更改：' + field)
  }
}
