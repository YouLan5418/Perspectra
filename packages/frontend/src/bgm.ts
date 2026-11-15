import type { FrontendBgmTrack, FrontendSpeechInput } from '@harness-world/contracts'

export type { FrontendBgmPlugin, FrontendBgmTrack } from '@harness-world/contracts'

export interface FrontendBgmService {
  selectTrack(input: FrontendSpeechInput, signal: AbortSignal): Promise<{ id: string; title: string } | null>
  getTrack(id: string): FrontendBgmTrack | undefined
}

/** Shared audio bounds; BGM is deliberately buffered rather than streamed. */
export function validBgmTrack(track: FrontendBgmTrack): boolean {
  return (
    !!track &&
    typeof track.id === 'string' &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(track.id) &&
    typeof track.title === 'string' &&
    track.title.length > 0 &&
    track.title.length <= 120 &&
    ['audio/mpeg', 'audio/ogg', 'audio/wav'].includes(track.contentType) &&
    track.bytes instanceof Uint8Array &&
    track.bytes.byteLength > 0 &&
    track.bytes.byteLength <= 32 * 1024 * 1024
  )
}
