import { isDeepStrictEqual } from 'node:util'
import type { ActivityGame, ActivityState, WorldJsonObject } from '@perspectra/sdk/contracts'
import type { OfficialRpgBattleView } from '../official-pack-metadata.ts'
import type { LensSimulation } from '../simulation/simulation.ts'
import { op, playerControls, session, withRpgTrial } from './rpg-trial.ts'
import type { RpgCue } from './rpg-cues.ts'
import { EditConflict } from './project.ts'

type Observed = {
  index: number
  actor: string
  phase: string
  round: number
  seq: number
  description: string
  speech?: string
  speechSeq?: number
  skill?: string
  target?: { id: string; before: number; after: number }
}
function hpOf(game: ActivityGame, id: string) {
  const units = game.public.units
  if (Array.isArray(units))
    for (const unit of units) {
      if (unit && typeof unit === 'object' && !Array.isArray(unit) && unit.id === id && typeof unit.hp === 'number')
        return unit.hp
    }
  return undefined
}
// An update can advance to the next round. The previous revision identifies the phase and round of the actual action.
function observed(events: ReturnType<LensSimulation['events']>, key: string, cues: RpgCue[]) {
  const evidence = new Map<number, Observed>()
  const unavailable = new Map<number, string>()
  let previous: ActivityGame | undefined
  const speeches = new Map<string, { seq: number; text: string; actor: string }>()
  for (const e of events) {
    const d = e.data as WorldJsonObject
    if (e.eventType === 'character.speak' && d.scope === 'scene_public') {
      const speech = {
        seq: e.seq,
        actor: String(d.characterId),
        text: Array.isArray(d.segments)
          ? d.segments
              .flatMap(s => (s && typeof s === 'object' && !Array.isArray(s) && s.type === 'speech' ? [s.text] : []))
              .join('')
          : String(d.text),
      }
      speeches.set(e.transactionId, speech)
      const index = previous?.public.lastCue
      const row = typeof index === 'number' ? evidence.get(index) : undefined
      if (row && !row.speechSeq && row.actor === speech.actor && cues[row.index]?.say === speech.text) {
        row.speech = speech.text
        row.speechSeq = speech.seq
      }
    }
    if (e.eventType !== 'activity.updated' || d.activityKey !== key) continue
    const game = (d.state as ActivityState).game
    if (Array.isArray(game.public.noted))
      for (const index of game.public.noted) {
        if (typeof index === 'number' && !unavailable.has(index))
          unavailable.set(index, String(game.public.lastResult || d.description || '本次演出技能不可用'))
      }
    if (previous && Array.isArray(game.public.said)) {
      for (const index of game.public.said) {
        if (typeof index !== 'number') continue
        const cue = cues[index]
        if (!cue || cue.characterId !== d.actorId) continue
        const existing = evidence.get(index)
        const skillAction = !!cue.skill && d.operation === 'skill' && game.public.lastCue === index
        const speech = d.operation === 'published' ? speeches.get(e.transactionId) : undefined
        const activeSpeech =
          previous.phase === 'fighting'
            ? cue.when === 'turn' && cue.round === previous.round && previous.turn === cue.characterId
            : Array.isArray(previous.public.pending) && previous.public.pending[0] === index
        const spoke = activeSpeech && !!speech && speech.actor === cue.characterId && speech.text === cue.say
        if (!existing && (skillAction || (!cue.skill && spoke))) {
          const before = cue.target ? hpOf(previous, cue.target) : undefined,
            after = cue.target ? hpOf(game, cue.target) : undefined
          evidence.set(index, {
            index,
            actor: cue.characterId,
            phase: previous.phase,
            round: previous.round,
            seq: e.seq,
            description: String(d.description ?? ''),
            ...(skillAction ? { skill: cue.skill! } : {}),
            ...(skillAction && cue.target && before !== undefined && after !== undefined
              ? { target: { id: cue.target, before, after } }
              : {}),
          })
        }
        const row = evidence.get(index)
        if (row && spoke && !row.speechSeq) {
          row.speech = speech.text
          row.speechSeq = speech.seq
        }
      }
    }
    previous = game
  }
  return { history: [...evidence.values()], game: previous, unavailable }
}

export async function playRpgCue(source: string, body: Record<string, unknown>, signal?: AbortSignal) {
  return withRpgTrial(source, async (stage, book) => {
    const cfg = book.config!,
      map = cfg.maps?.find(m => m.locationId === body.location)
    const index = body.index
    if (!map || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || !map.scripted?.[index])
      throw new TypeError('请选择地图及有效的演出行（index 从 0 开始）')
    const cues = map.scripted,
      cue = cues[index]!,
      activity = book.activities.find(a => a.location === map.locationId)!
    if (body.expected !== undefined && !isDeepStrictEqual(body.expected, cue))
      throw new EditConflict('遭遇演出 ' + (index + 1), body.expected, cue, body.expected)
    const warning = activity.cues.find(c => c.index === index)?.warning
    if (warning) throw new TypeError(warning)
    const scene = book.scenes.find(s => s.location === map.locationId)
    if (!scene) throw new TypeError('该地图还没有可用于试玩的场景')
    const npcs = Object.keys(cfg.characters).filter(id => id !== book.player)
    const scenes = Object.fromEntries([book.player, ...npcs].map(id => [id, scene.id]))
    return session(stage, { scenes }, signal, async sim => {
      const controls = playerControls(sim, book.player, signal),
        key = activity.key
      // Unscripted NPC combat turns defend. The pack's own performance takes precedence.
      sim.setNpcPlans(
        Object.fromEntries(
          npcs.map(id => [
            id,
            Array.from({ length: 64 }, () => ({ kind: 'perform' as const, interact: 'activity:guard' })),
          ]),
        ),
      )
      let view = await controls.view()
      if (!view.activity?.active) {
        const start = view.actions.find(
          a => op(a) === 'host:activity-start' && a.target?.id === key && !a.participantSelection,
        )
        if (start) view = await controls.performOption(start)
        else {
          await controls.step({ kind: 'wait' })
          view = await controls.view()
        }
      }
      let reason = '达到 64 步试玩上限'
      for (let step = 0; ; step++) {
        const { history, game, unavailable } = observed(sim.events(), key, cues)
        const found = history.find(row => row.index === index)
        const played = !!found && (!cue.say || found.speech === cue.say)
        const noted = unavailable.has(index)
        const a = view.activity
        if (noted) reason = unavailable.get(index)!
        else if (!game?.active || a?.key !== key || !a.active || !a.id || a.revision === undefined)
          reason = '遭遇已结束或不在前台'
        if (
          played ||
          noted ||
          !game?.active ||
          a?.key !== key ||
          !a.active ||
          !a.id ||
          a.revision === undefined ||
          step >= 64
        )
          return { played, location: map.locationId, index, history, phase: game?.phase, reason: played ? '' : reason }
        const offers = view.actions.filter(o => o.target?.id === key)
        const has = (name: string) => offers.some(o => op(o) === 'activity:' + name)
        let operation = has('engage') ? 'engage' : 'guard',
          parameters: WorldJsonObject = {}
        if (cue.when === 'enemy-defeated' && has('skill') && view.activityStage?.renderer === 'official-rpg.battle') {
          const battle = view.activityStage.payload as unknown as OfficialRpgBattleView
          const enemies = battle.units.filter(u => u.team === 'enemy' && u.hp > 0)
          const skill = battle.skills.find(
            s =>
              !s.unavailable &&
              cfg.skills?.some(def => def.name === s.name && def.effects.some(f => f.kind === 'damage')) &&
              s.targets.some(t => enemies.some(e => e.name === t)),
          )
          if (skill) {
            operation = 'skill'
            parameters = { skill: skill.name, target: skill.targets.find(t => enemies.some(e => e.name === t))! }
          }
        }
        if (has(operation)) {
          await controls.step({
            kind: 'activity',
            request: { activityKey: key, activityId: a.id, revision: a.revision, operation, parameters },
          })
          view = await controls.view()
        } else {
          const retry = offers.find(o => op(o) === 'host:activity-retry')
          if (retry) {
            view = await controls.performOption(retry)
            if (view.activity?.revision !== a.revision) continue
          }
          return {
            played: false,
            location: map.locationId,
            index,
            history,
            phase: game.phase,
            reason: '当前回合没有可推进的操作',
          }
        }
      }
    })
  })
}
