import type { WorldJsonObject } from '@harness-world/contracts'
import type { LlmTransportInstance, SeamProvider } from '@harness-world/plugin-sdk'
import type { RuntimeRoleModels } from '../model-connections.ts'

/** In-process transport only: Default DecisionService and the official prompt/preset path remain in force. */
export class ScriptedModel {
  readonly inputs: { characterId: string; input: WorldJsonObject }[] = []
  decide: (characterId: string, input: WorldJsonObject) => WorldJsonObject = () => ({ decision: 'abstain' })
  // Host metadata only. The selected transport never opens an endpoint or reads credentials.
  readonly models: RuntimeRoleModels = {
    default: {
      decision: { protocol: 'openai', endpoint: 'http://invalid.invalid', model: 'lens-scripted' },
      memory: { protocol: 'openai', endpoint: 'http://invalid.invalid', model: 'lens-scripted' },
    },
    characters: {},
  }
  readonly provider: SeamProvider<LlmTransportInstance> = {
    id: 'lens-scripted-transport',
    version: '1',
    open: async () => ({
      model: 'lens-scripted',
      schemaMode: 'native',
      send: async (characterId, call, signal) => {
        signal.throwIfAborted()
        const content = call.messages.findLast(message => message.role === 'user')?.content
        if (!content) throw new TypeError('Lens requires the official JSON decision request')
        const input = JSON.parse(content) as WorldJsonObject
        this.inputs.push({ characterId, input: structuredClone(input) })
        return { value: this.decide(characterId, input) }
      },
    }),
  }
}
