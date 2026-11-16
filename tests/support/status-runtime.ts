import { StatusScripts } from '@perspectra/providers/status'
import type { CompiledWorldPackV5 } from '@perspectra/world-pack'
import type { StatusSource } from '@perspectra/sdk'
import { StatusRuntime } from '../../apps/host/src/runtime/status-runtime.ts'
import { loadStatusSource } from '../../apps/host/src/runtime/status-source.ts'
export { StatusRuntime }
export type { KnownStatus, StatusEventData } from '@perspectra/sdk/contracts'
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
