import type { PlayerView } from './player-view.ts'

/** Bundled default stage only. The read cursor, never a receipt, owns narration. */
export function createRpgReading() {
  type Lines = PlayerView['history']
  let ending: { key: string; visit: number; arrival: number; through: number; prefix: Lines } | undefined
  const helpers = {
    battle(view?: PlayerView) {
      const stage = view?.activityStage
      return stage?.moduleId === 'official-rpg' && stage.renderer === 'official-rpg.battle' ? stage : undefined
    },
    terminal(view: PlayerView, key: string) {
      return view.activities?.find(
        a => a.key === key && !a.active && !a.suspended && ['victory', 'defeat'].includes(a.phase),
      )
    },
    prefix(before: Lines, after: Lines) {
      return (
        before.length <= after.length && before.every((line, i) => JSON.stringify(line) === JSON.stringify(after[i]))
      )
    },
  }
  return {
    battle: helpers.battle,
    submittedSkill(
      view: PlayerView,
      option: PlayerView['actions'][number] | undefined,
      args?: Record<string, unknown>,
    ) {
      const battle = helpers.battle(view),
        parameters = option?.action.parameters
      if (!battle || !parameters || !args || typeof args.skill !== 'string') return
      const fixed = parameters.arguments as { activityId?: string; revision?: number } | undefined
      const definition = parameters.definitionRef as { id?: string } | undefined
      if (
        definition?.id !== 'activity:skill' ||
        parameters.bindingId !== battle.activityId ||
        fixed?.activityId !== battle.activityId ||
        fixed.revision !== battle.revision
      )
        return
      const skills = battle.payload.skills
      if (
        !Array.isArray(skills) ||
        !skills.some(
          skill =>
            skill &&
            typeof skill === 'object' &&
            !Array.isArray(skill) &&
            skill.name === args.skill &&
            !skill.unavailable &&
            Array.isArray(skill.targets) &&
            typeof args.target === 'string' &&
            skill.targets.includes(args.target),
        )
      )
        return
      return { name: args.skill, id: battle.activityId, revision: battle.revision }
    },
    update(before: PlayerView | undefined, after: PlayerView, openId: string | null, branchChanged: boolean) {
      if (after.status === 'paused' || after.activityStage || branchChanged || after.activities?.some(a => a.active)) {
        ending = undefined
        return
      }
      if (ending) {
        const a = helpers.terminal(after, ending.key)
        if (
          !a ||
          a.public.visit !== ending.visit ||
          a.public.arrivedAtSeq !== ending.arrival ||
          !helpers.prefix(ending.prefix, after.history)
        )
          ending = undefined
        return
      }
      const battle = helpers.battle(before)
      if (!before || !battle || openId !== battle.activityId) return
      const a = helpers.terminal(after, battle.activityKey),
        prior = before.activities?.find(a => a.active && a.key === battle.activityKey)
      if (
        !a ||
        !prior ||
        prior.phase !== 'fighting' ||
        !Array.isArray(a.public.said) ||
        !Array.isArray(prior.public.said) ||
        JSON.stringify(prior.public.said) !== JSON.stringify(a.public.said) ||
        !Array.isArray(a.public.pending) ||
        a.public.pending.length !== 0 ||
        !Number.isSafeInteger(prior.public.visit) ||
        !Number.isSafeInteger(prior.public.arrivedAtSeq) ||
        prior.public.visit !== a.public.visit ||
        prior.public.arrivedAtSeq !== a.public.arrivedAtSeq ||
        !helpers.prefix(before.history, after.history) ||
        after.history.length === before.history.length
      )
        return
      // A live aftermath or newly performed authored cue keeps the author's presentation.
      // Keep the outgoing reading surface through this authorized batch, without attributing its lines to a skill.
      ending = {
        key: a.key,
        visit: Number(a.public.visit),
        arrival: Number(a.public.arrivedAtSeq),
        through: after.history.at(-1)!.seq,
        prefix: after.history,
      }
    },
    boundary(seq: number | undefined) {
      if (ending && (seq === undefined || seq > ending.through)) ending = undefined
      return ending?.through
    },
  }
}
