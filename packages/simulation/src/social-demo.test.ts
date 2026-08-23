import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SocialDemoScenario } from './social-demo.ts'

const directories: string[] = []
function paths() {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-social-demo-'))
  directories.push(directory)
  return { worldPath: join(directory, 'world.sqlite'), sessionPath: join(directory, 'session.sqlite') }
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('second-genre social reference slice', () => {
  it('uses only Core actions while preserving private cognition and durable replay', async () => {
    const storage = paths()
    const first = new SocialDemoScenario(storage)
    const result = await first.submitText('你好，我只是来聊聊天。', 'social:greeting')
    expect(result).toMatchObject({
      status: 'submitted', action: { actionType: 'speak' }, result: { status: 'accepted', tick: 1 },
    })
    const snapshot = await first.snapshot()
    expect(snapshot.tick).toBe(1)
    expect(snapshot.eventTypes).toContain('character.speak')
    expect(snapshot.eventTypes.some(type => type.startsWith('investigation.'))).toBe(false)
    expect(JSON.stringify(snapshot.playerView)).not.toContain('最低成交价')
    expect(JSON.stringify(snapshot.merchantView)).toContain('最低成交价')
    expect(first.providerCalls).toBe(1)
    await first.close()

    const restarted = new SocialDemoScenario(storage)
    expect(await restarted.submitText('你好，我只是来聊聊天。', 'social:greeting')).toEqual(result)
    expect(restarted.providerCalls).toBe(0)
    await restarted.close()
  })
})
