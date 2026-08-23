import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MYSTERY_DEMO_IDS } from './mystery-demo.ts'
import { executeMysteryDemoCli, executeMysteryShellCli, executeMysteryTurnCli } from './mystery-demo-cli.ts'

const directories: string[] = []

function paths(): [string, string] {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-mystery-cli-'))
  directories.push(directory)
  return [join(directory, 'world.sqlite'), join(directory, 'session.sqlite')]
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('mystery Demo CLI', () => {
  it('rejects missing, extra, empty, and padded paths', async () => {
    for (const args of [[], ['world'], ['world', 'session', 'extra'], ['', 'session'], [' world', 'session']]) {
      await expect(executeMysteryDemoCli(args)).rejects.toThrow('usage')
    }
  })

  it('prints only player-visible state and resumes idempotently', async () => {
    const storage = paths()
    const firstText = await executeMysteryDemoCli(storage)
    const first = JSON.parse(firstText) as any
    expect(first).toMatchObject({
      demo: 'ashgrove-murder/v3',
      execution: 'executed',
      result: { status: 'accepted', tick: 1 },
      delivered: 2,
      providerCalls: { bob: 1, director: 1 },
      entity: { entityId: MYSTERY_DEMO_IDS.key, locationId: null, holderId: MYSTERY_DEMO_IDS.bob },
      playerView: { characterId: MYSTERY_DEMO_IDS.player },
    })
    expect(firstText).not.toContain('is_culprit')
    expect(firstText).not.toContain('may_be_involved')

    const replay = JSON.parse(await executeMysteryDemoCli(storage)) as any
    expect(replay).toMatchObject({
      execution: 'durable_replay',
      result: first.result,
      delivered: 0,
      providerCalls: { bob: 0, director: 0 },
      entity: first.entity,
      playerView: { bundleHash: first.playerView.bundleHash },
    })
  })

  it('submits one persistent text Turn or returns clarification without leaking private views', async () => {
    for (const args of [[], ['world', 'session', 'key'], ['world', 'session', 'key', ' padded ']]) {
      await expect(executeMysteryTurnCli(args)).rejects.toThrow('usage')
    }
    const storage = paths()
    await expect(executeMysteryTurnCli([...storage, 'turn:missing-world', '检查钥匙'])).rejects.toThrow('existing Demo')
    await executeMysteryDemoCli(storage)
    const clarification = JSON.parse(await executeMysteryTurnCli([
      ...storage, 'turn:unknown', '检查柜子',
    ])) as any
    expect(clarification).toMatchObject({
      demo: 'ashgrove-murder/v4', status: 'clarification_required', reason: 'inspection target is unknown',
    })
    expect(JSON.parse(await executeMysteryTurnCli([
      ...storage, 'turn:future-evidence', '/present', '钥匙痕迹', 'Bob',
    ]))).toMatchObject({
      status: 'clarification_required', reason: 'evidence is unknown', candidates: [],
    })
    const firstText = await executeMysteryTurnCli([...storage, 'turn:inspect', '检查一下书桌'])
    const first = JSON.parse(firstText) as any
    expect(first).toMatchObject({
      demo: 'ashgrove-murder/v4', execution: 'executed', status: 'submitted',
      action: { actionType: 'inspect' }, result: { status: 'accepted', tick: 2 },
      investigation: { status: 'open' }, playerView: { characterId: MYSTERY_DEMO_IDS.player },
    })
    expect(firstText).not.toContain('is_culprit')
    expect(firstText).not.toContain('may_be_involved')
    expect(firstText).not.toContain('discoveredBy')
    expect(firstText).not.toContain('presentedBy')
    const replay = JSON.parse(await executeMysteryTurnCli([...storage, 'turn:inspect', '检查一下书桌'])) as any
    expect(replay).toMatchObject({
      execution: 'durable_replay', result: first.result, delivered: 0,
      playerView: { bundleHash: first.playerView.bundleHash },
    })
    const generic = JSON.parse(await executeMysteryTurnCli([...storage, 'turn:generic', '这不是调查指令，只是普通对白。'])) as any
    expect(generic).toMatchObject({
      demo: 'ashgrove-murder/v4', status: 'submitted', action: { actionType: 'speak' },
      result: { status: 'accepted', tick: 3 },
    })
    const explicit = JSON.parse(await executeMysteryTurnCli([
      ...storage, 'turn:generic-act', '/act', 'move', '{"locationId":"location:drawing-room"}',
    ])) as any
    expect(explicit).toMatchObject({
      status: 'submitted', action: { actionType: 'move' }, result: { status: 'accepted', tick: 4 },
    })
  })

  it('streams multiple generic and clarification inputs through one persistent mounted world', async () => {
    async function* lines() {
      yield '晚上好。'
      yield ''
      yield '/move location:drawing-room'
      yield ':quit'
      yield 'ignored'
    }
    await expect(executeMysteryShellCli([], lines())).rejects.toThrow('usage')
    const output = (await executeMysteryShellCli(paths(), lines())).map(value => JSON.parse(value) as any)
    expect(output).toHaveLength(3)
    expect(output[0]).toMatchObject({
      status: 'submitted', action: { actionType: 'speak' }, result: { tick: 1 },
    })
    expect(output[1]).toEqual({
      demo: 'ashgrove-murder/v4', status: 'clarification_required',
      reason: 'player text must be non-empty', candidates: [],
    })
    expect(output[2]).toMatchObject({
      status: 'submitted', action: { actionType: 'move' }, result: { tick: 2 },
    })
    expect(JSON.stringify(output)).not.toContain('is_culprit')
  })

  it('continues the same persistent world after restarting the shell process', async () => {
    const storage = paths()
    async function* one(text: string) { yield text }
    const first = (await executeMysteryShellCli(storage, one('第一段对白。'))).map(value => JSON.parse(value) as any)
    const restarted = (await executeMysteryShellCli(storage, one('重启后的第二段对白。'))).map(value => JSON.parse(value) as any)
    expect(first[0]).toMatchObject({ status: 'submitted', result: { tick: 1 } })
    expect(restarted[0]).toMatchObject({ status: 'submitted', result: { tick: 2 } })
  })
})
