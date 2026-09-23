import { createPlayerIntentCandidateSchema, deterministicId, hashWorldJson, resolutionAuthority,
  type PlayerIntentAffordance, type PlayerSubmissionV2, type WorldHash, type WorldJsonObject } from '@harness-world/contracts'
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
      // A publication choice, not a world-effect verb. The Host fills its narration
      // exclusively from quoted player text; the interpreter cannot author it.
      choices.push({ affordanceId: 'narrate', actionType: 'speak', actionVersion: 1,
        parameters: { text: '', narration: '' } })
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
        const offered = { actionType: 'interact' as const,
          actionVersion: affordance.actionVersion === 2 ? 2 as const : 1 as const, parameters }
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
      // The contract is the Host's own words to the interpreter. It asks for the player's words, not for
      // arithmetic: a model that states offsets gets them wrong often enough to lose the player a turn,
      // while a verbatim quote is something the Host can find and check itself.
      contract: 'Interpret only the player intent. Select exact affordances by their affordanceId. '
        + 'Distinguish what the player COMMUNICATES from what the player EXECUTES. '
        + 'A request, question or suggestion addressed to an NPC is the player speaking, not an action '
        + 'executed for that NPC. Select speak even if the requested NPC response has no interaction option. '
        + 'For example: "GPT，先不要说话，可以只用表情或手势回应我一下吗？" is speak; '
        + '"GLM，你愿意去工作区吗？" is speak, not a player move. The NPC decides whether and how to respond. '
        + "Use narrate for the player's own freely expressed posture, expression or other minor observable "
        + 'performance, even with no dialogue: "我有点尴尬地笑了笑" is narrate. It is not a claim of an adjudicated effect. '
        + 'For a player-executed controlled change, such as "我走到工作区" or "我拿起手机", select the corresponding '
        + 'move/interact option. Do not hide unavailable or ambiguous controlled actions inside narrate or speak. '
        + "Do not invent another character's reaction or publish an asserted reaction as the player's performance. "
        + 'Copy exact source words into quotes, in source order, without rewriting or calculating offsets. '
        + 'Each speak or narrate publication takes one contiguous quote. At most two actions, at most one '
        + 'controlled world operation; a performance and dialogue may be two publications. '
        + 'For a performance followed by movement, put narrate before move. For example, '
        + '"我轻轻笑了笑，走进后室看看有没有锁。" can use narrate quote "我轻轻笑了笑" then '
        + 'move quote "走进后室看看有没有锁"; the latter expresses an intention to look, not a found result. '
        + 'Do not attach words before and after the move to one noncontiguous narrate quote, or omit a meaningful later clause. '
        + 'Use free narrate instead of encoding ordinary expressions as performance cues. '
        + "Only clarify when ambiguity changes an executed action/target, the player's own controlled action "
        + 'is unavailable, or the input cannot be interpreted reliably. A missing NPC response verb is not a reason to clarify.',
      sourceText, affordances: choices, responseSchema: createPlayerIntentCandidateSchema() } }
}
