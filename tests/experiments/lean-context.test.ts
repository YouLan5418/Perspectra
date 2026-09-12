import { describe, expect, it } from 'vitest'
import { renderExperiment, type ExperimentMessage } from './compact-context.ts'
import { renderLeanContext } from './lean-context.ts'

function segment(segmentKind: string, content: unknown): ExperimentMessage {
  return { role: 'user', content: JSON.stringify({ segmentKind, content }) }
}

const address = { tenantId: 'tenant:t', worldId: 'world:w', branchId: 'branch:main' }
const hash = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`

/** One observation the way the Context carries it: the action nested one level inside the notice. */
function observation(text = '今天雨下得真大，路上几乎看不清前面的车灯。'): unknown {
  return {
    observationId: 'observation:scene-result:c3270c6c0fcef15ecbd933e3',
    sourceRef: { sourceHash: hash('9'), sourceId: 'event:676', sourceKind: 'world_event', sourceSeq: 676 },
    content: {
      actionId: 'action:coordinated-player:086358e1aba8640d5cc3ccf7',
      content: {
        actionType: 'speak', actorId: 'character:player', reason: null, status: 'accepted',
        speech: {
          addresseeIds: [], characterId: 'character:player', declaredSpeechAct: null,
          replyTo: null, scope: 'scene_public', text,
        },
      },
      observerId: 'character:alice',
    },
  }
}

function context(): ExperimentMessage[] {
  return [
    { role: 'system', content: JSON.stringify({ schemaVersion: 'host-protocol/v1', authority: 'world_event_log' }) },
    { role: 'developer', content: JSON.stringify({ schemaVersion: 'character-controller-contract/v2', role: 'portray exactly one character' }) },
    segment('world_public_anchor', { metadata: { title: '雨夜同行', description: '三名旅伴在暴雨中赶往末班车站。' }, timeMode: 'TURN_DRIVEN' }),
    segment('character_anchor', {
      characterId: 'character:alice', controllerClass: 'scripted', lifecycle: 'active',
      locationId: 'location:road', name: 'Alice', pronouns: 'she',
      portrayal: { summary: 'A careful traveler', speakingStyle: 'terse', drives: [], principles: [], backgroundTextRef: null },
    }),
    segment('continuity_checkpoint', {
      checkpoint: {
        schemaVersion: 'continuity-checkpoint/v1', checkpointId: 'checkpoint:alice', address,
        characterId: 'character:alice', asOfWorldSeq: 668, memoryEpoch: 1,
        sourceStartSeq: 11, sourceEndSeq: 668, checkpointHash: hash('a'),
        summaryRefs: [{ summaryId: 'memory-l1-summary/v1:5b49750bdac27d73fdb09b3a', sourceStartSeq: 11, sourceEndSeq: 83, summaryHash: hash('b') }],
        activeCognition: [{
          kind: 'subjective-claim', id: 'world-pack-claim-id/v2:0133ccd5ae83f5bc84727284',
          sourceRef: { sourceHash: hash('c'), sourceId: 'event:9', sourceKind: 'world_event', sourceSeq: 9 },
          stateHash: hash('d'),
          value: {
            awareness: 'conscious', confidencePermille: 720, saliencePermille: 760, stance: 'believed', status: 'active',
            proposition: { predicate: 'is_irresponsible', subject: 'character:bob' },
            basisRefs: [{ sourceId: 'event:9' }], source: { sourceId: 'AUTHOR_SECRET_CANARY' },
          },
        }],
      },
      digest: [{
        summaryId: 'memory-l1-summary/v1:5b49750bdac27d73fdb09b3a', sourceStartSeq: 11, sourceEndSeq: 83,
        summaryHash: hash('e'), text: '第 1 轮 ｜ character:player：我把备用钥匙放在门口第三个花盆下面了，你们别忘了。',
        sourceRefs: [{ sourceHash: hash('f'), sourceId: 'event:15', sourceKind: 'world_event', sourceSeq: 15 }],
      }],
    }),
    segment('recent_interaction_tail', {
      schemaVersion: 'interaction-tail/v1', address, characterId: 'character:alice',
      afterSeq: 668, asOfWorldSeq: 801, tailHash: hash('1'),
      blocks: [{
        schemaVersion: 'interaction-block/v1', transactionId: 'transaction:coordinated-round:a178e25d8da97a91f8612766',
        roundId: 'round:coordinated:ca39152a65c55f493d078d41', startSeq: 676, endSeq: 681, tick: 50,
        authorityHash: null, blockHash: hash('2'), observations: [observation()],
      }],
    }),
    segment('current_self_state', {
      lifecycleState: 'active', locationId: 'location:road', runtimeAvailability: 'ready',
      consciousState: [{
        kind: 'commitment', id: 'commitment:x', stateHash: hash('3'),
        value: { content: 'Wait for Bob', origin: 'promise', saliencePermille: 800, awareness: 'conscious', status: 'active', basisRefs: [] },
      }],
      latentGuidance: [{
        kind: 'inner-tension', id: 'tension:y', stateHash: hash('4'),
        value: { title: 'Stay or go', pressurePermille: 700, awareness: 'unrecognized', status: 'active', basisRefs: [] },
      }],
    }),
    segment('current_scene', {
      schemaVersion: 'scene-decision/v2', sceneId: 'scene:station', decisionHash: hash('5'), asOfSeq: 801,
      memberIds: ['character:alice', 'character:bob', 'character:player'], observerIds: ['character:alice', 'character:bob'],
      schedulableCharacterIds: ['character:alice'], visibleResultCharacterIds: ['character:player'], directorEligible: true,
    }),
    segment('verified_recall', [{
      memoryId: 'cognitive-memory-entry/v2:abc', memoryKind: 'communication', epistemicKind: 'reported_speech',
      text: 'character:bob said: the bridge is closed', captureHash: hash('6'), metadata: { source: { sourceId: 'event:3' } },
      sourceRef: { sourceHash: hash('7'), sourceId: 'event:3', sourceKind: 'world_event', sourceSeq: 3 },
    }]),
    segment('current_stimulus', {
      actionId: 'action:coordinated-player:c07eac7fb1c241f1d9d2c100', actionType: 'speak', actionVersion: 1,
      actorId: 'character:player', parameters: { text: '嗯，随便吧。' },
    }),
    segment('affordances', [{ actionType: 'move', actionVersion: 1 }, { actionType: 'speak', actionVersion: 1 }]),
    segment('output_reminder', { schemaVersion: 'output-reminder/v1', tool: 'submit_actions/v2', maximumExternalActions: 2, maximumReflectionOperations: 4 }),
  ]
}

describe('renderLeanContext', () => {
  it('renders one observation as who spoke and what was said', () => {
    const rendered = renderLeanContext(context())
    const tail = JSON.parse(rendered.messages[5]!.content) as { readonly content: readonly { readonly round: number; readonly lines: readonly unknown[] }[] }
    expect(tail.content[0]).toEqual({
      round: 50,
      lines: [{ speaker: 'player', text: '今天雨下得真大，路上几乎看不清前面的车灯。' }],
    })
  })

  it('keeps the digest prose and drops the identity that carried it', () => {
    const rendered = renderLeanContext(context())
    const continuity = JSON.parse(rendered.messages[4]!.content) as {
      readonly content: { readonly earlierRounds: readonly string[]; readonly holds: readonly unknown[] }
    }
    expect(continuity.content.earlierRounds).toEqual([
      '第 1 轮 ｜ character:player：我把备用钥匙放在门口第三个花盆下面了，你们别忘了。',
    ])
    expect(continuity.content.holds).toEqual([{
      kind: 'subjective-claim', awareness: 'conscious', confidencePermille: 720, saliencePermille: 760,
      stance: 'believed', proposition: { predicate: 'is_irresponsible', subject: 'character:bob' },
    }])
  })

  it('splits what a character knows from what it has not acknowledged', () => {
    const rendered = renderLeanContext(context())
    const state = JSON.parse(rendered.messages[6]!.content) as {
      readonly content: { readonly knows: readonly unknown[]; readonly unacknowledged: readonly unknown[] }
    }
    expect(state.content.knows).toEqual([{
      kind: 'commitment', content: 'Wait for Bob', origin: 'promise', saliencePermille: 800, awareness: 'conscious',
    }])
    expect(state.content.unacknowledged).toEqual([{
      kind: 'inner-tension', title: 'Stay or go', pressurePermille: 700, awareness: 'unrecognized',
    }])
  })

  it('never lets a machine identifier or a canary reach the prompt', () => {
    const rendered = renderLeanContext(context())
    // The two fixed contracts pass through untouched; every data segment is projected.
    const whole = JSON.stringify(rendered.messages.slice(2))
    for (const fragment of [
      'sha256:', 'observationId', 'actionId', 'transactionId', 'roundId', 'stateHash', 'blockHash',
      'schemaVersion', 'sourceRef', 'sourceRefs', 'basisRefs', 'summaryRefs', 'AUTHOR_SECRET_CANARY',
      'world-pack-claim-id', 'sourceSeq', 'asOfWorldSeq', 'epistemicKind', 'memoryKind',
    ]) {
      expect(whole).not.toContain(fragment)
    }
  })

  it('reads far smaller than the default renderer without losing a single spoken line', () => {
    const messages = context()
    const full = renderExperiment(messages, 'full')
    const compact = renderExperiment(messages, 'compact')
    const lean = renderLeanContext(messages)
    const size = (result: { readonly messages: readonly ExperimentMessage[] }) =>
      result.messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0)
    expect(size(lean)).toBeLessThan(size(compact))
    expect(size(lean)).toBeLessThan(size(full) / 2)
    // The one line a character could actually repeat survives both projections.
    expect(JSON.stringify(lean.messages)).toContain('今天雨下得真大')
  })

  it('refuses anything that is not the known twelve segments', () => {
    expect(() => renderLeanContext(context().slice(0, 11))).toThrow('known 12-segment')
    const reordered = context()
    reordered[6] = segment('verified_recall', [])
    expect(() => renderLeanContext(reordered)).toThrow('unknown or reordered segment')
  })
})
