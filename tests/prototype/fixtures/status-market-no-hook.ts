import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The shared status fixture without its round hook, so only `/status set-time` moves the public time. */
export function statusMarketWithoutRoundHook(): string {
  const market = readFileSync(resolve('tests/prototype/fixtures/status-market.js'), 'utf8')
  const script = market.replace(/  onRoundEnd\(truth\) \{[\s\S]*?\n  \},\n/u, '')
  if (script === market) throw new Error('fixture variant did not apply')
  return script
}

/** The player's known value of the public `time` status. */
export const knownTime = (state: { readonly statusBar?: readonly { readonly key: string; readonly value: unknown }[] }) =>
  state.statusBar?.find(entry => entry.key === 'time')?.value
