/** Embedded into the sandbox; keep this function self-contained. */
export function createBgmPlayback(
  api: {
    selectBgm(seq: number, segmentIndex: number, text: string): Promise<{ track: { id: string; title: string } | null }>
    getBgmAudio(id: string): Promise<{ bytes: ArrayBuffer }>
  },
  context: () => AudioContext | null,
  status: (message: string) => void,
) {
  let enabled = true,
    version = 0,
    key = '',
    trackId = '',
    volume = 1,
    master: GainNode | undefined
  const sources = new Set<AudioBufferSourceNode>()
  let current: { source: AudioBufferSourceNode; gain: GainNode } | undefined
  const helpers = {
    fade() {
      if (!current) return
      const audio = context()!
      current.gain.gain.cancelScheduledValues(audio.currentTime)
      current.gain.gain.setValueAtTime(current.gain.gain.value, audio.currentTime)
      current.gain.gain.linearRampToValueAtTime(0, audio.currentTime + 0.6)
      current.source.stop(audio.currentTime + 0.6)
      current = undefined
      trackId = ''
    },
  }
  return {
    setEnabled(value: boolean) {
      enabled = value
      version++
      key = ''
      if (!enabled) {
        helpers.fade()
        status('背景音乐已关闭')
      }
    },
    setVolume(value: number) {
      volume = value
      if (master) master.gain.value = value
    },
    async update(unit: { seq: number; segmentIndex: number; text: string } | undefined, requestedVolume: number) {
      volume = requestedVolume
      if (!enabled) return
      if (!unit) {
        version++
        key = ''
        helpers.fade()
        status('')
        return
      }
      const audio = context()
      if (!audio || audio.state !== 'running') {
        status('点击页面后播放背景音乐')
        return
      }
      const nextKey = JSON.stringify([unit.seq, unit.segmentIndex, unit.text])
      if (key === nextKey) return
      key = nextKey
      const request = ++version
      try {
        const { track } = await api.selectBgm(unit.seq, unit.segmentIndex, unit.text)
        if (request !== version) return
        if (!track) {
          helpers.fade()
          status('当前段落不播放背景音乐')
          return
        }
        if (track.id === trackId) return
        const result = await api.getBgmAudio(track.id)
        if (request !== version) return
        const buffer = await audio.decodeAudioData(result.bytes)
        if (request !== version) return
        if (!master) {
          master = audio.createGain()
          master.connect(audio.destination)
        }
        master.gain.value = volume
        const source = audio.createBufferSource(),
          gain = audio.createGain()
        source.buffer = buffer
        source.loop = true
        source.connect(gain)
        gain.connect(master)
        gain.gain.setValueAtTime(0, audio.currentTime)
        gain.gain.linearRampToValueAtTime(1, audio.currentTime + 0.6)
        sources.add(source)
        source.onended = () => {
          source.disconnect()
          gain.disconnect()
          sources.delete(source)
        }
        helpers.fade()
        current = { source, gain }
        trackId = track.id
        source.start()
        status('正在播放：' + track.title)
      } catch {
        if (request === version) {
          helpers.fade()
          status('背景音乐暂不可用，可关闭后重新开启')
        }
      }
    },
    close() {
      enabled = false
      version++
      for (const source of sources) source.stop()
      sources.clear()
      master?.disconnect()
      current = undefined
    },
  }
}
