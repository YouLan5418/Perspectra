import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseWorldPackSourceManifestV5, type WorldPackPluginRequirement } from '@harness-world/world-pack'

/** What a world pack asks for, read without compiling the pack or running any plugin. */
export async function readPackRequirements(packPath: string): Promise<readonly WorldPackPluginRequirement[]> {
  const text = await readFile(join(packPath, 'worldpack.source.json'), 'utf8')
  return parseWorldPackSourceManifestV5(JSON.parse(text)).requiresPlugins ?? []
}

export interface InstalledPlugin {
  readonly id?: string | undefined
  readonly version?: string | undefined
  readonly enabled: boolean
}
export interface RequirementProblem {
  readonly id: string
  readonly version: string
  readonly optional: boolean
  readonly kind: 'missing' | 'disabled' | 'version'
  readonly found?: string
}

function parts(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}
function atLeast(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return true
}

/** Supports `1.2.3`, `^1.2.3` and `>=1.2.3`. Below 1.0 the caret holds the minor version, as semver does. */
export function satisfiesVersion(version: string, range: string): boolean {
  const have = parts(version)
  const match = /^(\^|>=)?(.+)$/u.exec(range.trim())
  const want = match ? parts(match[2]!) : undefined
  if (!have || !want) return false
  if (match![1] === undefined) return have.every((part, index) => part === want[index])
  if (!atLeast(have, want)) return false
  if (match![1] === '>=') return true
  return want[0] === 0 ? have[0] === 0 && have[1] === want[1] : have[0] === want[0]
}

/** Every problem at once. A plugin without a manifest id cannot satisfy a requirement. */
export function checkPluginRequirements(
  required: readonly WorldPackPluginRequirement[],
  installed: readonly InstalledPlugin[],
): RequirementProblem[] {
  return required.flatMap((requirement): RequirementProblem[] => {
    const problem = { id: requirement.id, version: requirement.version, optional: requirement.optional === true }
    const matching = installed.filter(plugin => plugin.id === requirement.id)
    if (!matching.length) return [{ ...problem, kind: 'missing' as const }]
    const enabled = matching.filter(plugin => plugin.enabled)
    if (!enabled.length) return [{ ...problem, kind: 'disabled' as const }]
    if (enabled.some(plugin => plugin.version !== undefined && satisfiesVersion(plugin.version, requirement.version)))
      return []
    return [{ ...problem, kind: 'version' as const, ...(enabled[0]!.version ? { found: enabled[0]!.version } : {}) }]
  })
}

/** Host-written, so unlike other startup errors its text may reach the player. */
export class PluginRequirementError extends Error {}

export function requirementMessage(problems: readonly RequirementProblem[]): string {
  return problems
    .map(problem =>
      problem.kind === 'missing'
        ? `缺少插件 ${problem.id}（需要 ${problem.version}）`
        : problem.kind === 'disabled'
          ? `插件 ${problem.id} 没有启用或加载失败（需要 ${problem.version}）`
          : `插件 ${problem.id} 的版本是 ${problem.found ?? '未知'}，需要 ${problem.version}`,
    )
    .join('；')
}
