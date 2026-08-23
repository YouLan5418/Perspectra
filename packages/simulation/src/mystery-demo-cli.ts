import { existsSync } from 'node:fs'
import { canonicalizeWorldJson } from '@harness-world/contracts'
import { mysteryPlayerInvestigation, MysteryDemoScenario } from './mystery-demo.ts'

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
    const providerCalls = demo.providerCalls
    const output = {
      demo: 'ashgrove-murder/v3',
      execution: providerCalls.bob === 0 && providerCalls.director === 0 ? 'durable_replay' : 'executed',
      result,
      delivered,
      providerCalls,
      head: { headSeq: snapshot.headSeq, tick: snapshot.tick },
      entity: snapshot.entity,
      investigation: mysteryPlayerInvestigation(snapshot),
      playerView: snapshot.views.player,
    }
    return Buffer.from(canonicalizeWorldJson(output)).toString('utf8')
  } finally {
    await demo.close()
  }
}

/** Submit one persistent natural-language/command turn without exposing author or NPC views. */
export async function executeMysteryTurnCli(args: readonly string[]): Promise<string> {
  if (args.length < 4 || args.some(value => value.length === 0 || value.trim() !== value)) {
    throw new TypeError('usage: demo:mystery:turn <world.sqlite> <session.sqlite> <idempotencyKey> <player text>')
  }
  const [worldPath, sessionPath, idempotencyKey, ...words] = args
  if (!existsSync(worldPath!) || !existsSync(sessionPath!)) {
    throw new TypeError('mystery turn requires an existing Demo; run demo:mystery first')
  }
  const demo = new MysteryDemoScenario({ worldPath: worldPath!, sessionPath: sessionPath! })
  try {
    const turn = await demo.submitPlayerText(words.join(' '), idempotencyKey!)
    if (turn.status === 'clarification_required') {
      return Buffer.from(canonicalizeWorldJson({ demo: 'ashgrove-murder/v3', ...turn })).toString('utf8')
    }
    const delivered = await demo.deliver()
    const snapshot = await demo.snapshot()
    const providerCalls = demo.providerCalls
    return Buffer.from(canonicalizeWorldJson({
      demo: 'ashgrove-murder/v3',
      execution: providerCalls.bob === 0 && providerCalls.director === 0 ? 'durable_replay' : 'executed',
      ...turn,
      delivered,
      head: { headSeq: snapshot.headSeq, tick: snapshot.tick },
      entity: snapshot.entity,
      investigation: mysteryPlayerInvestigation(snapshot),
      playerView: snapshot.views.player,
    })).toString('utf8')
  } finally {
    await demo.close()
  }
}
