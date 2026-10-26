import { expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { createReadingPlayback } from '../../packages/frontend/src/reading-playback.ts'
import { DEFAULT_PAGE, DEFAULT_SCRIPT } from '../../packages/frontend/src/default-template.ts'
import { playerViewPatch } from '../../packages/frontend/src/player-view.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import type { HostState } from '../../desktop/host/http-server.ts'
import { brandId, type CharacterView } from '@harness-world/contracts'
import { playerTranscript, sceneChangedAt } from '../../desktop/host/player-transcript.ts'

const line = (seq: number, text: string) => ({ seq, speaker: 'GPT-6', text, player: false })
it('keeps same-name and remote speaker identities from authorized observations through segmented reading', () => {
  const player = brandId('character:player', 'CharacterId'),
    local = brandId('character:local', 'CharacterId'),
    remote = brandId('character:remote', 'CharacterId')
  const view = {
    observations: [
      {
        sourceSeq: 1,
        value: {
          content: {
            status: 'accepted',
            speech: { characterId: local, segments: [{ type: 'speech', text: '我在这里。' }] },
          },
        },
      },
      {
        sourceSeq: 2,
        value: {
          content: {
            status: 'accepted',
            speech: {
              characterId: remote,
              medium: '电话',
              segments: [
                { type: 'narration', text: '电话里传来声音。' },
                { type: 'speech', text: '我在远处。' },
              ],
            },
          },
        },
      },
      {
        sourceSeq: 3,
        value: {
          content: {
            status: 'accepted',
            actorId: local,
            actionType: 'interact',
            activity: {},
            resultDescription: '活动结束。',
          },
        },
      },
    ],
  } as unknown as CharacterView
  const transcript = playerTranscript(
    view,
    new Map([
      [local, '同名角色'],
      [remote, '同名角色'],
    ]),
    player,
  )
  const state: HostState = {
    busy: false,
    paused: false,
    error: false,
    phaseLabel: '',
    notice: '',
    debug: {},
    transcript,
    world: {
      title: '测试',
      playerName: '玩家',
      npcNames: [],
      currentScene: {
        locationName: '房间',
        presentNpcNames: ['同名角色'],
        recipients: [{ id: local, name: '同名角色' }],
      },
    },
  }
  const projected = projectPlayerView(state),
    reading = createReadingPlayback()
  expect(projected.history.map(row => row.speakerId)).toEqual([local, remote, undefined])
  expect(projected.history[1]?.speaker).toBe('同名角色（电话）')
  reading.update(projected.history.slice(0, 1))
  expect(reading.current()?.speakerId).toBe(local)
  reading.advance()
  reading.update(projected.history)
  expect(reading.current()).toMatchObject({ speakerId: remote, type: 'narration', segmentIndex: 0 })
  reading.advance()
  expect(reading.current()).toMatchObject({ speakerId: remote, type: 'speech', segmentIndex: 1 })
  expect(projected.scene?.recipients.map(person => person.id)).toEqual([local])
  reading.advance()
  expect(reading.current()?.speakerId).toBeUndefined()
})
it('keeps reading independent of repeated snapshots and later committed publications', () => {
  const reading = createReadingPlayback()
  reading.update([
    line(1, '旧记录'),
    {
      ...line(2, '最新'),
      segments: [
        { type: 'narration', text: '抬起头' },
        { type: 'speech', text: '你好' },
      ],
    },
  ])
  expect(reading.current()?.text).toBe('抬起头')
  reading.advance()
  reading.update([
    line(1, '旧记录'),
    {
      ...line(2, '最新'),
      segments: [
        { type: 'narration', text: '抬起头' },
        { type: 'speech', text: '你好' },
      ],
    },
  ])
  expect(reading.current()?.text).toBe('你好')
  reading.skip()
  expect(reading.pending()).toBe(false)
  reading.update([
    line(1, '旧记录'),
    {
      ...line(2, '最新'),
      segments: [
        { type: 'narration', text: '抬起头' },
        { type: 'speech', text: '你好' },
      ],
    },
    line(3, '后续结果'),
  ])
  expect(reading.current()?.text).toBe('后续结果')
  expect(reading.remaining()).toBe(1)
})
it('replaces candidate playback at the common prefix without mixing old replies', () => {
  const reading = createReadingPlayback()
  reading.update([line(1, '玩家输入'), line(2, '候选 A')])
  reading.skip()
  reading.update([line(1, '玩家输入'), line(2, '候选 B'), line(3, '候选 B 后续')])
  expect(reading.current()?.text).toBe('候选 B')
  reading.advance()
  expect(reading.current()?.text).toBe('候选 B 后续')
  reading.update([])
  expect(reading.pending()).toBe(false)
  expect(reading.current()).toBeUndefined()
})
it('embeds a self-contained browser controller without transpiler helpers', () => {
  const controller = DEFAULT_SCRIPT.slice(
    DEFAULT_SCRIPT.indexOf('const playback=') + 'const playback='.length,
    DEFAULT_SCRIPT.indexOf(';\n const api='),
  )
  const reading = runInNewContext(controller, { structuredClone }) as ReturnType<typeof createReadingPlayback>
  reading.update([line(1, '你好')])
  expect(reading.current()?.text).toBe('你好')
  reading.advance()
  expect(reading.pending()).toBe(false)
})
it('holds scene membership while reading and flushes the latest authorized snapshot on skip', () => {
  const reading = createReadingPlayback()
  const before = { locationName: '图书馆', visibleCharacters: ['GPT-6'], recipients: [] }
  const after = { locationName: '长廊', visibleCharacters: [], recipients: [] }
  reading.update([line(1, '先说话')])
  expect(reading.stageScene(before)).toEqual(before)
  reading.update([line(1, '先说话'), line(2, '行动结果'), line(3, '后续对白')])
  expect(reading.stageScene(after)).toEqual(before)
  reading.advance()
  expect(reading.stageScene(after)).toEqual(before)
  reading.skip()
  expect(reading.stageScene(after)).toEqual(after)
})
it('changes place and people when the reader reaches the line where they changed, not before', () => {
  const reading = createReadingPlayback()
  const before = { locationName: '客厅', visibleCharacters: ['Claude'], recipients: [] }
  // DeepSeek walked in with the event at seq 3; the line about it is the third one.
  const after = { changedAt: 3, locationName: '客厅', visibleCharacters: ['Claude', 'DeepSeek'], recipients: [] }
  reading.update([line(1, '先说话')])
  expect(reading.stageScene(before)).toEqual(before)
  reading.update([
    line(1, '先说话'),
    line(2, 'Claude 的回答'),
    line(3, '（DeepSeek 走进客厅。）'),
    line(4, 'DeepSeek 开口'),
  ])
  expect(reading.stageScene(after)).toEqual(before)
  reading.advance()
  expect(reading.current()?.text).toBe('Claude 的回答')
  expect(reading.stageScene(after)).toEqual(before)
  reading.advance()
  expect(reading.current()?.text).toBe('（DeepSeek 走进客厅。）')
  expect(reading.stageScene(after)).toEqual(after)
})
it('dates a scene change by the last arrival or departure where the player is', () => {
  const at = (seq: number, eventType: string, data: object) => ({ seq, eventType, data })
  const events = [
    at(1, 'character.created', { characterId: 'character:player', locationId: 'location:a' }),
    at(2, 'character.created', { characterId: 'character:claude', locationId: 'location:a' }),
    at(3, 'character.created', { characterId: 'character:glm', locationId: 'location:b' }),
    at(4, 'character.speak', { characterId: 'character:claude', text: '你好' }),
    at(5, 'character.moved', { characterId: 'character:glm', toLocationId: 'location:a' }),
    at(6, 'character.speak', { characterId: 'character:glm', text: '我来了' }),
  ]
  expect(sceneChangedAt(events, 'character:player')).toBe(5)
  // Someone moving between other rooms does not change the player's scene.
  expect(
    sceneChangedAt(
      [...events, at(7, 'character.moved', { characterId: 'character:gpt', toLocationId: 'location:c' })],
      'character:player',
    ),
  ).toBe(5)
  expect(
    sceneChangedAt(
      [...events, at(8, 'character.moved', { characterId: 'character:player', toLocationId: 'location:b' })],
      'character:player',
    ),
  ).toBe(8)
})
it('invalidates held scene data when history is replaced by a different candidate', () => {
  const reading = createReadingPlayback()
  const a = { locationName: '候选 A 场景', visibleCharacters: ['GPT-6'], recipients: [] }
  const b = { locationName: '候选 B 场景', visibleCharacters: ['Claude'], recipients: [] }
  reading.update([line(1, '候选 A')])
  reading.stageScene(a)
  reading.update([line(1, '候选 B')])
  expect(reading.current()?.text).toBe('候选 B')
  expect(reading.stageScene(b)).toEqual(b)
})
it('can invalidate a candidate scene even when the visible dialogue is identical', () => {
  const reading = createReadingPlayback()
  const a = { locationName: '图书馆', visibleCharacters: ['GPT-6'], recipients: [] }
  const b = { locationName: '长廊', visibleCharacters: [], recipients: [] }
  reading.update([line(1, '再见')])
  reading.stageScene(a)
  reading.update([line(1, '再见')])
  reading.invalidateScene()
  expect(reading.current()?.text).toBe('再见')
  expect(reading.stageScene(b)).toEqual(b)
})
it('projects only the current player expression policy and patches permission changes', () => {
  const state: HostState = {
    busy: false,
    paused: false,
    error: false,
    phaseLabel: '',
    notice: '',
    world: { title: '测试', playerName: '玩家', npcNames: [] },
    transcript: [],
    debug: {},
    activity: {
      title: '活动',
      id: 'activity',
      revision: 1,
      participants: ['player'],
      game: { active: true, turn: 'player', public: {}, private: { answer: 42 } },
      policy: { speech: 'choices', speechChoices: ['接受', '拒绝'], narration: false, internalSecret: 'secret' },
    },
  }
  const before = projectPlayerView(state)
  expect(before.expression).toEqual({ speech: 'choices', speechChoices: ['接受', '拒绝'], narration: false })
  expect(JSON.stringify(before)).not.toContain('secret')
  expect(JSON.stringify(before)).not.toContain('answer')
  const after = projectPlayerView({ ...state, activity: { ...state.activity, game: { active: false, public: {} } } })
  expect(playerViewPatch(before, after)).toHaveProperty('expression', {
    speech: 'free',
    speechChoices: [],
    narration: true,
  })
})
/** A pure helper embedded in the default stage script, evaluated on its own like the reading controller. */
const embedded = (name: string, next: string) =>
  runInNewContext(
    DEFAULT_SCRIPT.slice(
      DEFAULT_SCRIPT.indexOf(' const ' + name + '=') + (' const ' + name + '=').length,
      DEFAULT_SCRIPT.indexOf(';\n const ' + next + '='),
    ),
  )
it('renders the status panel with labels and values and marks stale ones as last confirmed', () => {
  const statusRows = embedded('statusRows', 'roundTools') as (
    view: unknown,
  ) => { holder: string; items: { label: string; value: string; note: string }[] }[]
  const rows = statusRows({
    player: { name: '玩家' },
    statusBar: [
      { key: 'time', label: '时间', holderId: null, value: 10, current: true },
      {
        key: 'money',
        label: '余额',
        holderId: 'character:player',
        holderName: '玩家',
        self: true,
        value: 100,
        current: false,
      },
      { key: 'hp', label: '生命', holderId: 'character:companion', holderName: '阿七', value: 15, current: true },
      { key: 'armed', label: '持械', holderId: 'character:companion', holderName: '阿七', value: false, current: true },
    ],
  })
  expect(rows).toEqual([
    { holder: '世界', items: [{ label: '时间', value: '10', note: '' }] },
    { holder: '你', items: [{ label: '余额', value: '100', note: '上次确认' }] },
    {
      holder: '阿七',
      items: [
        { label: '生命', value: '15', note: '' },
        { label: '持械', value: '否', note: '' },
      ],
    },
  ])
  expect(statusRows({ player: { name: '玩家' } })).toEqual([])
  expect(
    statusRows({
      statusBar: [{ label: '委托', holderId: null, value: { stages: ['done'], reward: null }, current: true }],
    }),
  ).toEqual([{ holder: '世界', items: [{ label: '委托', value: '{"stages":["done"],"reward":null}', note: '' }] }])
  // A large composite value is shortened on the stage; the SDK view keeps the whole value.
  const notes = { notes: Array.from({ length: 40 }, (_, i) => '记录' + i) }
  const shown = statusRows({ statusBar: [{ label: '委托', holderId: null, value: notes, current: true }] })[0]!
    .items[0]!.value
  expect(Array.from(shown)).toHaveLength(121)
  expect(shown).toBe(Array.from(JSON.stringify(notes)).slice(0, 120).join('') + '…')
  expect(DEFAULT_SCRIPT).toContain("node('status-bar')")
})
it('keeps an NPC that shares the player name apart from the player in the status panel', () => {
  const statusRows = embedded('statusRows', 'roundTools') as (
    view: unknown,
  ) => { holder: string; items: { label: string; value: string; note: string }[] }[]
  expect(
    statusRows({
      player: { name: '小明' },
      statusBar: [
        { key: 'money', label: '余额', holderId: 'character:twin', holderName: '小明', value: 5, current: true },
        {
          key: 'money',
          label: '余额',
          holderId: 'character:player',
          holderName: '小明',
          self: true,
          value: 100,
          current: true,
        },
      ],
    }),
  ).toEqual([
    { holder: '小明', items: [{ label: '余额', value: '5', note: '' }] },
    { holder: '你', items: [{ label: '余额', value: '100', note: '' }] },
  ])
})
it('lifts text messages out of the action drawer into their own composer button and panel', () => {
  const source = DEFAULT_SCRIPT.slice(
    DEFAULT_SCRIPT.indexOf('function isMessage('),
    DEFAULT_SCRIPT.indexOf('\n let messageOptions'),
  )
  const isMessage = runInNewContext('(' + source + ')') as (option: unknown) => boolean
  const option = (bindingId: string) => ({ action: { actionType: 'interact', parameters: { bindingId } } })
  expect(isMessage(option('experiment:message'))).toBe(true)
  expect(isMessage(option('base:hold-hand'))).toBe(false)
  expect(isMessage({ action: { actionType: 'move', parameters: { locationId: 'location:a' } } })).toBe(false)
  expect(DEFAULT_PAGE).toContain('id="composer-message"')
  expect(DEFAULT_PAGE).toContain('id="message-panel"')
})
