/** Sanitized, model-free preview. Never opens a save or calls a model provider. */
import { createHostServer, type HostState, type HostRuntime } from '../../apps/host/src/runtime/http-server.ts'
import { brandId } from '@perspectra/sdk/contracts'
import { loadPackWeb } from '../../apps/host/src/runtime/pack-frontend.ts'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const token = 'f'.repeat(64)
let seq = 2, submissions = 0
let state: HostState = {
  busy: false, error: false, paused: false, notice: '', phaseLabel: '', debug: {},
  world: { title: '黄昏之后 · 情景舞台预览', playerName: '旅人', npcNames: ['GPT-6'],
    currentScene: { locationId: 'living-room', locationName: '客厅', presentNpcNames: ['GPT-6'], recipients: [{ id: 'gpt', name: 'GPT-6' }] } },
  transcript: [{ seq: 1, speaker: '旅人', speakerId:brandId('player','CharacterId'), text: '这里，还有人在吗？', player: true },
    { seq: 2, speaker: 'GPT-6', speakerId:brandId('gpt','CharacterId'), text: '你终于来了。', player: false, segments: [
      { type: 'narration', text: '她从书页间抬起头。窗外最后一束光，轻轻落在银白的发梢上。' },
      { type: 'speech', text: '你终于来了。\n我还以为，今天也要一个人在这里等到天黑。' }] }],
  actionNames: { 'entity:letter': '旧信件' },
  items: [{ id: 'entity:letter', name: '旧信件', kind: '纸张', where: 'here' }],
  statusBar: [{ key: 'time', label: '时间', holderId: null, value: '18:20', current: true, pinned: true }],
  availableActions: [{ actionType: 'move', actionVersion: 1, destinations: [{ locationId: 'hall', name: '长廊' }] },
    { actionType: 'interact', actionVersion: 1, interactions: [{ targetRef: { kind: 'entity', id: 'entity:letter' }, definitionRef: { id: 'base:take', version: 1 }, bindingId: 'preview-letter', arguments: {} }] }],
}
const publish = (text: string, player = false) => {
  state = { ...state, transcript: [...state.transcript, { seq: ++seq, speaker: player ? '旅人' : 'GPT-6', speakerId:brandId(player?'player':'gpt','CharacterId'), text, player }] }
}
const initial=structuredClone(state)
process.on('message',(message: {id?:number;command?:string;value?:boolean})=>{
  if(message.command==='reset'){state=structuredClone(initial);seq=2;submissions=0}
  if(message.command==='arrive')publish('我把茶放在窗边了，你可以慢慢说。')
  if(message.command==='busy')state={...state,busy:message.value??true,canInterrupt:false}
  if(message.command==='interruptible')state={...state,busy:true,canInterrupt:true}
  if(message.command==='remove-target')state={...state,world:{...state.world,currentScene:{...state.world.currentScene!,recipients:[],presentNpcNames:[]}}}
  process.send?.({id:message.id,submissions})
})
const runtime: HostRuntime = {
  state: async () => state,
  submit: async text => {
    submissions++; await new Promise(resolve=>setTimeout(resolve,900)); publish(text,true); state={...state,busy:true,canInterrupt:false}
    return state
  },
  perform: async action => {
    if (action.actionType === 'interact') {
      submissions++; publish('旧信件已交由旅人保管。', true); publish('先收好吧，等我们找到收信人再还给她。')
      state = { ...state, items: [{ id: 'entity:letter', name: '旧信件', kind: '纸张', where: 'held' }], statusBar: [{ key: 'time', label: '时间', holderId: null, value: '18:21', current: true, pinned: true }], availableActions: state.availableActions?.filter(option => option.actionType === 'move') ?? [] }
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
  saveNode: async title => {
    await new Promise(resolve => setTimeout(resolve, 600))
    if (title === '失败预览') throw new Error('预览保存失败，请重试。')
    return { id: 'preview-node', title } as Awaited<ReturnType<NonNullable<HostRuntime['saveNode']>>>
  },
}
if (process.argv.includes('--activity')) state = { ...state, activity: {
  title: '寻找遗失的信 · 调查', activityKey: 'investigation', id: 'preview-activity', revision: 1, participants: ['player', 'gpt'],
  game: { active: true, turn: 'player', round: 1, phase: 'investigation', public: { objective: '寻找寄给旅人的信，先调查书架或储物柜。', statusText: '选择调查区域', clues: 0, funds: 120 } },
  policy: { speech: 'choices', speechChoices: ['接受邀请', '暂时拒绝'], narration: false },
  options: [{ label: '调查所选区域', definitionRef: { id: 'activity:guess', version: 1 },
    argumentSchema: { type: 'object', properties: { activityId: { type: 'string' }, revision: { type: 'integer' }, value: { type: 'integer', title: '调查区域', oneOf: [{ const: 3, title: '窗边书架' }, { const: 5, title: '靠门储物柜' }] } } } }],
} }
if (process.argv.includes('--multi')) state = { ...state, world: { ...state.world, npcNames: ['GPT-6', 'Claude', 'DeepSeek', '同行者'],
  currentScene: { locationId: 'living-room', locationName: '客厅', presentNpcNames: ['GPT-6', 'Claude', 'DeepSeek', '同行者'], recipients: [{ id: 'gpt', name: 'GPT-6' }, { id: 'claude', name: 'Claude' }, { id: 'deepseek', name: 'DeepSeek' }, { id: 'character:companion', name: '同行者' }] } } }
/** --many：约 20 个行动，用于检查右栏分组、相关排序与翻页。 */
if (process.argv.includes('--many')) {
  const items = [['letter', '旧信件'], ['lamp', '煤油灯'], ['key', '黄铜钥匙'], ['book', '褪色诗集'], ['map', '手绘地图'], ['tea', '冷掉的红茶'], ['quill', '羽毛笔']] as const
  state = { ...state, actionNames: { ...Object.fromEntries(items.map(([id, name]) => ['entity:' + id, name])), gpt: 'GPT-6' },
    availableActions: [{ actionType: 'move', actionVersion: 1, destinations: ([['hall', '长廊'], ['attic', '阁楼'], ['garden', '后花园'], ['archive', '档案室']] as const).map(([locationId, name]) => ({ locationId, name })) },
      { actionType: 'interact', actionVersion: 1, interactions: [
        ...items.map(([id]) => ({ targetRef: { kind: 'entity', id: 'entity:' + id }, definitionRef: { id: 'base:take', version: 1 }, bindingId: 'take-' + id, arguments: {} })),
        ...items.slice(0, 4).map(([id]) => ({ targetRef: { kind: 'entity', id: 'entity:' + id }, definitionRef: { id: 'base:give', version: 1 }, bindingId: 'give-' + id, arguments: { recipientId: 'gpt' } })),
        ...items.slice(4).map(([id]) => ({ targetRef: { kind: 'entity', id: 'entity:' + id }, definitionRef: { id: 'base:drop', version: 1 }, bindingId: 'drop-' + id, arguments: {} })),
      ] }] }
}
const publicArt = await loadPackWeb(resolve('examples/world-packs/model-girls-sweet-days'))
if (!publicArt) throw new Error('Public artwork missing')
const assets = new Map(publicArt.assets)
assets.set('/frontend/custom/theme.css', {contentType:'text/css; charset=utf-8',bytes:await readFile(resolve('layout-compare/theme.css'))})
const after = process.argv.includes('--after')
const pack = {theme:after, assets, manifest:publicArt.manifest, digest:publicArt.digest, stage:{characters:publicArt.stage?.characters??{}}}
const server = createHostServer(runtime, token, pack)
const port = 0
server.listen(port, '127.0.0.1', () => {const address=server.address();if(address&&typeof address==='object')console.log('Preview ready on port '+address.port)})
process.on('SIGINT', () => { console.log('Preview submissions:', submissions); server.closeAllConnections(); server.close() })
