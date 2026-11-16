import type { DiceInstance, SeamProvider } from '@perspectra/sdk'
import { rollDice } from './dice.ts'

export { check, parseDice, rollDice } from './dice.ts'

/** Plain dice: `NdM+K`, each die from one recorded draw. It has no store and commits nothing. */
export const officialDiceProvider: SeamProvider<DiceInstance> = {
  id: 'official-dice',
  version: '1',
  open: async () => ({ roll: rollDice }),
}
