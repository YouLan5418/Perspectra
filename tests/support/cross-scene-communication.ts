import { CommunicationPolicy } from '@perspectra/providers/communication'
import { CommunicationRuntime } from '../../apps/host/src/runtime/communication-runtime.ts'
import type { CompiledWorldManifest, RulebookResolver } from '@perspectra/core/kernel'
export { communicationInstruction } from '@perspectra/providers/communication'
/** Experiments explicitly compose their default mechanism and the production execution adapter. */
export class CrossSceneCommunication extends CommunicationRuntime {
  constructor(config: unknown, manifest: CompiledWorldManifest, base: RulebookResolver) {
    super(new CommunicationPolicy({ config }), manifest, base)
  }
}
