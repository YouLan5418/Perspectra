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

describe('preparing a command-controlled player input', () => {
  it('preserves an explicit narration as source evidence without a model', () => {
    expect(prepare({ text: '/narrate 我把日记暂放桌上。' })).toMatchObject({ directSubmission: {
      sourceText: '我把日记暂放桌上。', sourceSpans: [{ kind: 'narration', text: '我把日记暂放桌上。' }],
      actions: [{ actionType: 'speak', parameters: { text: '', narration: '我把日记暂放桌上。' } }],
    } })
  })
  it('takes the version from the affordance the command exercises', () => {
    const result = prepare({ action: { actionType: 'speak', parameters: { text: '你好' } } })
    expect(result).toMatchObject({ directSubmission: { actions: [{ actionType: 'speak', actionVersion: 1 }] } })
  })

  it('asks for clarification when nothing affords the action it names', () => {
    expect(prepare({ action: { actionType: 'take', parameters: { entityId: 'entity:cup' } } }))
      .toEqual({ clarification: 'action is not currently afforded' })
  })
})

it('preserves both narration and speech as source spans of one action',()=>{
 const result=prepare({action:{actionType:'speak',parameters:{text:'你好',narration:'轻轻微笑。\n抬起头。'}}})
 expect(result).toMatchObject({directSubmission:{sourceText:'轻轻微笑。\n抬起头。\n你好',
  sourceSpans:[{kind:'narration',text:'轻轻微笑。\n抬起头。',startUtf16:0,endUtf16:10},{kind:'speech',text:'你好',startUtf16:11,endUtf16:13}]}})
 if('directSubmission' in result)expect(result.directSubmission.actions).toHaveLength(1)
 expect(prepare({text:'/narrate 轻轻微笑。\n抬起头。'})).toMatchObject({directSubmission:{actions:[{parameters:{text:'',narration:'轻轻微笑。\n抬起头。'}}]}})
})
