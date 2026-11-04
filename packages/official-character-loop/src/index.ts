import type { CharacterLoopInstance, SeamProvider } from '@harness-world/plugin-sdk'

/** The default policy; all reads, decisions and submissions use the same capabilities as plugins. */
export const officialCharacterLoop: CharacterLoopInstance = {
  async run(activation) {
    const maxCalls = activation.continuation ? 2 : activation.maxCalls
    const continuing = activation.continueAfterPublish && !activation.continuation && maxCalls >= 2
    const maximumSteps = continuing ? 3 : maxCalls
    let modelCallLimit = activation.maxModelCalls
    let performedAttempts = 0
    let afterPublication = false
    let retriedPublication = false
    for (let step = activation.continuation ? 1 : 0; step < maximumSteps; step += 1) {
      activation.signal.throwIfAborted()
      if (activation.calls >= modelCallLimit) return 'budget_exhausted'
      const remaining = modelCallLimit - activation.calls
      const canPerform =
        remaining >= 2 &&
        !activation.continuation &&
        (continuing
          ? performedAttempts < maxCalls - 1 && step < maximumSteps - 1
          : step === 0 || (step === 1 && maxCalls === 3))
      const canContinueAfterPublish = continuing && step === 0 && remaining >= 3
      activation.prepare({
        continuation: step !== 0 || retriedPublication,
        canPerform,
        ...(continuing ? { canContinueAfterPublish, ...(afterPublication ? { afterPublication: true } : {}) } : {}),
      })
      const raw = await activation.decide(() => activation.calls < modelCallLimit)
      if (
        (raw as { decision?: unknown } | null)?.decision === 'perform' &&
        canPerform &&
        activation.calls + 1 > modelCallLimit
      )
        return 'budget_exhausted'
      const submitted = await activation.submit(raw)
      if (submitted.decision === 'abstain') return 'abstained'
      const publicationLimit = activation.maxModelCalls === Infinity ? maxCalls : activation.maxModelCalls
      if (submitted.publicationRejected && !retriedPublication && activation.calls < publicationLimit) {
        retriedPublication = true
        modelCallLimit = publicationLimit
        step -= 1
        continue
      }
      if (submitted.decision === 'perform' && !submitted.controlledCommitted) return 'failed'
      if (submitted.decision === 'publish') {
        if (submitted.status === 'accepted' && canContinueAfterPublish && modelCallLimit - activation.calls >= 2) {
          afterPublication = true
          continue
        }
        return submitted.status === 'accepted' ? 'published' : 'failed'
      }
      performedAttempts += 1
      afterPublication = false
    }
    return 'budget_exhausted'
  },
}

export const officialCharacterLoopProvider: SeamProvider<CharacterLoopInstance> = {
  id: 'official-character-loop',
  version: '1.0.0',
  open: async () => ({ run: activation => officialCharacterLoop.run(activation) }),
}
