import { describe, expect, it } from 'vitest'
import { createCoreRulebookRegistry } from '@harness-world/kernel'
import type { PlayerInputJob } from '@harness-world/store-sqlite'
import { frozenIntentWorld } from '../../../tests/fixtures/player-intent-world.ts'
import { basicInteractionPackage } from '../../../tests/fixtures/frozen-interaction-world.ts'
import { preparePlayerIntent } from './player-intent-preparation.ts'

/**
 * The explicit-command path is the one place an input states its own action, so it is the only place a
 * durable record can name an operation the world no longer affords. The Host has to say so instead of
 * inventing a version for it.
 */
function prepare(input: Record<string, unknown>) {
  const world = frozenIntentWorld()
  const manifest = world.manifest
  const resolver = createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }).resolve(
    manifest.rulebook.rulebookId, manifest.rulebook.version, 'preparation:test')
  const job = {
    address: manifest.address, inputId: 'input:1', principalId: 'principal:player', input,
  } as unknown as PlayerInputJob
  return preparePlayerIntent(job, manifest, [], resolver, undefined, 0, world.manifestHash, 0)
}

describe('preparing an explicit player input', () => {
  it('takes the version from the affordance the command exercises', () => {
    const result = prepare({ action: { actionType: 'speak', parameters: { text: '你好' } } })
    expect(result).toMatchObject({ directSubmission: { actions: [{ actionType: 'speak', actionVersion: 1 }] } })
  })

  it('asks for clarification when nothing affords the action it names', () => {
    expect(prepare({ action: { actionType: 'take', parameters: { entityId: 'entity:cup' } } }))
      .toEqual({ clarification: 'action is not currently afforded' })
  })
})
