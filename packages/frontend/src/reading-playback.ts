import type { PlayerView } from './player-view.ts'

/** Embedded into the sandbox script via toString(): keep this function self-contained.
 * Reading is local presentation. Advancing this cursor never submits a world action. */
export function createReadingPlayback() {
  type Line = PlayerView['history'][number]
  type Unit = {
    seq: number
    segmentIndex: number
    speaker: string
    speakerId?: Line['speakerId']
    text: string
    type: string
    player: boolean
  }
  let lines: Line[] = [],
    units: Unit[] = [],
    cursor = 0,
    initialized = false
  let heldScene: PlayerView['scene'] | undefined,
    sceneInvalidated = false
  // An object method avoids captured transpiler naming helpers in the embedded function.
  const helpers = {
    flatten(history: Line[]): Unit[] {
      return history.flatMap(line =>
        (line.segments?.length ? line.segments : [{ type: 'speech', text: line.text }]).flatMap(
          (segment, segmentIndex) =>
            segment.text.trim()
              ? [
                  {
                    seq: line.seq,
                    segmentIndex,
                    speaker: line.speaker,
                    ...(line.speakerId === undefined ? {} : { speakerId: line.speakerId }),
                    text: segment.text,
                    type: segment.type,
                    player: line.player,
                  },
                ]
              : [],
        ),
      )
    },
  }
  return {
    update(history: Line[]) {
      let prefix = 0
      while (
        prefix < lines.length &&
        prefix < history.length &&
        JSON.stringify(lines[prefix]) === JSON.stringify(history[prefix])
      )
        prefix++
      if (initialized && prefix === lines.length && prefix === history.length) return
      const retained = helpers.flatten(history.slice(0, prefix)).length
      units = helpers.flatten(history)
      if (!initialized) cursor = Math.max(0, helpers.flatten(history.slice(0, -1)).length)
      else if (prefix < lines.length) {
        cursor = Math.min(cursor, retained)
        sceneInvalidated = true
      }
      lines = structuredClone(history)
      initialized = true
    },
    current() {
      return units[cursor] ?? units.at(-1)
    },
    advance() {
      if (cursor < units.length) cursor++
    },
    skip() {
      cursor = units.length
    },
    pending() {
      return cursor < units.length
    },
    remaining() {
      return Math.max(0, units.length - cursor)
    },
    invalidateScene() {
      sceneInvalidated = true
    },
    stageScene(scene: PlayerView['scene']) {
      const reached =
        cursor >= units.length || (scene?.changedAt !== undefined && (units[cursor]?.seq ?? 0) >= scene.changedAt)
      if (heldScene === undefined || sceneInvalidated || reached) {
        heldScene = structuredClone(scene)
        sceneInvalidated = false
      }
      return heldScene
    },
  }
}
