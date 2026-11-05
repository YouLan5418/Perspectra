import type { CharacterId, ExpressionSegment } from '@harness-world/contracts'

/** One line of what the player can read, exactly as the default stage receives it. */
export interface PlayerFeedLine {
  readonly seq: number
  readonly speaker: string
  readonly speakerId?: CharacterId
  readonly text: string
  readonly player: boolean
  readonly segments?: readonly ExpressionSegment[]
  /** A round the player let pass; the text is empty. */
  readonly pause?: true
}
/** `reset` replaces everything a listener holds: first publish, regeneration, candidate switch or restore. */
export type PlayerFeedEvent =
  | { readonly kind: 'append'; readonly lines: readonly PlayerFeedLine[] }
  | { readonly kind: 'reset'; readonly lines: readonly PlayerFeedLine[] }
/** `ctx.playerFeed`: read-only; nothing a listener returns reaches the world. */
export interface PlayerFeedApi {
  subscribe(listener: (event: PlayerFeedEvent) => unknown): () => void
}
