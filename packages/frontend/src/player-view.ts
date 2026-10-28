import { canonicalizeWorldJson, type CharacterId, type WorldJsonObject } from '@harness-world/contracts'

export interface PlayerAction {
  readonly actionType: 'move' | 'interact'
  readonly parameters: WorldJsonObject
}

export interface PlayerView {
  game: { title: string }
  player: { name: string }
  scene: {
    locationId?: string
    /** Seq of the latest change to the player's place or company: show it once reading gets there. */
    changedAt?: number
    locationName: string
    visibleCharacters: string[]
    recipients: { id: string; name: string }[]
  } | null
  /** `private` is the player's own record in the activity, such as a role dealt only to them. */
  activity?: { title: string; active: boolean; phase: string; public: WorldJsonObject; private: WorldJsonObject }
  activities?: {
    key: string
    title: string
    active: boolean
    suspended: boolean
    phase: string
    public: WorldJsonObject
    private: WorldJsonObject
  }[]
  status: 'ready' | 'busy' | 'paused' | 'error'
  canInterrupt?: boolean
  /** In-scene roles currently forming a response; off-scene roles are never listed. */
  responders?: string[]
  expression?: { speech: 'free' | 'none' | 'choices'; speechChoices: string[]; narration: boolean }
  feedback?: { phase: string; message: string }
  settings?: {
    inputCharacters: number
    reading: { fontSize: number; lineHeight: number; autoFollow: boolean; autoSpeed?: number }
    audio?: { volume: number; muted: boolean; voiceEnabled: boolean }
    /** The player's chosen appearance for the stage; absent means follow the system. */
    appearance?: 'system' | 'light' | 'dark'
  }
  tailRound?: {
    candidateIds?: readonly string[]
    candidateIndex?: number
    id: string | null
    worldVersion: string
    canRegenerate: boolean
    regenerating: boolean
  }
  /** The player's own known status values; `current:false` is a last confirmed value. Never the true values. */
  /** `self` marks the player's own statuses by holder ID; display names may collide. */
  statusBar?: {
    key: string
    label: string
    holderId: string | null
    holderName?: string
    self?: boolean
    value: import('@harness-world/contracts').WorldJsonValue
    current: boolean
    /** The author pinned this status to the status bar (`bar: true`); the rest belong in a status panel. */
    pinned?: true
  }[]
  /** True values of statuses the author declared `playerTruth`; absent otherwise. Showing them is the frontend's choice. */
  statusTruth?: {
    key: string
    label: string
    holderId: string | null
    holderName?: string
    self?: boolean
    value: import('@harness-world/contracts').WorldJsonValue
  }[]
  /** Items the player can see now: `held` by the player, lying `here`, or `with` someone present (since a
   * handover the player saw). `kind` is the item's current look as the author wrote it. */
  items?: {
    id: string
    name: string
    kind: string
    where: 'held' | 'here' | 'with'
    holderId?: string
    holderName?: string
  }[]
  history: {
    seq: number
    speaker: string
    speakerId?: CharacterId
    text: string
    player: boolean
    segments?: readonly import('@harness-world/contracts').ExpressionSegment[]
    /** The player let this round pass (the `wait` action). `text` is empty; show what you like, or nothing. */
    pause?: true
  }[]
  /**
   * Every choice the player can take now, whichever script offers it. `kind` separates moving, acting in the
   * world, an activity's own moves and managing an activity from outside the story; `target` is what the
   * choice is about, so a frontend can list it under that character, item or place.
   */
  actions: {
    id: string
    label: string
    action: PlayerAction
    kind: 'move' | 'interact' | 'activity' | 'manage'
    target?: { kind: 'location' | 'item' | 'character' | 'self' | 'activity'; id: string; name: string }
    /** Inputs the player fills in; perform then carries them as `arguments`. Never includes fixed inputs. */
    argumentSchema?: WorldJsonObject
    /** Inputs among `argumentSchema` that name a character in the player's scene. */
    characterArguments?: string[]
    participantSelection?: { min: number; max: number; candidates: { id: string; name: string }[] }
  }[]
}
export function playerViewPatch(before: PlayerView, after: PlayerView): Record<string, unknown> | null {
  const changes: Record<string, unknown> = {}
  for (const key of [
    'game',
    'player',
    'scene',
    'status',
    'canInterrupt',
    'responders',
    'expression',
    'actions',
    'tailRound',
    'settings',
    'activity',
    'activities',
    'feedback',
    'statusBar',
    'statusTruth',
    'items',
  ] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = after[key]
  }
  if (JSON.stringify(before.history) !== JSON.stringify(after.history)) {
    const prefix =
      before.history.length <= after.history.length &&
      before.history.every((line, i) => JSON.stringify(line) === JSON.stringify(after.history[i]))
    if (prefix) changes.historyAppend = after.history.slice(before.history.length)
    else changes.history = after.history
  }
  return Object.keys(changes).length ? changes : null
}
export interface FrontendActionRequest {
  requestId: string
  actionId: string
  operation: 'speak' | 'perform' | 'regenerate' | 'selectCandidate' | 'cancelRegeneration'
  payload: Record<string, unknown>
}
export function frontendActionRequest(value: unknown, maximumCharacters = 2000): FrontendActionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('前端请求无效')
  const r = value as Record<string, unknown>
  if (
    Object.keys(r).sort().join(',') !== 'actionId,operation,payload,requestId' ||
    typeof r.requestId !== 'string' ||
    !/^[a-zA-Z0-9:-]{1,100}$/.test(r.requestId) ||
    typeof r.actionId !== 'string' ||
    !/^[a-zA-Z0-9:-]{1,100}$/.test(r.actionId) ||
    !['speak', 'perform', 'regenerate', 'selectCandidate', 'cancelRegeneration'].includes(String(r.operation)) ||
    !r.payload ||
    typeof r.payload !== 'object' ||
    Array.isArray(r.payload)
  )
    throw new TypeError('前端请求字段无效')
  const payload = r.payload as Record<string, unknown>
  if (r.operation === 'speak')
    return {
      requestId: r.requestId,
      actionId: r.actionId,
      operation: 'speak',
      payload: speech(payload, maximumCharacters),
    }
  if (r.operation === 'cancelRegeneration') {
    if (Object.keys(payload).length) throw new TypeError('取消不接受额外参数')
    return { requestId: r.requestId, actionId: r.actionId, operation: 'cancelRegeneration', payload: {} }
  }
  if (r.operation === 'selectCandidate') {
    if (
      Object.keys(payload).sort().join(',') !== 'candidateId,tailId' ||
      ![payload.tailId, payload.candidateId].every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id))
    )
      throw new TypeError('候选切换须引用当前回合和候选')
    return {
      requestId: r.requestId,
      actionId: r.actionId,
      operation: 'selectCandidate',
      payload: { tailId: payload.tailId, candidateId: payload.candidateId },
    }
  }
  if (r.operation === 'regenerate') {
    if (
      Object.keys(payload).join(',') !== 'tailId' ||
      typeof payload.tailId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(payload.tailId)
    )
      throw new TypeError('重新生成须引用当前末端回合')
    return {
      requestId: r.requestId,
      actionId: r.actionId,
      operation: 'regenerate',
      payload: { tailId: payload.tailId },
    }
  }
  if (
    Object.keys(payload).some(key => !['optionId', 'npcIds', 'arguments', 'say', 'order'].includes(key)) ||
    typeof payload.optionId !== 'string' ||
    payload.optionId.length > 512
  )
    throw new TypeError('行动须引用玩家当前可用的 optionId')
  if (
    Object.hasOwn(payload, 'npcIds') &&
    (!Array.isArray(payload.npcIds) ||
      payload.npcIds.length > 8 ||
      payload.npcIds.some(id => typeof id !== 'string' || !id || id.length > 200) ||
      new Set(payload.npcIds).size !== payload.npcIds.length)
  )
    throw new TypeError('活动参与者选择无效')
  const args = payload.arguments
  if (args !== undefined) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('行动参数必须是对象')
    canonicalizeWorldJson(args as WorldJsonObject)
    if (JSON.stringify(args).length > 16384) throw new RangeError('行动参数过长')
  }
  if (Object.hasOwn(payload, 'order') && !Object.hasOwn(payload, 'say')) throw new TypeError('没有发言时不能指定顺序')
  if (payload.order !== undefined && payload.order !== 'before' && payload.order !== 'after')
    throw new TypeError('发言顺序只能是 before 或 after')
  const say =
    payload.say === undefined
      ? undefined
      : speech(
          !payload.say || typeof payload.say !== 'object' || Array.isArray(payload.say)
            ? {}
            : (payload.say as Record<string, unknown>),
          maximumCharacters,
        )
  return {
    requestId: r.requestId,
    actionId: r.actionId,
    operation: 'perform',
    payload: {
      optionId: payload.optionId,
      ...(Object.hasOwn(payload, 'npcIds') ? { npcIds: payload.npcIds } : {}),
      ...(args === undefined ? {} : { arguments: args }),
      ...(say === undefined ? {} : { say, order: payload.order ?? 'before' }),
    },
  }
}

/** A player line: speech, optional narration and its audience, normalized the same for speak and perform. */
function speech(payload: Record<string, unknown>, maximumCharacters: number): Record<string, unknown> {
  if (
    Object.keys(payload).some(key => !['text', 'narration', 'scope', 'addresseeIds'].includes(key)) ||
    typeof payload.text !== 'string' ||
    (Object.hasOwn(payload, 'narration') && typeof payload.narration !== 'string')
  )
    throw new TypeError('发言字段无效')
  const scope = payload.scope ?? 'scene_public'
  const recipients = payload.addresseeIds ?? []
  if (
    typeof scope !== 'string' ||
    !['scene_public', 'direct', 'private', 'self'].includes(scope) ||
    !Array.isArray(recipients) ||
    recipients.some(id => typeof id !== 'string' || !id || id.length > 200) ||
    recipients.length > 64 ||
    new Set(recipients).size !== recipients.length ||
    (scope === 'direct' || scope === 'private' ? recipients.length === 0 : recipients.length !== 0)
  )
    throw new TypeError('发言范围与接收对象不匹配')
  const text = payload.text.replace(/\r\n?/gu, '\n').trim()
  const narration =
    typeof payload.narration === 'string' ? payload.narration.replace(/\r\n?/gu, '\n').trim() : undefined
  if (!(text || narration) || text.length + (narration?.length ?? 0) > maximumCharacters)
    throw new RangeError(`发言与描写合计需为 1 至 ${maximumCharacters} 个字符`)
  return {
    text,
    ...(narration === undefined ? {} : { narration }),
    ...(Object.hasOwn(payload, 'scope') || Object.hasOwn(payload, 'addresseeIds')
      ? { scope, addresseeIds: recipients }
      : {}),
  }
}
