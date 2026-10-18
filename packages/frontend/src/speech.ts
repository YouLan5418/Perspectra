import type { CharacterId, ExpressionSegment } from '@harness-world/contracts'
import type { PlayerView } from './player-view.ts'

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
/** Optional host service; implementations own provider configuration and any cache. */
export interface FrontendHostServices {
  synthesizeSpeech?: ((input: FrontendSpeechInput, signal: AbortSignal) => Promise<FrontendSpeechAudio>) | undefined
}

export function frontendSpeechInput(view: PlayerView, value: unknown): FrontendSpeechInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('语音请求无效')
  const request = value as Record<string, unknown>
  if (Object.keys(request).sort().join(',') !== 'segmentIndex,seq,text'
    || !Number.isSafeInteger(request.seq) || Number(request.seq) < 0
    || !Number.isSafeInteger(request.segmentIndex) || Number(request.segmentIndex) < 0
    || typeof request.text !== 'string') throw new TypeError('语音请求须引用已授权的发表段落')
  const line = view.history.find(line => line.seq === request.seq)
  const segments = line?.segments?.length ? line.segments : line ? [{ type: 'speech' as const, text: line.text }] : []
  const segment = segments[Number(request.segmentIndex)]
  if (!line || !segment?.text.trim() || segment.text !== request.text) throw new TypeError('语音段落不存在或已变化')
  return { seq: line.seq, segmentIndex: Number(request.segmentIndex), text: segment.text, type: segment.type,
    ...(line.speakerId === undefined ? {} : { speakerId: line.speakerId }) }
}
