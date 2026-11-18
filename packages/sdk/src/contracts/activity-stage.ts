import type { WorldJsonObject } from './world-json.ts'
/** Finite display data bound to one authorized activity revision. No executable code or asset paths. */
export interface ActivityStageView {
  readonly renderer: string
  readonly activityKey: string
  readonly activityId: string
  readonly revision: number
  readonly payload: WorldJsonObject
}

/** Browser presentation only, derived from fields the default player view already holds. */
export interface ActivityStagePresentation {
  readonly phase: 'ready' | 'submitting' | 'responding' | 'processing' | 'unconfirmed' | 'error'
  readonly resources?: readonly string[]
  readonly retry?: () => void
}

/** Trusted bundled renderer, instantiated inside the existing sandbox; never supplied by a world pack. */
export interface ActivityStageRenderContext {
  readonly identity: string
  readonly actions: readonly {
    readonly id: string
    readonly label: string
    readonly argumentSchema?: WorldJsonObject
  }[]
  readonly disabled: boolean
  readonly reading: boolean
  readonly dialogue: string
  readonly notice: string
  readonly presentation?: ActivityStagePresentation
  perform(optionId: string, args?: Record<string, unknown>): void
  read(): void
}
export interface ActivityStageRenderer {
  readonly moduleId: string
  readonly id: string
  readonly style: string
  readonly presentation?: { readonly readingTitle: string; readonly selfStatusKeys: readonly string[] }
  /** Must be a self-contained browser factory; compiled into the trusted builtin asset, never eval'd. */
  create(root: HTMLElement): {
    update(payload: WorldJsonObject, context: ActivityStageRenderContext): void
    dispose?(): void
  }
}
