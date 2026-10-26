// The lowest host API this plugin needs (packages/plugin-sdk); an older or newer-major host skips it.
export const hostApi = '1.0'

/** Optional bridge to a trusted HTTP service accepting FrontendSpeechInput and returning audio.
 * `config` comes from the launcher form declared in http-speech.plugin.json; apiKey is a secret field. */
export default function httpSpeech(ctx, config) {
  const endpoint = new URL(config.endpoint)
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new TypeError('TTS endpoint must use HTTP or HTTPS')
  const apiKey = config.apiKey
  ctx.effect(() => ctx.frontendServices.registerSpeech(async (input, signal) => {
    const response = await fetch(endpoint, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error('TTS service failed')
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
    if (!['audio/wav', 'audio/mpeg', 'audio/ogg'].includes(contentType)) throw new Error('TTS service returned unsupported audio')
    return { contentType, bytes: new Uint8Array(await response.arrayBuffer()) }
  }))
}
