/** Optional bridge to a trusted HTTP service accepting FrontendSpeechInput and returning audio. */
export default function httpSpeech(ctx) {
  const endpoint = new URL(process.env.PERSPECTRA_TTS_ENDPOINT || '')
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new TypeError('TTS endpoint must use HTTP or HTTPS')
  const apiKey = process.env.PERSPECTRA_TTS_API_KEY
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
