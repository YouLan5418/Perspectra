import type { StoredWorldEvent, WorldAddress, WorldJsonObject } from '../../../../packages/contracts/src/index.ts'
import type { InspectedRequest } from '../../../../packages/provider-chat/src/request-inspector.ts'
import type { CreatorInspectionSnapshot } from '../../../../desktop/host/creator-inspection.ts'
import type { CreatorHistoryItem, CreatorHistorySnapshot } from '../../../../desktop/host/creator-history.ts'
import type { CreatorRecord, CreatorRecordsSnapshot, CreatorScope } from '../../../../desktop/host/creator-records.ts'

/** 浏览器预览用的固定样例：结构与真实接口一致，便于在没有运行实例时检查界面。 */
const address = { tenantId: 'local', worldId: 'snow-inn', branchId: 'main' } as unknown as WorldAddress
export const MOCK_SCOPE: CreatorScope = {
  address,
  worldVersion: '0.1.0-preview',
  branchId: 'main',
  runId: 'preview-run',
}

export const MOCK_CHARACTERS = [
  { id: 'character:lin', name: '林澄' },
  { id: 'character:lu', name: '陆遥' },
  { id: 'character:player', name: '玩家' },
]
export const MOCK_ENTITIES = [
  { id: 'entity:brass-key', name: '黄铜钥匙' },
  { id: 'entity:thermos', name: '保温壶' },
]
export const MOCK_LOCATIONS = [
  { id: 'location:front-room', name: '前室' },
  { id: 'location:back-room', name: '后室' },
  { id: 'location:inn-hall', name: '旅店大堂' },
]

const hash = 'sha256:preview000000000000000000000000000000000000000000000000000000'
function ev(
  seq: number,
  tick: number,
  eventType: string,
  data: Record<string, unknown>,
  transaction: string,
): StoredWorldEvent {
  return {
    address,
    seq,
    tick,
    eventType,
    eventVersion: 1,
    data: data as WorldJsonObject,
    previousHash: hash,
    eventHash: hash,
    transactionId: transaction as never,
    eventOrdinal: 0,
  }
}

const T1 = 'tx-turn-1',
  T2 = 'tx-turn-2',
  T3 = 'tx-turn-3',
  T4 = 'tx-turn-4'
const OBSERVATION = (id: string, observerId: string, content: Record<string, unknown>) => ({
  id,
  value: { observerId, content },
})

export const MOCK_EVENTS: StoredWorldEvent[] = [
  ev(
    61,
    40,
    'action.resolved',
    {
      roundId: 'round-40',
      actionId: 'action:p:1',
      actorId: 'character:player',
      actionType: 'speak',
      accepted: true,
      sourceRole: 'player',
    },
    T1,
  ),
  ev(
    62,
    40,
    'character.speak',
    { characterId: 'character:player', text: '钥匙你先拿着吧，我出去一趟就回来。', addresseeIds: ['character:lin'] },
    T1,
  ),
  ev(
    63,
    40,
    'observation.upsert',
    OBSERVATION('observation:lin:1', 'character:lin', { text: '玩家把黄铜钥匙递了过来。', actionId: 'action:p:1' }),
    T1,
  ),
  ev(
    64,
    40,
    'observation.upsert',
    OBSERVATION('observation:lu:1', 'character:lu', {
      contentVisibility: 'occurrence_only',
      text: '玩家与林澄在前室说话。',
      actionId: 'action:p:1',
    }),
    T1,
  ),
  ev(65, 41, 'world.tick-advanced', { tick: 41, roundId: 'round-41' }, T1),
  ev(
    66,
    41,
    'action.resolved',
    {
      roundId: 'round-41',
      actionId: 'action:lin:1',
      actorId: 'character:lin',
      actionType: 'interact',
      accepted: true,
      sourceRole: 'character',
    },
    T2,
  ),
  ev(
    67,
    41,
    'entity.transferred',
    { entityId: 'entity:brass-key', holderId: 'character:lu', fromHolderId: 'character:player' },
    T2,
  ),
  ev(
    68,
    41,
    'observation.upsert',
    OBSERVATION('observation:lin:2', 'character:lin', { text: '你把黄铜钥匙交给了陆遥。', actionId: 'action:lin:1' }),
    T2,
  ),
  ev(
    69,
    41,
    'observation.upsert',
    OBSERVATION('observation:lu:2', 'character:lu', { text: '林澄把黄铜钥匙塞进你手里。', actionId: 'action:lin:1' }),
    T2,
  ),
  ev(
    70,
    41,
    'character.speak',
    { characterId: 'character:lin', text: '拿好，别弄丢了——这店里就这一把。', addresseeIds: ['character:lu'] },
    T2,
  ),
  ev(
    71,
    41,
    'observation.upsert',
    OBSERVATION('observation:player:1', 'character:player', {
      contentVisibility: 'occurrence_only',
      text: '林澄对陆遥说了句话。',
      actionId: 'action:lin:1',
    }),
    T2,
  ),
  ev(
    72,
    42,
    'action.resolved',
    {
      roundId: 'round-42',
      actionId: 'action:p:2',
      actorId: 'character:player',
      actionType: 'interact',
      accepted: false,
      sourceRole: 'player',
      reason: '目标物品当前不在行动者处。',
    },
    T3,
  ),
  ev(
    73,
    42,
    'action.resolved',
    {
      roundId: 'round-42',
      actionId: 'action:p:3',
      actorId: 'character:player',
      actionType: 'speak',
      accepted: true,
      sourceRole: 'player',
    },
    T3,
  ),
  ev(
    74,
    42,
    'character.speak',
    { characterId: 'character:player', text: '我手里这把钥匙，是刚才从前台拿的。', addresseeIds: ['character:lu'] },
    T3,
  ),
  ev(
    75,
    42,
    'observation.upsert',
    OBSERVATION('observation:lu:3', 'character:lu', { text: '玩家说自己手里有钥匙。', actionId: 'action:p:3' }),
    T3,
  ),
  ev(76, 42, 'world.tick-advanced', { tick: 43, roundId: 'round-43' }, T3),
  ev(
    77,
    43,
    'action.resolved',
    {
      roundId: 'round-43',
      actionId: 'action:lu:1',
      actorId: 'character:lu',
      actionType: 'speak',
      accepted: true,
      sourceRole: 'character',
    },
    T4,
  ),
  // NPC 发布使用有序 segments；观察内容与真实运行时同形（actorId / resultDescription / speech）。
  ev(
    78,
    43,
    'character.speak',
    {
      characterId: 'character:lu',
      segments: [
        { type: 'narration', text: '举了举手里的钥匙' },
        { type: 'speech', text: '……钥匙不是在我这儿吗？' },
      ],
      addresseeIds: ['character:player'],
      scope: 'scene',
      replyTo: null,
      declaredSpeechAct: null,
    },
    T4,
  ),
  ev(
    79,
    43,
    'observation.upsert',
    {
      id: 'observation:player:2',
      value: {
        observerId: 'character:player',
        actionId: 'action:lu:1',
        content: {
          actorId: 'character:lu',
          actionType: 'speak',
          status: 'accepted',
          resultDescription: '这次行动已经成功执行。当前状态请以本次可见场景为准。',
          speech: {
            characterId: 'character:lu',
            segments: [
              { type: 'narration', text: '举了举手里的钥匙' },
              { type: 'speech', text: '……钥匙不是在我这儿吗？' },
            ],
          },
        },
      },
    },
    T4,
  ),
  ev(
    80,
    43,
    'character.moved',
    { characterId: 'character:lu', fromLocationId: 'location:front-room', toLocationId: 'location:back-room' },
    T4,
  ),
  ev(81, 43, 'world.tick-advanced', { tick: 44, roundId: 'round-44' }, T4),
]

const MOCK_ACTIONS: Record<string, Record<string, unknown>> = {
  'action:p:1': {
    actionId: 'action:p:1',
    actorId: 'character:player',
    actionType: 'speak',
    actionVersion: 1,
    parameters: { text: '钥匙你先拿着吧，我出去一趟就回来。' },
  },
  'action:lin:1': {
    actionId: 'action:lin:1',
    actorId: 'character:lin',
    actionType: 'interact',
    actionVersion: 1,
    parameters: { entityId: 'entity:brass-key', targetRef: { kind: 'character', id: 'character:lu' } },
  },
  'action:p:2': {
    actionId: 'action:p:2',
    actorId: 'character:player',
    actionType: 'interact',
    actionVersion: 1,
    parameters: { entityId: 'entity:brass-key', intent: 'claim' },
  },
  'action:p:3': {
    actionId: 'action:p:3',
    actorId: 'character:player',
    actionType: 'speak',
    actionVersion: 1,
    parameters: { text: '我手里这把钥匙，是刚才从前台拿的。' },
  },
  'action:lu:1': {
    actionId: 'action:lu:1',
    actorId: 'character:lu',
    actionType: 'speak',
    actionVersion: 1,
    parameters: {
      segments: [
        { type: 'narration', text: '举了举手里的钥匙' },
        { type: 'speech', text: '……钥匙不是在我这儿吗？' },
      ],
    },
  },
}

/** 受追踪物品的保管／地点变更；随携带者移动不是独立转移。 */
const MOCK_ENTITY_CHANGE: Record<
  number,
  { before: Record<string, unknown>; after: Record<string, unknown>; followsHolder: boolean }
> = {
  67: {
    before: {
      entityId: 'entity:brass-key',
      locationId: 'location:front-room',
      holderId: 'character:player',
      kind: 'item',
    },
    after: { entityId: 'entity:brass-key', locationId: 'location:back-room', holderId: 'character:lu', kind: 'item' },
    followsHolder: false,
  },
  80: {
    before: { entityId: 'entity:brass-key', locationId: 'location:front-room', holderId: 'character:lu', kind: 'item' },
    after: { entityId: 'entity:brass-key', locationId: 'location:back-room', holderId: 'character:lu', kind: 'item' },
    followsHolder: true,
  },
}

/** 行动归属来自同一事务里不晚于该事件的 action.resolved，和宿主解析规则一致。 */
function actionIdFor(event: StoredWorldEvent): string | null {
  const data = event.data as Record<string, unknown>
  if (typeof data.actionId === 'string') return data.actionId
  if (event.eventType !== 'character.speak' && !event.eventType.startsWith('observation.')) return null
  const resolved = MOCK_EVENTS.filter(
    other =>
      other.transactionId === event.transactionId &&
      other.seq <= event.seq &&
      other.eventType === 'action.resolved' &&
      (other.data as { accepted?: boolean }).accepted === true,
  )
  const last = resolved.at(-1)
  return last ? String((last.data as { actionId?: string }).actionId) : null
}

export const MOCK_HISTORY: CreatorHistoryItem[] = MOCK_EVENTS.map(event => {
  const data = event.data as Record<string, unknown>
  const transaction = event.transactionId as string
  const actionId = actionIdFor(event)
  return {
    event,
    actorId: (data.actorId ?? data.characterId ?? null) as string | null,
    actionId,
    action: actionId ? (MOCK_ACTIONS[actionId] ?? null) : null,
    recipients:
      actionId === null
        ? []
        : MOCK_EVENTS.filter(
            other =>
              typeof (other.data as Record<string, unknown>).id === 'string' &&
              String((other.data as Record<string, unknown>).id).startsWith('observation:') &&
              (other.data as { value?: { content?: { actionId?: string } } }).value?.content?.actionId === actionId,
          ).map(observation => ({
            characterId: String((observation.data as { value: { observerId: string } }).value.observerId),
            visibility: ((observation.data as { value: { content?: { contentVisibility?: string } } }).value.content
              ?.contentVisibility === 'occurrence_only'
              ? 'occurrence_only'
              : 'full') as 'full' | 'occurrence_only',
            observationSeq: observation.seq,
          })),
    relatedSeqs: [],
    entityChange: MOCK_ENTITY_CHANGE[event.seq] ?? null,
    transaction: transaction as never,
  } as unknown as CreatorHistoryItem
})

function request(
  recordId: string,
  characterId: string,
  decisionId: string,
  startedAt: string,
  durationMs: number,
  options: {
    continuation?: boolean
    status?: 'ok' | 'failed' | 'pending'
    model?: string
    tool?: string
    thinking?: { kind: 'text' | 'summary'; text: string }[]
  } = {},
): InspectedRequest {
  const contextParts = [
    { name: 'character', content: '你是林澄，旅店的老住客，说话简短。', estimatedTokens: 24 },
    { name: 'stimulus', content: '玩家把黄铜钥匙递了过来。', estimatedTokens: 18 },
    { name: 'memories', content: '· 前台只剩一把黄铜钥匙。\n· 陆遥今晚一直待在前室。', estimatedTokens: 32 },
    { name: 'cognition', content: '你记得钥匙原本由玩家保管。', estimatedTokens: 16 },
    { name: 'scene', content: '前室 · 壁炉旁 · 玩家、陆遥、你', estimatedTokens: 20 },
    { name: 'observations', content: '玩家把黄铜钥匙递了过来。', estimatedTokens: 18 },
    { name: 'items', content: '黄铜钥匙（当前由玩家携带）', estimatedTokens: 15 },
    { name: 'affordances', content: 'speak / interact / move', estimatedTokens: 12 },
  ]
  return {
    id: 1,
    recordId,
    decisionId,
    characterId,
    continuation: options.continuation ?? false,
    model: options.model ?? 'gemini-3.7-flash',
    startedAt,
    status: options.status ?? 'ok',
    durationMs,
    estimatedBodyTokens: 4_820,
    estimatedToolTokens: 640,
    body: {
      model: options.model ?? 'gemini-3.7-flash',
      temperature: 0.9,
      tools: [
        {
          type: 'function',
          function: {
            name: 'speak',
            parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'interact',
            parameters: {
              type: 'object',
              properties: { entityId: { type: 'string' }, targetRef: { type: 'object' } },
              required: ['entityId'],
            },
          },
        },
      ],
    },
    messages: [
      {
        role: 'system',
        content: '你是林澄，旅店的老住客，说话简短。',
        source: { source: 'preset', name: '角色卡', nodeId: 'preset:character' },
        estimatedTokens: 24,
      },
      {
        role: 'user',
        content: '玩家把黄铜钥匙递了过来。',
        source: { source: 'context', name: '本次刺激' },
        estimatedTokens: 18,
      },
    ],
    contextParts,
    ...(options.thinking
      ? {
          response: {
            content: ['拿好，别弄丢了——这店里就这一把。'],
            thinking: options.thinking,
            thinkingStatus: 'provided' as const,
            toolCalls: options.tool
              ? [
                  {
                    id: 'call_1',
                    name: options.tool,
                    arguments: { entityId: 'entity:brass-key', targetRef: { kind: 'character', id: 'character:lu' } },
                  },
                ]
              : [],
            finishReason: 'stop',
          },
        }
      : {}),
    preset: {
      origin: { scope: 'base', characterId, name: '默认预设', base: { mode: 'auto', layers: [] } },
      value: {
        temperature: 0.9,
        topP: 0.95,
        maxOutputTokens: 1_024,
        nodes: [
          {
            id: 'preset:character',
            name: '角色卡',
            enabled: true,
            role: 'system',
            position: 'beforeContext',
            content: '你是林澄，旅店的老住客，说话简短。',
          },
        ],
      },
    },
    usage: { inputTokens: 5_120, outputTokens: 148, totalTokens: 5_268 },
  }
}

function record(
  id: string,
  kind: CreatorRecord['kind'],
  characterId: string,
  decisionId: string | null,
  capturedAt: string,
  summary: CreatorRecord['summary'],
  data: CreatorRecord['data'],
): CreatorRecord {
  return { id, kind, capturedAt, scope: MOCK_SCOPE, characterId, decisionId, summary, data }
}
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const MOCK_RECORDS: CreatorRecord[] = [
  record(
    uid(1),
    'request',
    'character:player',
    'decision-1',
    '2026-10-15T20:14:02.100Z',
    { label: '模型调用', status: 'ok', model: 'gemini-3.7-flash', durationMs: 1_840 },
    request(uid(1), 'character:player', 'decision-1', '2026-10-15T20:14:02.100Z', 1_840),
  ),
  record(
    uid(2),
    'decision',
    'character:player',
    'decision-1',
    '2026-10-15T20:14:04.000Z',
    { label: 'decision', status: 'model' },
    { source: 'model', value: { decision: { kind: 'speak', text: '钥匙你先拿着吧，我出去一趟就回来。' } } },
  ),
  record(
    uid(3),
    'action',
    'character:player',
    'decision-1',
    '2026-10-15T20:14:04.120Z',
    { label: 'action', status: 'accepted', durationMs: 9 },
    {
      actionId: 'action:p:1',
      action: {
        actionId: 'action:p:1',
        actorId: 'character:player',
        actionType: 'speak',
        actionVersion: 1,
        parameters: { text: '钥匙你先拿着吧，我出去一趟就回来。' },
      },
      status: 'accepted',
      reason: null,
      afterSeq: 60,
      headSeq: 63,
      startedAt: '2026-10-15T20:14:04.110Z',
      durationMs: 9,
      eventRefs: [61, 62, 63, 64],
    },
  ),
  record(
    uid(4),
    'turn',
    'character:player',
    'decision-1',
    '2026-10-15T20:14:04.200Z',
    { label: 'turn', status: 'responded' },
    { status: 'responded', calls: 1 },
  ),

  record(
    uid(5),
    'request',
    'character:lin',
    'decision-2',
    '2026-10-15T20:14:06.400Z',
    { label: '模型调用', status: 'ok', model: 'gemini-3.7-flash', durationMs: 3_210 },
    request(uid(5), 'character:lin', 'decision-2', '2026-10-15T20:14:06.400Z', 3_210, {
      thinking: [
        {
          kind: 'text',
          text: '玩家把钥匙交给我，大概是让我替他保管。陆遥一直没离开前室，交给他更稳妥；但得说清楚，免得他以为是谁都能拿。',
        },
      ],
      tool: 'interact',
    }),
  ),
  record(
    uid(6),
    'recall',
    'character:lin',
    'decision-2',
    '2026-10-15T20:14:07.900Z',
    { label: 'recall', status: 'returned' },
    {
      query: '钥匙 前台 陆遥',
      memories: [
        { id: 'memory:1', text: '前台只剩一把黄铜钥匙。' },
        { id: 'memory:2', text: '陆遥今晚一直待在前室。' },
      ],
      note: '仅是你可访问记忆中的相关证据；他人发言不证明其内容，未找到也不证明事件未发生。',
      asOfWorldSeq: 65,
    },
  ),
  record(
    uid(7),
    'decision',
    'character:lin',
    'decision-2',
    '2026-10-15T20:14:10.100Z',
    { label: 'decision', status: 'model' },
    {
      source: 'model',
      value: {
        decision: {
          kind: 'interact',
          entityId: 'entity:brass-key',
          targetRef: { kind: 'character', id: 'character:lu' },
        },
      },
    },
  ),
  record(
    uid(8),
    'action',
    'character:lin',
    'decision-2',
    '2026-10-15T20:14:10.240Z',
    { label: 'action', status: 'accepted', durationMs: 12 },
    {
      actionId: 'action:lin:1',
      action: {
        actionId: 'action:lin:1',
        actorId: 'character:lin',
        actionType: 'interact',
        actionVersion: 1,
        parameters: { entityId: 'entity:brass-key', targetRef: { kind: 'character', id: 'character:lu' } },
      },
      status: 'accepted',
      reason: null,
      afterSeq: 65,
      headSeq: 71,
      startedAt: '2026-10-15T20:14:10.220Z',
      durationMs: 12,
      eventRefs: [66, 67, 68, 69, 70, 71],
    },
  ),
  record(
    uid(9),
    'turn',
    'character:lin',
    'decision-2',
    '2026-10-15T20:14:10.300Z',
    { label: 'turn', status: 'responded' },
    { status: 'responded', calls: 2 },
  ),

  record(
    uid(10),
    'request',
    'character:player',
    'decision-3',
    '2026-10-15T20:14:18.000Z',
    { label: '模型调用', status: 'ok', model: 'gemini-3.7-flash', durationMs: 2_460 },
    request(uid(10), 'character:player', 'decision-3', '2026-10-15T20:14:18.000Z', 2_460, {
      thinking: [{ kind: 'text', text: '我手上并没有钥匙，直接声称自己有大概会被驳回。' }],
      tool: 'interact',
    }),
  ),
  record(
    uid(11),
    'action',
    'character:player',
    'decision-3',
    '2026-10-15T20:14:20.600Z',
    { label: 'action', status: 'rejected', durationMs: 12 },
    {
      actionId: 'action:p:2',
      action: {
        actionId: 'action:p:2',
        actorId: 'character:player',
        actionType: 'interact',
        actionVersion: 1,
        parameters: { entityId: 'entity:brass-key', intent: 'claim' },
      },
      status: 'rejected',
      reason: '目标物品当前不在行动者处。',
      afterSeq: 71,
      headSeq: 72,
      startedAt: '2026-10-15T20:14:20.588Z',
      durationMs: 12,
      eventRefs: [72],
    },
  ),
  record(
    uid(12),
    'turn',
    'character:player',
    'decision-3',
    '2026-10-15T20:14:20.700Z',
    { label: 'turn', status: 'responded' },
    { status: 'responded', calls: 1 },
  ),
  record(
    uid(19),
    'request',
    'character:player',
    'decision-3b',
    '2026-10-15T20:14:21.000Z',
    { label: '模型调用', status: 'ok', model: 'gemini-3.7-flash', durationMs: 1_500 },
    request(uid(19), 'character:player', 'decision-3b', '2026-10-15T20:14:21.000Z', 1_500, {
      continuation: true,
      thinking: [{ kind: 'text', text: '动用不了钥匙，那就先把话说出去。' }],
      tool: 'speak',
    }),
  ),
  record(
    uid(20),
    'action',
    'character:player',
    'decision-3b',
    '2026-10-15T20:14:22.500Z',
    { label: 'action', status: 'accepted', durationMs: 10 },
    {
      actionId: 'action:p:3',
      action: {
        actionId: 'action:p:3',
        actorId: 'character:player',
        actionType: 'speak',
        actionVersion: 1,
        parameters: { text: '我手里这把钥匙，是刚才从前台拿的。' },
      },
      status: 'accepted',
      reason: null,
      afterSeq: 72,
      headSeq: 75,
      startedAt: '2026-10-15T20:14:22.490Z',
      durationMs: 10,
      eventRefs: [73, 74, 75],
    },
  ),
  record(
    uid(21),
    'turn',
    'character:player',
    'decision-3b',
    '2026-10-15T20:14:22.600Z',
    { label: 'turn', status: 'responded' },
    { status: 'responded', calls: 1 },
  ),

  record(
    uid(13),
    'request',
    'character:lu',
    'decision-4',
    '2026-10-15T20:14:24.000Z',
    { label: '模型调用', status: 'ok', model: 'gemini-3.7-flash', durationMs: 2_040 },
    request(uid(13), 'character:lu', 'decision-4', '2026-10-15T20:14:24.000Z', 2_040, {
      thinking: [{ kind: 'summary', text: '玩家的话与手里的实物不符，直接指出即可。' }],
      tool: 'speak',
    }),
  ),
  record(
    uid(14),
    'action',
    'character:lu',
    'decision-4',
    '2026-10-15T20:14:26.200Z',
    { label: 'action', status: 'accepted', durationMs: 11 },
    {
      actionId: 'action:lu:1',
      action: {
        actionId: 'action:lu:1',
        actorId: 'character:lu',
        actionType: 'speak',
        actionVersion: 1,
        parameters: { text: '……钥匙不是在我这儿吗？' },
      },
      status: 'accepted',
      reason: null,
      afterSeq: 76,
      headSeq: 79,
      startedAt: '2026-10-15T20:14:26.190Z',
      durationMs: 11,
      eventRefs: [77, 78, 79],
    },
  ),
  record(
    uid(15),
    'turn',
    'character:lu',
    'decision-4',
    '2026-10-15T20:14:26.300Z',
    { label: 'turn', status: 'responded' },
    { status: 'responded', calls: 1 },
  ),

  record(
    uid(16),
    'request',
    'character:lin',
    'decision-5',
    '2026-10-15T20:14:28.000Z',
    { label: '模型调用', status: 'failed', model: 'gemini-3.7-flash', durationMs: 30_000 },
    request(uid(16), 'character:lin', 'decision-5', '2026-10-15T20:14:28.000Z', 30_000, { status: 'failed' }),
  ),
  record(
    uid(17),
    'turn',
    'character:lin',
    'decision-5',
    '2026-10-15T20:14:58.100Z',
    { label: 'turn', status: 'failed' },
    { status: 'failed', calls: 1, failure: 'provider_failed' },
  ),
  record(
    uid(18),
    'turn',
    'character:player',
    null,
    '2026-10-15T20:15:00.000Z',
    { label: 'turn', status: 'silent' },
    { status: 'silent', calls: 1 },
  ),
]

export function mockDebug(characterId?: string): CreatorInspectionSnapshot {
  const characters = [
    {
      id: 'character:lin',
      name: '林澄',
      locationId: 'location:front-room',
      locationName: '前室',
      sceneIds: ['scene:front'],
      lifecycle: 'active',
      lastMovementSeq: 41,
      processing: { transport: 'ok', lastActivation: { status: 'responded', calls: 2 } },
    },
    {
      id: 'character:lu',
      name: '陆遥',
      locationId: 'location:back-room',
      locationName: '后室',
      sceneIds: ['scene:front'],
      lifecycle: 'active',
      lastMovementSeq: 79,
      processing: { transport: 'ok', lastActivation: { status: 'responded', calls: 1 } },
    },
    {
      id: 'character:player',
      name: '玩家',
      locationId: 'location:front-room',
      locationName: '前室',
      sceneIds: ['scene:front'],
      lifecycle: 'active',
      lastMovementSeq: null,
      processing: { transport: 'failed', lastActivation: { status: 'silent', calls: 1 } },
    },
  ]
  const entities = [
    {
      id: 'entity:brass-key',
      name: '黄铜钥匙',
      state: { entityId: 'entity:brass-key', name: '黄铜钥匙', holderId: 'character:lu' } as WorldJsonObject,
      holderMeaning: 'custody' as const,
      effectiveLocationId: 'location:back-room',
      locationBasis: 'holder' as const,
      lastChangeSeq: 67,
    },
    {
      id: 'entity:thermos',
      name: '保温壶',
      state: { entityId: 'entity:thermos', name: '保温壶', holderId: 'character:lin' } as WorldJsonObject,
      holderMeaning: 'custody' as const,
      effectiveLocationId: 'location:front-room',
      locationBasis: 'holder' as const,
      lastChangeSeq: 20,
    },
  ]
  const selected = characters.find(character => character.id === characterId)
  return {
    capturedAt: new Date().toISOString(),
    address,
    worldVersion: '0.1.0-preview',
    title: '雪夜旅店',
    headSeq: 80,
    tick: 44,
    packHash: 'sha256:preview',
    storyParentNodeId: null,
    busy: false,
    paused: false,
    captureEnabled: true,
    characters,
    entities,
    statusTruth: {
      public: { timeOfDay: '深夜', gateOpen: false },
      characters: { 'character:lin': { energy: 74 }, 'character:lu': { energy: 52 } },
    },
    activities: [
      {
        activityKey: 'default',
        state: 'active',
        description: '守夜',
        participantIds: ['character:lin', 'character:lu', 'character:player'],
        game: { public: { round: 2 }, private: { 'character:lin': { suspicion: 0.4 } }, internal: { seed: 91 } },
      },
    ],
    events: { items: MOCK_EVENTS.slice(-6), nextAfterSeq: 80, hasMore: false },
    ...(selected
      ? {
          character: {
            id: selected.id,
            currentView: {
              address,
              characterId: selected.id,
              asOfWorldSeq: 80,
              lifecycleState: 'active',
              locationId: selected.locationId,
              scenes: [
                { sceneId: 'scene:front', participantIds: ['character:lin', 'character:lu', 'character:player'] },
              ],
              observations: [
                {
                  id: 'observation:lin:1',
                  value: { observerId: selected.id, content: { text: '玩家把黄铜钥匙递了过来。' } },
                },
              ],
              selfObservations: [],
              claims: [],
              goals: [{ id: 'goal:lin', value: { characterId: selected.id, intent: '确认钥匙去向' } }],
              visibility: [],
              bundleHash: hash,
            } as never,
            latestRequest:
              (MOCK_RECORDS.find(item => item.kind === 'request' && item.characterId === selected.id)
                ?.data as InspectedRequest) ?? null,
            contextNotice: 'currentView 是当前 headSeq 的授权观察；它不是过去某次模型的实际请求。',
            memory: {
              mode: 'core' as const,
              archivePrefix: 70,
              sections: {
                sources: {
                  total: 12,
                  items: [
                    { id: 'source:1', name: '前台交接', kind: 'episode' },
                    { id: 'source:2', name: '雪夜封路', kind: 'fact' },
                  ],
                  hasMore: false,
                },
                facts: { total: 5, items: [{ id: 'fact:1', text: '前台只剩一把黄铜钥匙。' }], hasMore: false },
                episodes: { total: 3, items: [{ id: 'episode:1', text: '玩家把钥匙交给林澄。' }], hasMore: false },
                observations: { total: 9, items: [], hasMore: true },
              },
              maintenance: { pendingPrefix: 70, running: false },
              notice: '原生完整档案尚未接入；这里只显示 Core 已安装档案的分层分页。',
            },
          },
        }
      : {}),
    limitations: ['预览数据；未连接真实实例。'],
  }
}

export function mockHistory(): CreatorHistorySnapshot {
  return {
    scope: MOCK_SCOPE,
    selection: {
      worldVersion: MOCK_SCOPE.worldVersion,
      tailId: null,
      candidateId: 'candidate-1',
      candidateIds: ['candidate-1', 'candidate-0'],
    },
    address,
    worldVersion: MOCK_SCOPE.worldVersion,
    headSeq: 80,
    tick: 44,
    items: MOCK_HISTORY,
    nextAfterSeq: 80,
    hasMore: false,
    limitations: ['预览数据；未连接真实实例。'],
  }
}

export function mockRecords(
  query: { recordId?: string; characterId?: string; kind?: string; limit?: number; offset?: number } = {},
): CreatorRecordsSnapshot {
  const filtered = MOCK_RECORDS.filter(
    record =>
      (query.characterId === undefined || record.characterId === query.characterId) &&
      (query.kind === undefined || record.kind === query.kind),
  )
  const offset = query.offset ?? 0,
    limit = query.limit ?? 50
  const page = filtered.slice(offset, offset + limit).map(({ data: _data, ...summary }) => summary)
  return {
    scope: MOCK_SCOPE,
    captureEnabled: true,
    storageError: null,
    branches: ['main', 'candidate-0'],
    items: page,
    total: filtered.length,
    nextOffset: offset + page.length,
    hasMore: offset + page.length < filtered.length,
    record: MOCK_RECORDS.find(record => record.id === query.recordId) ?? null,
    limitations: ['预览数据；未连接真实实例。'],
  }
}

export function mockRecord(id: string): CreatorRecord | null {
  return MOCK_RECORDS.find(record => record.id === id) ?? null
}
