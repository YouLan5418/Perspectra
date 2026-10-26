import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { createBgmPlayback } from '../../packages/frontend/src/bgm-playback.ts'
import { createReadingPlayback } from '../../packages/frontend/src/reading-playback.ts'

const create = runInNewContext('(' + createBgmPlayback.toString() + ')') as typeof createBgmPlayback
const unit = (seq: number, text: string) => ({ seq, segmentIndex: 0, text })
function fixture(
  selectBgm: Parameters<typeof create>[0]['selectBgm'] = async (_seq, _index, text) => ({
    track: { id: text, title: text },
  }),
) {
  const sources: {
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    loop: boolean
    disconnect: ReturnType<typeof vi.fn>
  }[] = []
  const gains: {
    gain: {
      value: number
      setValueAtTime: ReturnType<typeof vi.fn>
      linearRampToValueAtTime: ReturnType<typeof vi.fn>
      cancelScheduledValues: ReturnType<typeof vi.fn>
    }
  }[] = []
  const context = {
    state: 'running',
    currentTime: 5,
    destination: {},
    createBufferSource: () => {
      const source = { start: vi.fn(), stop: vi.fn(), loop: false, connect: vi.fn(), disconnect: vi.fn() }
      sources.push(source)
      return source
    },
    createGain: () => {
      const gain = {
        gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }
      gains.push(gain)
      return gain
    },
    decodeAudioData: vi.fn(async () => ({})),
  }
  const api = { selectBgm: vi.fn(selectBgm), getBgmAudio: vi.fn(async () => ({ bytes: new ArrayBuffer(8) })) },
    status = vi.fn()
  const player = create(api, () => context as unknown as AudioContext, status)
  return { context, api, status, player, sources, gains }
}

it('follows the reading cursor, keeps the same track running and crossfades after skipping to new text', async () => {
  const f = fixture(),
    cursor = createReadingPlayback()
  const calm = { seq: 1, text: 'calm', player: false, speaker: '同伴' },
    tense = { ...calm, seq: 2, text: 'tense' }
  cursor.update([calm])
  await f.player.update(cursor.current(), 0.8)
  cursor.update([calm, tense])
  await f.player.update(cursor.current(), 0.8)
  expect(f.api.selectBgm).toHaveBeenCalledTimes(1)
  expect(f.sources[0]?.loop).toBe(true)
  // Another paragraph can select the current track without restarting its audio.
  await f.player.update(unit(3, 'calm'), 0.8)
  expect(f.api.getBgmAudio).toHaveBeenCalledTimes(1)
  cursor.skip()
  await f.player.update(cursor.current(), 0.8)
  expect(f.sources).toHaveLength(2)
  expect(f.sources[0]?.stop).toHaveBeenCalledWith(5.6)
  expect(f.gains[2]?.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 5.6)
  f.player.close()
  expect(f.sources[1]?.stop).toHaveBeenCalled()
})

it('drops a late candidate selection and does not start stale audio after disabling playback', async () => {
  let release!: (result: { track: { id: string; title: string } }) => void
  const f = fixture(async (_seq, _index, text) =>
    text === 'old'
      ? new Promise(done => {
          release = done
        })
      : { track: { id: text, title: text } },
  )
  const pending = f.player.update(unit(1, 'old'), 0.8)
  await f.player.update(unit(1, 'new'), 0.8)
  release({ track: { id: 'old', title: 'old' } })
  await pending
  expect(f.api.getBgmAudio.mock.calls).toEqual([['new']])
  let decode!: () => void
  f.context.decodeAudioData.mockImplementationOnce(
    () =>
      new Promise(done => {
        decode = () => done({})
      }),
  )
  const decoding = f.player.update(unit(2, 'next'), 0.8)
  await vi.waitFor(() => expect(f.context.decodeAudioData).toHaveBeenCalledTimes(2))
  f.player.setEnabled(false)
  decode()
  await decoding
  expect(f.sources).toHaveLength(1)
})

it('waits for a user-unlocked audio context and respects muting while audio is being decoded', async () => {
  const f = fixture()
  f.context.state = 'suspended'
  await f.player.update(unit(1, 'calm'), 0.8)
  expect(f.api.selectBgm).not.toHaveBeenCalled()
  f.context.state = 'running'
  let finish!: () => void
  f.context.decodeAudioData.mockImplementationOnce(
    () =>
      new Promise(done => {
        finish = () => done({})
      }),
  )
  const pending = f.player.update(unit(1, 'calm'), 0.8)
  await vi.waitFor(() => expect(f.context.decodeAudioData).toHaveBeenCalledOnce())
  f.player.setVolume(0)
  finish()
  await pending
  expect(f.gains[0]?.gain.value).toBe(0)
  f.player.setVolume(0.35)
  expect(f.gains[0]?.gain.value).toBe(0.35)
})

it('fades to silence on null or empty history and contains selection failures', async () => {
  const f = fixture(async (_seq, _index, text) => {
    if (text === 'error') throw new Error('PRIVATE_DETAIL')
    return { track: text === 'silent' ? null : { id: text, title: text } }
  })
  await f.player.update(unit(1, 'calm'), 1)
  await f.player.update(unit(2, 'silent'), 1)
  expect(f.sources[0]?.stop).toHaveBeenCalled()
  await f.player.update(unit(3, 'error'), 1)
  expect(f.status).toHaveBeenLastCalledWith('背景音乐暂不可用，可关闭后重新开启')
  await f.player.update(unit(4, 'calm'), 1)
  await f.player.update(undefined, 1)
  expect(f.sources[1]?.stop).toHaveBeenCalled()
})
