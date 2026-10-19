import {
  compareWorldText,
  type ManifestationChannel,
  type ManifestationCueProposal,
  type ManifestationProposal
} from '@harness-world/contracts'

const MANIFESTATION_CHANNELS = new Set<ManifestationChannel>([
  'facial', 'gaze', 'posture', 'gesture', 'voice', 'appearance',
])

const PERSISTENT_MANIFESTATION_CHANNELS = new Set<ManifestationChannel>(['posture', 'appearance'])

const utf8 = new TextEncoder()

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const keys = Object.keys(value).sort(compareWorldText)
  const sorted = [...expected].sort(compareWorldText)
  if (keys.length !== sorted.length || keys.some((key, index) => key !== sorted[index])) {
    throw new TypeError(`${path} contains missing or unknown fields`)
  }
}

function exactWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !(key in value)) || keys.some(key => !allowed.has(key))) {
    throw new TypeError(`${path} contains missing or unknown fields`)
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw new TypeError(`${path} must be a non-empty string`)
  return value
}

function boundedText(value: unknown, path: string, maximumBytes: number): string {
  const parsed = text(value, path)
  if (utf8.encode(parsed).byteLength > maximumBytes) throw new TypeError(`${path} exceeds ${maximumBytes} UTF-8 bytes`)
  return parsed
}

/** Strict parser for manual-player manifestation proposals. */
export function parseManifestationProposal(value: unknown): ManifestationProposal {
  const root = record(value, 'submit_actions.manifestation')
  exactWithOptional(root, ['cues'], ['description'], 'submit_actions.manifestation')
  if (!Array.isArray(root.cues) || root.cues.length === 0 || root.cues.length > 8) {
    throw new TypeError('submit_actions.manifestation.cues must contain between 1 and 8 entries')
  }
  const cues = root.cues.map((entry, index): ManifestationCueProposal => {
    const cue = record(entry, `manifestation.cues[${index}]`)
    const persistence = cue.persistence
    if (persistence === 'event_only') {
      exact(cue, ['cueId', 'channel', 'description', 'persistence'], `manifestation.cues[${index}]`)
    } else if (persistence === 'until_changed') {
      exact(cue, ['cueId', 'channel', 'description', 'persistence', 'stateKey', 'operation'], `manifestation.cues[${index}]`)
    } else {
      throw new TypeError(`manifestation.cues[${index}].persistence is unsupported`)
    }
    const cueId = boundedText(cue.cueId, `manifestation.cues[${index}].cueId`, 128)
    const channel = cue.channel
    if (typeof channel !== 'string' || !MANIFESTATION_CHANNELS.has(channel as ManifestationChannel)) {
      throw new TypeError(`manifestation.cues[${index}].channel is unsupported`)
    }
    const description = boundedText(cue.description, `manifestation.cues[${index}].description`, 512)
    if (persistence === 'event_only') return { cueId, channel: channel as ManifestationChannel, description, persistence }
    if (!PERSISTENT_MANIFESTATION_CHANNELS.has(channel as ManifestationChannel)) {
      throw new TypeError('until_changed manifestation is limited to posture and appearance')
    }
    const stateKey = boundedText(cue.stateKey, `manifestation.cues[${index}].stateKey`, 128)
    if (cue.operation !== 'set' && cue.operation !== 'clear') throw new TypeError(`manifestation.cues[${index}].operation is unsupported`)
    return {
      cueId, channel: channel as 'posture' | 'appearance', description,
      persistence, stateKey, operation: cue.operation,
    }
  })
  if (new Set(cues.map(cue => cue.cueId)).size !== cues.length) throw new TypeError('manifestation cueId values must be unique')
  return {
    ...(root.description === undefined ? {} : { description: boundedText(root.description, 'submit_actions.manifestation.description', 2048) }),
    cues,
  }
}
