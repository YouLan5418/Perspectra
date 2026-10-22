import { createHash } from 'node:crypto'
import { canonicalizeWorldJson, type WorldJsonObject } from '@harness-world/contracts'
import type { PlayerView, FrontendActionRequest } from '@harness-world/frontend'
import type { HostState, HostAction, HostRuntime } from './http-server.ts'

const optionId = (action: HostAction) =>
  'opt:' +
  createHash('sha256')
    .update(canonicalizeWorldJson(action as unknown as WorldJsonObject))
    .digest('hex')

/** What the player fills in: the schema's properties the offer does not already fix, such as an activity's revision. */
function playerInputs(option: WorldJsonObject): WorldJsonObject | undefined {
  const schema = option.argumentSchema as WorldJsonObject | undefined
  const properties = (schema?.properties ?? {}) as WorldJsonObject
  const fixed = (option.arguments ?? {}) as WorldJsonObject
  const free = Object.keys(properties).filter(key => !Object.hasOwn(fixed, key))
  if (!free.length) return undefined
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(free.map(key => [key, structuredClone(properties[key]!)])),
    required: ((schema!.required as string[] | undefined) ?? []).filter(key => free.includes(key)),
  }
}

export function projectPlayerView(state: HostState): PlayerView {
  const actions: PlayerView['actions'] = []
  const name = (id: string) => state.actionNames?.[id] ?? id
  const running = (state.activity?.game as WorldJsonObject | undefined)?.active === true ? state.activity : undefined
  const activityTarget = (activity: NonNullable<HostState['activity']>) => ({
    kind: 'activity' as const,
    id: String(activity.activityKey ?? activity.id ?? 'default'),
    name: String(activity.title),
  })
  for (const affordance of state.availableActions ?? []) {
    if (affordance.actionType === 'move')
      for (const destination of affordance.destinations ?? []) {
        actions.push({
          id: 'move:' + destination.locationId,
          label: '前往 ' + destination.name,
          action: { actionType: 'move', parameters: { locationId: destination.locationId } },
          kind: 'move',
          target: { kind: 'location', id: destination.locationId, name: destination.name },
        })
      }
    if (affordance.actionType === 'interact')
      for (const option of affordance.interactions ?? []) {
        if (!option.targetRef || !option.definitionRef || typeof option.bindingId !== 'string') continue
        const definition = option.definitionRef as WorldJsonObject
        if (typeof definition.id !== 'string') continue
        const inputs = playerInputs(option as WorldJsonObject)
        const target = option.targetRef as WorldJsonObject
        const action: HostAction = {
          actionType: 'interact',
          parameters: {
            targetRef: structuredClone(option.targetRef),
            definitionRef: structuredClone(option.definitionRef),
            bindingId: option.bindingId,
            arguments: structuredClone(option.arguments ?? {}),
          },
        }
        const args = action.parameters.arguments as WorldJsonObject
        const targetName = state.actionNames?.[String(target.id)] ?? String(target.id)
        const recipient =
          typeof args.recipientId === 'string' ? (state.actionNames?.[args.recipientId] ?? args.recipientId) : undefined
        // The author names an action on its binding; the contact rules have a plain fallback, and any other
        // unnamed action reads as an interaction with its target rather than showing a definition ID. A
        // recipient is always named, so the same action for different people stays apart.
        const authored = state.actionLabels?.[option.bindingId]
        const label =
          definition.id.startsWith('activity:') || definition.id.startsWith('status:')
            ? String(option.label ?? definition.id)
            : (authored ??
                {
                  'base:hold-hand': '牵起 ' + targetName + ' 的手',
                  'base:end-contact': '松开 ' + targetName,
                }[definition.id] ??
                '与 ' + targetName + ' 互动') + (recipient === undefined ? '' : '（给 ' + recipient + '）')
        const targetId = String(target.id)
        const characterArguments = (state.characterArguments?.[definition.id] ?? []).filter(key =>
          Object.hasOwn((inputs?.properties ?? {}) as WorldJsonObject, key),
        )
        actions.push({
          id: optionId(action),
          label,
          action,
          kind: definition.id.startsWith('activity:') ? 'activity' : 'interact',
          // A status operation acts as the player; whom it touches, if anyone, is one of its inputs.
          target:
            definition.id.startsWith('activity:') && running
              ? activityTarget(running)
              : definition.id.startsWith('status:') && target.kind !== 'entity'
                ? { kind: 'self', id: targetId, name: state.world.playerName }
                : { kind: target.kind === 'character' ? 'character' : 'item', id: targetId, name: name(targetId) },
          ...(inputs ? { argumentSchema: inputs } : {}),
          ...(characterArguments.length ? { characterArguments } : {}),
        })
      }
  }
  const activities = state.activities ?? (state.activity ? [state.activity] : [])
  const foreground = activities.some(activity => (activity.game as WorldJsonObject | undefined)?.active === true)
  for (const activity of activities) {
    const active = (activity.game as WorldJsonObject | undefined)?.active === true
    if (!active && foreground) continue
    const quick =
      !active && activity.suspended !== true && Array.isArray(activity.quickOperations)
        ? (activity.quickOperations as WorldJsonObject[])
        : []
    if (quick.length) {
      // One-click operations replace the start entry; the host starts and applies them in one player action.
      for (const option of quick) {
        const action: HostAction = {
          actionType: 'interact',
          parameters: {
            definitionRef: { id: 'host:activity-quick', version: 1 },
            activityKey: String(activity.activityKey),
            operation: String(option.id),
          },
        }
        actions.push({
          id: optionId(action),
          label: String(option.label),
          action,
          kind: 'activity',
          target: activityTarget(activity),
        })
      }
      continue
    }
    const operation = active ? 'suspend' : activity.suspended === true ? 'resume' : 'start'
    const action: HostAction = {
      actionType: 'interact',
      parameters: {
        definitionRef: { id: 'host:activity-' + operation, version: 1 },
        ...(activity.activityKey === undefined ? {} : { activityKey: activity.activityKey }),
        previousId: activity.id ?? null,
        previousRevision: activity.revision ?? 0,
      },
    }
    const selection = operation === 'start' ? (activity.participantSelection as WorldJsonObject | undefined) : undefined
    actions.push({
      id: optionId(action),
      label: { suspend: '暂停 ', resume: '继续 ', start: '开始 ' }[operation] + activity.title,
      action,
      // Starting one is an invitation inside the story; pausing and resuming manage it from outside.
      kind: operation === 'start' ? 'activity' : 'manage',
      target: activityTarget(activity),
      ...(selection
        ? {
            participantSelection: structuredClone(selection) as unknown as NonNullable<
              PlayerView['actions'][number]['participantSelection']
            >,
          }
        : {}),
    })
    if (activity.suspended === true) {
      const abandon: HostAction = {
        ...action,
        parameters: { ...action.parameters, definitionRef: { id: 'host:activity-abandon', version: 1 } },
      }
      actions.push({
        id: optionId(abandon),
        label: '放弃 ' + activity.title,
        action: abandon,
        kind: 'manage',
        target: activityTarget(activity),
      })
    }
  }
  const background = state.busy && state.background === true
  const activityGame = state.activity?.game as WorldJsonObject | undefined
  const expressionPolicy = activityGame?.active ? (state.activity?.policy as WorldJsonObject | undefined) : undefined
  if (activityGame?.active && activityGame.turn !== (state.activity!.participants as string[])[0]) {
    const action: HostAction = {
      actionType: 'interact',
      parameters: {
        definitionRef: { id: 'host:activity-retry', version: 1 },
        previousId: state.activity!.id!,
        previousRevision: state.activity!.revision!,
      },
    }
    actions.push({
      id: optionId(action),
      label: '再次请求角色处理',
      action,
      kind: 'manage',
      target: activityTarget(state.activity!),
    })
  }
  return {
    expression: {
      speech:
        expressionPolicy?.speech === 'none' ? 'none' : expressionPolicy?.speech === 'choices' ? 'choices' : 'free',
      speechChoices: Array.isArray(expressionPolicy?.speechChoices)
        ? expressionPolicy.speechChoices.filter((value): value is string => typeof value === 'string')
        : [],
      narration: expressionPolicy?.narration !== false,
    },
    ...(state.activity
      ? {
          activity: {
            title: String(state.activity.title),
            active: activityGame?.active === true,
            phase: String(activityGame?.phase ?? 'not-started'),
            public: structuredClone(activityGame?.public ?? {}) as WorldJsonObject,
          },
        }
      : {}),
    ...(state.activities
      ? {
          activities: state.activities.map(activity => {
            const game = activity.game as WorldJsonObject | undefined
            return {
              key: String(activity.activityKey),
              title: String(activity.title),
              active: game?.active === true,
              suspended: activity.suspended === true,
              phase: String(game?.phase ?? 'not-started'),
              public: structuredClone(game?.public ?? {}) as WorldJsonObject,
            }
          }),
        }
      : {}),
    game: { title: state.world.title },
    player: { name: state.world.playerName },
    scene: state.world.currentScene
      ? {
          locationName: state.world.currentScene.locationName,
          visibleCharacters: [...state.world.currentScene.presentNpcNames],
          recipients: (state.world.currentScene.recipients ?? []).map(({ id, name }) => ({ id, name })),
        }
      : null,
    // Off-scene work stays invisible: the player sees an idle scene and acting cancels that work.
    ...(state.playerFeedback
      ? {
          feedback: background
            ? { phase: '可以输入', message: state.playerFeedback.message }
            : structuredClone(state.playerFeedback),
        }
      : {}),
    status: state.busy && !background ? 'busy' : state.error ? 'error' : state.paused ? 'paused' : 'ready',
    ...(state.canInterrupt === undefined || background ? {} : { canInterrupt: state.canInterrupt }),
    ...(state.busy && !background && state.responders?.length ? { responders: [...state.responders] } : {}),
    ...(state.playerSettings
      ? {
          settings: {
            inputCharacters: state.playerSettings.inputCharacters,
            reading: {
              fontSize: state.playerSettings.reading.fontSize,
              lineHeight: state.playerSettings.reading.lineHeight,
              autoFollow: state.playerSettings.reading.autoFollow,
            },
            ...(state.playerSettings.audio
              ? {
                  audio: {
                    volume: state.playerSettings.audio.volume,
                    muted: state.playerSettings.audio.muted,
                    voiceEnabled: state.playerSettings.audio.voiceEnabled,
                  },
                }
              : {}),
            ...(state.playerSettings.palette ? { palette: state.playerSettings.palette } : {}),
          },
        }
      : {}),
    ...(state.tailRound ? { tailRound: state.tailRound } : {}),
    ...(state.statusBar
      ? {
          statusBar: state.statusBar.map(({ key, label, holderId, holderName, self, value, current }) => ({
            key,
            label,
            holderId,
            ...(holderName === undefined ? {} : { holderName }),
            ...(self === true ? { self } : {}),
            value,
            current,
          })),
        }
      : {}),
    ...(state.statusTruth?.length
      ? {
          statusTruth: state.statusTruth.map(({ key, label, holderId, holderName, self, value }) => ({
            key,
            label,
            holderId,
            ...(holderName === undefined ? {} : { holderName }),
            ...(self === true ? { self } : {}),
            value,
          })),
        }
      : {}),
    history: state.transcript.map(line => ({
      seq: line.seq,
      speaker: line.speaker,
      ...(line.speakerId === undefined ? {} : { speakerId: line.speakerId }),
      text: line.text,
      player: line.player,
      ...(line.segments === undefined ? {} : { segments: line.segments }),
    })),
    actions,
  }
}
/** Per-running-session deduplication, including in-flight and failed results. Never evicts IDs. */
export class FrontendActions {
  #requests = new Map<string, { fingerprint: string; result: Promise<PlayerView> }>()
  constructor(readonly runtime: HostRuntime) {}
  perform(request: FrontendActionRequest): Promise<PlayerView> {
    const fingerprint = Buffer.from(
      canonicalizeWorldJson({ operation: request.operation, payload: request.payload as WorldJsonObject }),
    ).toString('utf8')
    const previous = this.#requests.get(request.actionId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new TypeError('同一 actionId 不能对应不同操作')
      return previous.result.then(async () => projectPlayerView(await this.runtime.state()))
    }
    if (this.#requests.size >= 4096) throw new RangeError('本会话操作数量达到上限，请保存后重新启动')
    const result = Promise.resolve().then(async () => {
      if (request.operation === 'cancelRegeneration') {
        if (!this.runtime.cancelRegeneration) throw new TypeError('取消不可用')
        return projectPlayerView(await this.runtime.cancelRegeneration())
      }
      if (request.operation === 'selectCandidate') {
        if (!this.runtime.selectCandidate) throw new TypeError('候选切换不可用')
        return projectPlayerView(
          await this.runtime.selectCandidate(
            request.payload.tailId as string,
            request.payload.candidateId as string,
            request.actionId,
          ),
        )
      }
      if (request.operation === 'regenerate') {
        if (!this.runtime.regenerate) throw new TypeError('重新生成不可用')
        return projectPlayerView(await this.runtime.regenerate(request.payload.tailId as string, request.actionId))
      }
      const visible = async () => projectPlayerView(await this.runtime.state()).scene?.recipients ?? []
      const checkRecipients = async (recipients: readonly unknown[] | undefined) => {
        if (!recipients?.length) return
        const present = await visible()
        if (recipients.some(id => !present.some(character => character.id === id)))
          throw new TypeError('接收对象已不在当前可见场景，请重新选择')
      }
      if (request.operation === 'speak') {
        await checkRecipients(request.payload.addresseeIds as string[] | undefined)
        const text =
          Object.hasOwn(request.payload, 'narration') || Object.hasOwn(request.payload, 'scope')
            ? '/act speak ' + JSON.stringify(request.payload)
            : (request.payload.text as string)
        return projectPlayerView(await this.runtime.submit(text))
      }
      const view = projectPlayerView(await this.runtime.state())
      const option = view.actions.find(a => a.id === request.payload.optionId)
      if (!option || !this.runtime.perform) throw new TypeError('该操作不在玩家当前可用操作中')
      const selected = request.payload.npcIds as string[] | undefined,
        selection = option.participantSelection
      if (selection) {
        if (
          !selected ||
          selected.length < selection.min ||
          selected.length > selection.max ||
          selected.some(id => !selection.candidates.some(candidate => candidate.id === id))
        )
          throw new TypeError('请选择当前可用的活动参与者')
      } else if (selected !== undefined) throw new TypeError('此操作不接受参与者选择')
      let action: HostAction = selection
        ? { ...option.action, parameters: { ...option.action.parameters, startParameters: { npcIds: selected! } } }
        : option.action
      // Player inputs fill only the offer's open fields; the rules still check them against the full schema.
      const supplied = request.payload.arguments as WorldJsonObject | undefined
      if (supplied !== undefined) {
        const open = option.argumentSchema?.properties as WorldJsonObject | undefined
        if (!open) throw new TypeError('此操作不接受参数')
        if (Object.keys(supplied).some(key => !Object.hasOwn(open, key)))
          throw new TypeError('行动参数不在可填写范围内')
        await checkRecipients(option.characterArguments?.map(key => supplied[key]).filter(id => id !== undefined))
        const fixed = action.parameters.arguments as WorldJsonObject
        action = { ...action, parameters: { ...action.parameters, arguments: { ...supplied, ...fixed } } }
      }
      const say = request.payload.say as WorldJsonObject | undefined
      if (say !== undefined) await checkRecipients(say.addresseeIds as string[] | undefined)
      if (say === undefined) return projectPlayerView(await this.runtime.perform(action))
      const order = request.payload.order === 'after' ? 'after' : 'before'
      return projectPlayerView(await this.runtime.perform(action, { speech: say, order }))
    })
    this.#requests.set(request.actionId, { fingerprint, result })
    return result
  }
}
