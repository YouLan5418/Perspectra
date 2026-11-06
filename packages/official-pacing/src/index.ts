import { Script, createContext } from 'node:vm'
import { SCRIPT_SOURCE_LIMIT, type WorldJsonValue } from '@harness-world/contracts'
import type {
  PacingBeatInput,
  PacingCandidate,
  PacingChoice,
  PacingHistory,
  PacingInstance,
  PacingIntensity,
  PacingSource,
  SeamProvider,
} from '@harness-world/plugin-sdk'
import { choosePaced } from './choose.ts'
import { parsePacingDefinition, type PacingDefinition } from './definition.ts'

const INPUT_LIMIT = 1024 * 1024,
  OUTPUT_LIMIT = 65536

/** Interprets the author's scripts/pacing.js. Returns data only; it has no store and commits nothing. */
export class PacingScript implements PacingInstance {
  readonly #script: Script | undefined
  readonly #definition: PacingDefinition | undefined
  readonly managedActivities: readonly string[]
  readonly beats: readonly string[]
  readonly progress: { readonly statuses: readonly string[]; readonly activities: readonly string[] }
  constructor(source: PacingSource | undefined) {
    if (source === undefined) {
      this.managedActivities = []
      this.beats = []
      this.progress = { statuses: [], activities: [] }
      return
    }
    if (Buffer.byteLength(source.script) > SCRIPT_SOURCE_LIMIT) throw new RangeError('节奏脚本过长')
    this.#script = new Script(
      source.script +
        '\nJSON.stringify(__method === "definition" ? pacingScript.definition' +
        ' : __method === "beats" ? Object.keys(pacingScript.beats ?? {})' +
        ' : pacingScript.beats[__beat][__method](...JSON.parse(__args)))',
      { filename: 'scripts/pacing.js' },
    )
    this.#definition = parsePacingDefinition(this.#call('definition', undefined, []))
    const implemented = this.#call('beats', undefined, []) as string[]
    const declared = Object.keys(this.#definition.beats)
    for (const id of declared) if (!implemented.includes(id)) throw new TypeError(`节拍 ${id} 已声明但脚本里没有实现`)
    for (const id of implemented)
      if (!declared.includes(id)) throw new TypeError(`节拍 ${id} 有实现但没有在 definition.beats 声明`)
    this.managedActivities = Object.keys(this.#definition.activities)
    this.beats = declared
    this.progress = this.#definition.stagnation?.progress ?? { statuses: [], activities: [] }
  }
  intensity(candidate: PacingCandidate): PacingIntensity {
    const table = candidate.kind === 'activity' ? this.#definition?.activities : this.#definition?.beats
    const intensity = table?.[candidate.key]
    if (intensity === undefined) throw new TypeError(`节奏没有管理 ${candidate.key}`)
    return intensity
  }
  checks(beatId: string, input: PacingBeatInput): unknown {
    return this.#call('when', beatId, [input.truth, input.world] as unknown as WorldJsonValue[])
  }
  choose(input: {
    readonly candidates: readonly PacingCandidate[]
    readonly history: PacingHistory
    readonly random: () => number
  }): PacingChoice {
    if (!this.#definition) return { kind: 'none', reason: { why: 'no-script' } }
    return choosePaced(this.#definition, input)
  }
  apply(beatId: string, input: PacingBeatInput, random: () => number): unknown {
    return this.#call('apply', beatId, [input.truth, input.world] as unknown as WorldJsonValue[], random)
  }
  #call(method: string, beat: string | undefined, args: readonly WorldJsonValue[], random?: () => number): unknown {
    const input = JSON.stringify(args)
    if (input.length > INPUT_LIMIT) throw new RangeError('节奏脚本输入过长')
    const context = createContext(
      Object.assign(Object.create(null), {
        __method: method,
        __beat: beat,
        __args: input,
        ...(random ? { __random: random } : {}),
      }),
      { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' },
    )
    let output: unknown
    try {
      if (random) new Script('Math.random = __random').runInContext(context, { timeout: 100 })
      output = this.#script!.runInContext(context, { timeout: 100 })
    } catch (error) {
      throw new TypeError('节奏脚本执行失败或超时：' + (error instanceof Error ? error.message : String(error)))
    }
    if (typeof output !== 'string' || output.length > OUTPUT_LIMIT) throw new TypeError('节奏脚本必须返回有限 JSON')
    return JSON.parse(output)
  }
}

export const officialPacingProvider: SeamProvider<PacingInstance> = {
  id: 'official-pacing',
  version: '1.0.0',
  open: async world => new PacingScript(world.pacingSource),
}
