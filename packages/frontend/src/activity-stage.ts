import type { ActivityStageRenderer } from '@perspectra/sdk/contracts'
import type { PlayerView } from './player-view.ts'
export const ACTIVITY_STAGE_HTML =
  '<section id="activity-stage" class="activity-stage" aria-label="活动专属界面" tabindex="-1" hidden></section>'
export const ACTIVITY_STAGE_STYLE =
  '.activity-stage[hidden]{display:none!important}.activity-stage{position:fixed;inset:0;z-index:1000;overflow:auto;box-sizing:border-box;background:var(--ink-0,#faf9f6);color:var(--text,#222)}'
/** Self-contained browser controller. Registered renderers receive payload + current activity operations only. */
export function createActivityStage(
  root: HTMLElement,
  registrations: readonly ActivityStageRenderer[],
  perform: (id: string, args: Record<string, unknown>) => void,
  read: () => void,
) {
  const renderers = new Map(registrations.map(row => [row.id, row]))
  let mounted: ReturnType<ActivityStageRenderer['create']> | undefined,
    key = '',
    current: PlayerView | undefined,
    blocked = true,
    identity = '',
    sent = '',
    generation = 0
  const lifecycle = {
    invalidate() {
      current = undefined
      identity = ''
      blocked = true
      this.dispose()
    },
    dispose() {
      generation++
      const old = mounted
      mounted = undefined
      key = ''
      root.replaceChildren()
      root.className = 'activity-stage'
      try {
        old?.dispose?.()
      } catch {
        /* optional display cleanup cannot block the host */
      }
    },
  }
  return {
    clear() {
      lifecycle.invalidate()
    },
    update(view: PlayerView, disabled: boolean, reading: boolean, dialogue: string, notice: string) {
      const becameReady = blocked && !disabled
      current = view
      blocked = disabled
      const stage = view.activityStage
      if (!stage) {
        lifecycle.invalidate()
        return
      }
      const nextIdentity = JSON.stringify([
        stage.moduleId,
        stage.renderer,
        stage.activityId,
        stage.revision,
        view.tailRound?.worldVersion,
        view.tailRound?.id,
        view.tailRound?.candidateIds?.[(view.tailRound.candidateIndex ?? 1) - 1],
      ])
      if (nextIdentity !== identity || becameReady) sent = ''
      identity = nextIdentity
      const mountKey = JSON.stringify([stage.moduleId, stage.renderer, stage.activityId])
      const renderer = renderers.get(stage.renderer)
      if (!renderer || renderer.moduleId !== stage.moduleId) {
        lifecycle.invalidate()
        throw Error('Unknown activity stage')
      }
      if (key !== mountKey) {
        lifecycle.dispose()
        try {
          mounted = renderer.create(root)
          key = mountKey
        } catch (error) {
          lifecycle.invalidate()
          throw error
        }
      }
      const actions = view.actions.filter(
        option =>
          (option.kind === 'activity' || option.kind === 'manage') &&
          option.target?.kind === 'activity' &&
          option.target.id === stage.activityKey,
      )
      const snapshot = identity,
        epoch = generation
      try {
        mounted!.update(stage.payload, {
          identity,
          actions,
          disabled: disabled || sent === snapshot,
          reading,
          dialogue,
          notice,
          perform(id, args = {}) {
            if (
              generation !== epoch ||
              blocked ||
              sent === snapshot ||
              identity !== snapshot ||
              !current?.activityStage ||
              current.activityStage.activityId !== stage.activityId ||
              !actions.some(option => option.id === id) ||
              !current.actions.some(option => option.id === id)
            )
              return
            sent = snapshot
            blocked = true
            perform(id, args)
          },
          read() {
            if (generation === epoch && identity === snapshot) read()
          },
        })
      } catch (error) {
        lifecycle.invalidate()
        throw error
      }
    },
  }
}
/** Registration is host code only, frozen per server asset bundle. Duplicates fail before serving. */
export function activityStageRendererSource(renderers: readonly ActivityStageRenderer[]): {
  script: string
  style: string
} {
  const ids = new Set<string>()
  for (const row of renderers) {
    if (
      !/^[a-z][a-z0-9.-]{0,79}$/u.test(row.id) ||
      ids.has(row.id) ||
      !row.moduleId ||
      typeof row.create !== 'function' ||
      typeof row.style !== 'string'
    )
      throw new TypeError('ACTIVITY_STAGE_REGISTRATION_INVALID')
    ids.add(row.id)
  }
  return {
    script:
      '[' +
      renderers
        .map(
          row =>
            '({id:' +
            JSON.stringify(row.id) +
            ',moduleId:' +
            JSON.stringify(row.moduleId) +
            ',create:(' +
            (/^(?:function|\(|[a-zA-Z_$][\w$]*\s*=>)/u.test(row.create.toString())
              ? row.create.toString()
              : 'function ' + row.create.toString()) +
            ')})',
        )
        .join(',') +
      ']',
    style: renderers.map(row => row.style).join('\n'),
  }
}
