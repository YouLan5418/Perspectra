/** Sanitized, model-free preview. Never opens a save or calls a model provider. */
import { createPlaytestServer, type PlaytestState, type PlaytestRuntime } from './playtest-server.ts'
import { brandId } from '@harness-world/contracts'
const token = 'f'.repeat(64)
let seq = 2, submissions = 0
let state: PlaytestState = {
  busy: false, error: false, paused: false, notice: '', phaseLabel: '', debug: {},
  world: { title: '黄昏之后 · 情景舞台预览', playerName: '旅人', npcNames: ['GPT-6'],
    currentScene: { locationName: '旧图书馆', presentNpcNames: ['GPT-6'], recipients: [{ id: 'gpt', name: 'GPT-6' }] } },
  transcript: [{ seq: 1, speaker: '旅人', speakerId:brandId('player','CharacterId'), text: '这里，还有人在吗？', player: true },
    { seq: 2, speaker: 'GPT-6', speakerId:brandId('gpt','CharacterId'), text: '你终于来了。', player: false, segments: [
      { type: 'narration', text: '她从书页间抬起头。窗外最后一束光，轻轻落在银白的发梢上。' },
      { type: 'speech', text: '你终于来了。\n我还以为，今天也要一个人在这里等到天黑。' }] }],
  actionNames: { 'entity:letter': '旧信件' },
  availableActions: [{ actionType: 'move', actionVersion: 1, destinations: [{ locationId: 'hall', name: '长廊' }] },
    { actionType: 'interact', actionVersion: 1, interactions: [{ targetRef: { kind: 'entity', id: 'entity:letter' }, definitionRef: { id: 'base:take', version: 1 }, bindingId: 'preview-letter', arguments: {} }] }],
}
const publish = (text: string, player = false) => {
  state = { ...state, transcript: [...state.transcript, { seq: ++seq, speaker: player ? '旅人' : 'GPT-6', speakerId:brandId(player?'player':'gpt','CharacterId'), text, player }] }
}
const runtime: PlaytestRuntime = {
  state: async () => state,
  submit: async text => {
    submissions++; publish(text, true); state = { ...state, busy: true }
    setTimeout(() => publish('嗯，我在听。你想先看看这里，还是坐下来聊一会儿？'), 700)
    setTimeout(() => { publish('不用着急，今晚还有很长的时间。'); state = { ...state, busy: false } }, 4500)
    return state
  },
  perform: async action => {
    if (action.actionType === 'interact') {
      submissions++; publish('旧信件已交由旅人保管。', true); publish('先收好吧，等我们找到收信人再还给她。')
      state = { ...state, availableActions: state.availableActions?.filter(option => option.actionType === 'move') ?? [] }
      return state
    }
    submissions++; state = { ...state, world: { ...state.world, currentScene: { locationName: '长廊', presentNpcNames: [], recipients: [] } } }
    publish('你来到了安静的长廊。', true); return state
  },
  activityAction: async request => {
    if (state.activity && request.operation !== 'start' && (request.activityId !== state.activity.id || request.revision !== state.activity.revision)) throw new TypeError('活动请求已失效')
    submissions++
    if (request.operation === 'guess' && (!Number.isInteger(request.parameters.value) || Number(request.parameters.value) < 1 || Number(request.parameters.value) > 9)) throw new TypeError('请输入 1 至 9 的整数')
    publish(request.operation === 'guess' ? '你选择了窗边书架。线索已公开。' : request.operation === 'resume' ? '调查继续。' : '活动已暂停，进度保留。', true)
    if (state.activity) state = { ...state, activity: { ...state.activity, suspended: request.operation === 'suspend', revision: Number(state.activity.revision) + 1,
      game: { active: request.operation !== 'suspend', turn: 'player', round: 2, phase: 'investigation', public: { objective: '寻找寄给旅人的信，先调查书架或储物柜。', statusText: request.operation === 'suspend' ? '调查已暂停' : '继续寻找信件', clues: 1, lastResult: '窗边留下了一封信。' } } } }
    return state
  },
  escape: async () => { state = { ...state, activity: { ...state.activity, game: { active: false, public: {} } } }; return state },
  pause: async () => state, resume: async () => state, close: async () => {},
}
if (process.argv.includes('--activity')) state = { ...state, activity: {
  title: '寻找遗失的信 · 调查', activityKey: 'investigation', id: 'preview-activity', revision: 1, participants: ['player', 'gpt'],
  game: { active: true, turn: 'player', round: 1, phase: 'investigation', public: { objective: '寻找寄给旅人的信，先调查书架或储物柜。', statusText: '选择调查区域', clues: 0, funds: 120 } },
  policy: { speech: 'choices', speechChoices: ['接受邀请', '暂时拒绝'], narration: false },
  options: [{ label: '调查所选区域', definitionRef: { id: 'activity:guess', version: 1 },
    argumentSchema: { type: 'object', properties: { activityId: { type: 'string' }, revision: { type: 'integer' }, value: { type: 'integer', title: '调查区域', oneOf: [{ const: 3, title: '窗边书架' }, { const: 5, title: '靠门储物柜' }] } } } }],
} }
if (process.argv.includes('--multi')) state = { ...state, world: { ...state.world, npcNames: ['GPT-6', 'Claude', 'DeepSeek'],
  currentScene: { locationName: '旧图书馆', presentNpcNames: ['GPT-6', 'Claude', 'DeepSeek'], recipients: [{ id: 'gpt', name: 'GPT-6' }, { id: 'claude', name: 'Claude' }, { id: 'deepseek', name: 'DeepSeek' }] } } }
const server = createPlaytestServer(runtime, token)
const port = process.argv.includes('--multi') ? 8069 : process.argv.includes('--activity') ? 8068 : 8067
server.listen(port, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:' + port + '/#token=' + token))
process.on('SIGINT', () => { console.log('Preview submissions:', submissions); server.closeAllConnections(); server.close() })
