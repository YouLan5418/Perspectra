import { createPlayerIntentCandidateSchema, deterministicId, hashWorldJson, resolutionAuthority,
  type ActionGroupCue, type PlayerIntentAffordance, type PlayerSubmissionV2, type WorldHash, type WorldJsonObject } from '@harness-world/contracts'
import { parsePlayerActionInput, type CompiledWorldManifest, type RulebookEvent, type RulebookResolver } from '@harness-world/kernel'
import type { PlayerInputJob } from '@harness-world/store-sqlite'
import { PlayerInputInterpreter } from './player-input.ts'
import type { PlayerIntentProfile, PreparedPlayerIntent } from './player-intent-worker.ts'

/** Called only after PlayerBinding authorization, on the head selected by the durable input FIFO. */
export function preparePlayerIntent(job: PlayerInputJob, manifest: CompiledWorldManifest, events: readonly RulebookEvent[],
  resolver: RulebookResolver, profile: PlayerIntentProfile | undefined, budget: number,
  manifestHash: WorldHash, asOfWorldSeq: number):
  PreparedPlayerIntent | { directSubmission: PlayerSubmissionV2 } | { clarification: string } {
  const actor = manifest.playerBindings.find(value => value.principalId === job.principalId)
  if (actor === undefined) throw new TypeError('player input lost its PlayerBinding')
  const input = job.input as WorldJsonObject
  const sourceText = input.text as string
  const context = { manifest, events, characterId: actor.characterId, manifestHash, asOfWorldSeq,
    resolutionAuthority: resolutionAuthority('player', 'manual_player_immediate') }
  const afforded = resolver.affordances(context)
  if (Object.hasOwn(input, 'action') || sourceText.startsWith('/')) {
    const explicit = Object.hasOwn(input, 'action') ? { status: 'resolved' as const, action: parsePlayerActionInput(input.action!) }
      : new PlayerInputInterpreter().interpret(sourceText, afforded)
    if (explicit.status === 'clarification_required') return { clarification: explicit.reason }
    // An explicit command carries no version of its own, so it takes the one the affordance it exercises
    // is offered at - the same rule the interpreted path follows.
    const offered = afforded.find(value => value.actionType === explicit.action.actionType)
    if (offered === undefined) return { clarification: 'action is not currently afforded' }
    const action = { ...explicit.action, actionVersion: offered.actionVersion, actorId: actor.characterId,
      actionId: deterministicId('action', { version: 'player-intent-action/v1', address: job.address, inputId: job.inputId, ordinal: 0 }) }
    const source = action.actionType === 'speak' ? (action.parameters as WorldJsonObject).text as string : sourceText
    return { directSubmission: { version: 'player-submission/v2', sourceText: source, sourceTextHash: hashWorldJson('player-source-text/v1', source),
      actions: [action], sourceSpans: [{ actionId: action.actionId, startUtf16: 0, endUtf16: source.length, text: source,
        kind: action.actionType === 'speak' ? 'speech' : 'action' }], interpretationProfile: 'explicit-player-command/v1',
      interpretationReceiptHash: hashWorldJson('explicit-player-command/v1', { input: job.input, action }) } }
  }
  if (profile === undefined) return { clarification: 'player_intent_provider_unavailable' }
  const choices: PlayerIntentAffordance[] = []
  for (const affordance of afforded) {
    // The version is the affordance's own, not this adapter's: a frozen world offers its interactions at
    // version 2 with a request that names a binding and a definition lock, and a world that adjudicates
    // them through a catalog offers version 1. Speech and movement are 1 either way.
    if (affordance.actionType === 'speak') {
      choices.push({ affordanceId: 'speak', actionType: 'speak', actionVersion: 1, parameters: {} })
    }
    if (affordance.actionType === 'move') {
      for (const location of manifest.locations) {
        const parameters = { locationId: location.locationId }
        if (resolver.resolve({ ...context, actionId: 'action:affordance-only', action: { actionType: 'move', parameters } }).status === 'accepted') {
          choices.push({ affordanceId: deterministicId('intent-affordance', { actionType: 'move', parameters }), actionType: 'move', actionVersion: 1, parameters })
        }
      }
    }
    if (affordance.actionType === 'interact') {
      for (const interaction of affordance.interactions ?? []) {
        const { label: _, ...parameters } = interaction
        const definitionRef = parameters.definitionRef as { readonly id: string; readonly version: number }
        // What the definition accepts rides with the choice, so the interpreter can only state a step the
        // world would take; the adjudication is still the definition's, and a cue stated without cover here
        // is refused with a clarification rather than silently dropped.
        const acceptance = (affordance.performances ?? []).find(entry =>
          entry.definitionRef.id === definitionRef.id && entry.definitionRef.version === definitionRef.version)
        const offered: { actionType: 'interact'; actionVersion: 1 | 2; parameters: WorldJsonObject
          performances?: readonly ActionGroupCue[] } =
          { actionType: 'interact', actionVersion: affordance.actionVersion === 2 ? 2 : 1, parameters,
            ...(acceptance === undefined ? {} : { performances: acceptance.accepted.map(value => value.cue) }) }
        choices.push({ affordanceId: deterministicId('intent-affordance', { actionType: 'interact', parameters }), ...offered })
      }
    }
  }
  const binding = { address: job.address, inputId: job.inputId, actorId: actor.characterId, sourceText,
    affordances: choices, interpretationProfile: `${profile.providerId}/${profile.modelId}/${profile.version}`,
    interpretationReceiptHash: hashWorldJson('player-intent-unprepared/v1', job.inputId) }
  return { binding, profile, budgetAvailable: budget >= profile.maxOutputTokens,
    request: { version: 'player-intent-request/v2', manifestHash: hashWorldJson('compiled-world-manifest', manifest),
      prefixHash: hashWorldJson('player-intent-prefix/v1', events.map(event => ({ ...event }))),
      contract: 'Interpret only the player intent. Select exact affordances. Preserve source UTF-16 spans and order. Do not turn narration about another character into speech or effects. State a step only when the player\'s words name one, and only from the cues the chosen affordance accepts. If uncertain, require clarification.',
      sourceText, affordances: choices, responseSchema: createPlayerIntentCandidateSchema() } }
}
