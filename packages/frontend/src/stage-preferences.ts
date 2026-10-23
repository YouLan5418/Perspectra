/** Embedded in the host and default stage; keep this function self-contained. */
export function stagePreferences(value: unknown, defaults: unknown = {}) {
  const base = defaults && typeof defaults === 'object' ? (defaults as Record<string, unknown>) : {}
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const fields = { ...base, ...input }
  const helpers = {
    number(key: string, fallback: number, min: number, max: number, integer = false) {
      const n = fields[key]
      return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n))
        ? n
        : fallback
    },
    boolean(key: string, fallback: boolean) {
      return typeof fields[key] === 'boolean' ? fields[key] : fallback
    },
  }
  return {
    fontSize: helpers.number('fontSize', 19, 14, 28, true),
    lineHeight: helpers.number('lineHeight', 1.9, 1.4, 2.4),
    autoFollow: helpers.boolean('autoFollow', true),
    autoSpeed: helpers.number('autoSpeed', 1, 0.5, 2),
    volume: helpers.number('volume', 80, 0, 100, true),
    muted: helpers.boolean('muted', false),
    voiceEnabled: helpers.boolean('voiceEnabled', false),
    appearance: ['system', 'light', 'dark'].includes(String(fields.appearance)) ? String(fields.appearance) : 'system',
  }
}
