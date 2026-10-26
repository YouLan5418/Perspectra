/** Runnable Cordis example. These quiet synthesized chords are test sounds, not a finished soundtrack. */
export default function demoBgm(ctx) {
  const tracks = [
    { id: 'calm', title: '日常（示例和弦）', contentType: 'audio/wav', bytes: chord([220, 275, 330]) },
    { id: 'tense', title: '紧张（示例和弦）', contentType: 'audio/wav', bytes: chord([220, 261.6256, 311.127]) },
  ]
  ctx.effect(() => ctx.frontendServices.registerBgm({
    tracks,
    // Decide from this paragraph alone, so skipping or replacing a candidate does not depend on request order.
    selectTrack(input) {
      if (input.text.includes('停止音乐')) return null
      return /争执|危险|紧张/.test(input.text) ? 'tense' : 'calm'
    },
  }))
}

function chord(frequencies) {
  const rate = 22050, seconds = 4, samples = rate * seconds
  const buffer = new ArrayBuffer(44 + samples * 2), view = new DataView(buffer)
  const ascii = (offset, text) => [...text].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)))
  ascii(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++) {
    const t = i / rate, envelope = Math.min(1, t / 0.15, (seconds - t) / 0.25)
    const value = frequencies.reduce((sum, frequency) => sum + Math.sin(2 * Math.PI * frequency * t), 0) / frequencies.length
    view.setInt16(44 + i * 2, Math.round(value * envelope * 2400), true)
  }
  return new Uint8Array(buffer)
}
