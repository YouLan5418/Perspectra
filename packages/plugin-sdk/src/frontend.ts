import type {
  FrontendBgmPlugin,
  FrontendBgmTrack,
  FrontendSpeechAudio,
  FrontendSpeechInput,
} from '@harness-world/frontend'

export type SpeechInput = FrontendSpeechInput
export type SpeechAudio = FrontendSpeechAudio
export type BgmTrack = FrontendBgmTrack
export type BgmPlugin = FrontendBgmPlugin

/** `ctx.frontendServices`: one speech and one BGM provider at a time. Wrap each call in `ctx.effect()`. */
export interface FrontendServicesApi {
  registerSpeech(synthesize: (input: SpeechInput, signal: AbortSignal) => Promise<SpeechAudio>): () => void
  registerBgm(plugin: BgmPlugin): () => void
}
