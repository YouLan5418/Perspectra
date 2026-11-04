// One operation, followed by one result-aware expression. It never delegates to the default loop.
export const hostApi = '2.4'

export default function(ctx) {
  ctx.effect(() => ctx.characterLoop.register({
    id: 'single-action-loop',
    version: '1.0.0',
    open: async () => ({
      async run(activation) {
        for (let step = 0; step < 2; step++) {
          activation.signal.throwIfAborted()
          if (activation.calls >= activation.maxModelCalls) return 'budget_exhausted'
          activation.prepare({
            continuation: activation.continuation || step > 0,
            canPerform: !activation.continuation && step === 0 && activation.maxModelCalls - activation.calls >= 2,
          })
          const raw = await activation.decide(() => activation.calls < activation.maxModelCalls)
          const result = await activation.submit(raw)
          if (result.decision === 'abstain') return 'abstained'
          if (result.decision === 'publish') return result.status === 'accepted' ? 'published' : 'failed'
          if (!result.controlledCommitted) return 'failed'
        }
        return 'budget_exhausted'
      },
    }),
  }))
}
