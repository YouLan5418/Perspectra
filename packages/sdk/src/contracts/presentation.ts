import type { ExpressionSegment } from './expression.ts'
import type { CharacterId } from './ids.ts'

/** An authorized, committed reading segment. No private runtime state or credentials. */
export interface FrontendSpeechInput {
  seq: number
  segmentIndex: number
  text: string
  type: ExpressionSegment['type']
  speakerId?: CharacterId
}

export interface FrontendSpeechAudio {
  contentType: 'audio/mpeg' | 'audio/ogg' | 'audio/wav'
  bytes: Uint8Array
}

/** Explicitly published presentation assets, never paths supplied by a frontend. */
export interface FrontendBgmTrack extends FrontendSpeechAudio {
  readonly id: string
  readonly title: string
}

export interface FrontendBgmPlugin {
  readonly tracks: readonly FrontendBgmTrack[]
  /** A pure choice for this authorized reading segment. null means silence. */
  readonly selectTrack: (input: FrontendSpeechInput, signal: AbortSignal) => Promise<string | null> | string | null
}
