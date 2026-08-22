import { canonicalizeWorldJson } from '@harness-world/contracts'
import { MysteryDemoScenario } from './mystery-demo.ts'

/** Run the fixed no-model opening while exposing only player-visible and public state. */
export async function executeMysteryDemoCli(args: readonly string[]): Promise<string> {
  if (args.length !== 2 || args.some(value => value.length === 0 || value.trim() !== value)) {
    throw new TypeError('usage: demo:mystery <world.sqlite> <session.sqlite>')
  }
  const demo = new MysteryDemoScenario({ worldPath: args[0]!, sessionPath: args[1]! })
  try {
    const result = await demo.runOpeningTurn()
    const delivered = await demo.deliver()
    const snapshot = await demo.snapshot()
    const output = {
      demo: 'ashgrove-murder/v1',
      result,
      delivered,
      providerCalls: demo.providerCalls,
      head: { headSeq: snapshot.headSeq, tick: snapshot.tick },
      entity: snapshot.entity,
      playerView: snapshot.views.player,
    }
    return Buffer.from(canonicalizeWorldJson(output)).toString('utf8')
  } finally {
    await demo.close()
  }
}
