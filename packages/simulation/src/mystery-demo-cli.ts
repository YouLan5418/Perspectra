import { existsSync } from 'node:fs'
import { canonicalizeWorldJson } from '@harness-world/contracts'
import { mysteryPlayerInvestigation, MysteryDemoScenario } from './mystery-demo.ts'

function json(value: Parameters<typeof canonicalizeWorldJson>[0]): string {
  return Buffer.from(canonicalizeWorldJson(value)).toString('utf8')
}

async function executeScenarioTurn(demo: MysteryDemoScenario, text: string, idempotencyKey: string): Promise<string> {
  const before = demo.providerCalls
  const turn = await demo.submitPlayerText(text, idempotencyKey)
  if (turn.status === 'clarification_required') return json({ demo: 'ashgrove-murder/v4', ...turn })
  const delivered = await demo.deliver()
  const snapshot = await demo.snapshot()
  const after = demo.providerCalls
  const providerCalls = { bob: after.bob - before.bob, director: after.director - before.director }
  return json({
    demo: 'ashgrove-murder/v4',
    execution: providerCalls.bob === 0 && providerCalls.director === 0 ? 'durable_replay' : 'executed',
    ...turn,
    delivered,
    providerCalls,
    head: { headSeq: snapshot.headSeq, tick: snapshot.tick },
    entity: snapshot.entity,
    investigation: mysteryPlayerInvestigation(snapshot),
    playerView: snapshot.views.player,
  })
}

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
    return json(output)
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
    return await executeScenarioTurn(demo, words.join(' '), idempotencyKey!)
  } finally {
    await demo.close()
  }
}

/** A persistent local shell: each non-empty input line is one deterministic Turn in the same mounted world. */
export async function* streamMysteryShellCli(
  args: readonly string[],
  lines: AsyncIterable<string>,
): AsyncGenerator<string> {
  if (args.length !== 2 || args.some(value => value.length === 0 || value.trim() !== value)) {
    throw new TypeError('usage: demo:mystery:shell <world.sqlite> <session.sqlite>')
  }
  const demo = new MysteryDemoScenario({ worldPath: args[0]!, sessionPath: args[1]! })
  try {
    demo.activate()
    let turn = 0
    for await (const line of lines) {
      if (line === ':quit') break
      turn += 1
      if (line.length === 0) {
        yield json({
          demo: 'ashgrove-murder/v4', status: 'clarification_required',
          reason: 'player text must be non-empty', candidates: [],
        })
        continue
      }
      yield await executeScenarioTurn(demo, line, `mystery-shell:${turn}`)
    }
  } finally {
    await demo.close()
  }
}

/** Test/embedding convenience wrapper around the streaming shell. */
export async function executeMysteryShellCli(args: readonly string[], lines: AsyncIterable<string>): Promise<string[]> {
  const output: string[] = []
  for await (const line of streamMysteryShellCli(args, lines)) output.push(line)
  return output
}
