import { Context } from '@deepseek-ai/cordis'
import { createWorldInstanceScope } from '@perspectra/core/runtime'
import { expect, it } from 'vitest'
import { guardedDice } from '../../apps/host/src/runtime/gameplay-services.ts'
import { callPluginSync, createPluginCallContext, hostCapability } from '../../apps/host/src/runtime/plugin-runtime.ts'

it('keeps a dice failure attributed to dice through an activity callback without leaking native text', async () => {
  const scope = await createWorldInstanceScope(new Context())
  try {
    const context = createPluginCallContext(scope)
    const dice = guardedDice(
      {
        roll: () => {
          throw new TypeError('FAKE_PRIVATE_DICE_CONTEXT')
        },
      },
      'custom-dice',
      context,
    )
    let fault: unknown
    try {
      callPluginSync(context, 'activities', 'resolve', () =>
        hostCapability(context, () => dice.roll('d20', () => 0.5))(),
      )
    } catch (error) {
      fault = error
    }
    expect(fault).toMatchObject({ origin: 'plugin', pluginId: 'custom-dice', operation: 'roll' })
    expect(String(fault)).not.toContain('FAKE_PRIVATE_DICE_CONTEXT')
    expect((fault as Error).cause).toBeUndefined()
  } finally {
    await scope.close()
  }
})

it('preserves a core random callback error through the dice boundary', async () => {
  const scope = await createWorldInstanceScope(new Context())
  try {
    const context = createPluginCallContext(scope)
    const failure = new Error('core random stream failed')
    const dice = guardedDice(
      { roll: (expression, random) => ({ expression, dice: [random()], modifier: 0, total: 1 }) },
      'custom-dice',
      context,
    )
    expect(() =>
      dice.roll('d20', () => {
        throw failure
      }),
    ).toThrow(failure)
  } finally {
    await scope.close()
  }
})
