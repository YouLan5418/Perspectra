import { StatusScripts } from '@harness-world/official-status'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
import type { StatusSource } from '@harness-world/plugin-sdk'
import { StatusRuntime } from '../../desktop/host/status-runtime.ts'
import { loadStatusSource } from '../../desktop/host/status-source.ts'
export { StatusRuntime }
export type { KnownStatus, StatusEventData } from '@harness-world/contracts'
export function statusFromSource(source: string | StatusSource, pack: CompiledWorldPackV5): StatusRuntime {
  return new StatusRuntime(
    new StatusScripts(typeof source === 'string' ? { script: source, modules: [] } : source),
    pack.content.characters.map(c => c.characterId),
    pack.content.entities ?? [],
  )
}
export function loadStatus(path: string, pack: CompiledWorldPackV5): StatusRuntime | undefined {
  const source = loadStatusSource(path, pack)
  return source === undefined ? undefined : statusFromSource(source, pack)
}
