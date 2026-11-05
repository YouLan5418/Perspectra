import { CommunicationPolicy } from '@harness-world/official-communication'
import { CommunicationRuntime } from '../../desktop/host/communication-runtime.ts'
import type { CompiledWorldManifest, RulebookResolver } from '@harness-world/kernel'
export { communicationInstruction } from '@harness-world/official-communication'
/** Experiments explicitly compose their default mechanism and the production execution adapter. */
export class CrossSceneCommunication extends CommunicationRuntime {
  constructor(config: unknown, manifest: CompiledWorldManifest, base: RulebookResolver) {
    super(new CommunicationPolicy({ config }), manifest, base)
  }
}
