import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MYSTERY_DEMO_IDS } from './mystery-demo.ts'
import { executeMysteryDemoCli } from './mystery-demo-cli.ts'

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
      demo: 'ashgrove-murder/v1',
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
      result: first.result,
      delivered: 0,
      providerCalls: { bob: 0, director: 0 },
      entity: first.entity,
      playerView: { bundleHash: first.playerView.bundleHash },
    })
  })
})
