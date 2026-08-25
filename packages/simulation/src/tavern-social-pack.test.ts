import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldApplication, type RoundParticipant } from '@harness-world/application'
import {
  brandId,
  hashWorldJson,
  type ProposalContext,
  type WorldJsonObject,
} from '@harness-world/contracts'
import type { CompiledWorldPack } from '@harness-world/world-pack'
import { currentEntityState } from '@harness-world/kernel'
import {
  TAVERN_SOCIAL_IDS,
  adaptTavernSocialPack,
  compileTavernSocialPack,
  createTavernSocialParticipants,
  tavernSocialSourceDirectory,
} from './tavern-social-pack.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tavern-social-pack-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface ParticipantEvidence {
  readonly calls: Map<string, number>
  readonly contexts: Map<string, ProposalContext[]>
  readonly participants: readonly RoundParticipant[]
}

function participantEvidence(): ParticipantEvidence {
  const calls = new Map<string, number>()
  const contexts = new Map<string, ProposalContext[]>()
  const participants = createTavernSocialParticipants().map(binding => ({
    ...binding,
    provider: {
      async propose(context: ProposalContext) {
        calls.set(binding.participantId, (calls.get(binding.participantId) ?? 0) + 1)
        contexts.set(binding.participantId, [...contexts.get(binding.participantId) ?? [], context])
        return binding.provider.propose(context)
      },
    },
  }))
  return { calls, contexts, participants }
}

function application(root: string, evidence: ParticipantEvidence): WorldApplication {
  return new WorldApplication({
    worldPath: join(root, 'world.sqlite'),
    sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'),
    modelBudgetTokens: 8,
    participants: () => evidence.participants,
  })
}

function assertionParameters(pack: CompiledWorldPack, assertionId: string): WorldJsonObject {
  const parameters = pack.acceptanceAssertions.find(assertion => assertion.assertionId === assertionId)?.parameters
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    throw new TypeError(`reference assertion ${assertionId} has no object parameters`)
  }
  return parameters as WorldJsonObject
}

describe('Phase 7 deterministic tavern social Pack', () => {
  it('compiles a stable open-world fixture with executable acceptance assertions', async () => {
    const pack = await compileTavernSocialPack()
    expect(pack).toMatchObject({
      packId: 'pack:tavern-social',
      packVersion: '1.0.0',
      content: {
        world: { title: '渡鸦酒馆' },
        entities: [{ entityId: TAVERN_SOCIAL_IDS.token, locationId: TAVERN_SOCIAL_IDS.hall, kind: 'token' }],
      },
    })
    expect(pack.acceptanceAssertions.map(assertion => assertion.assertionId)).toEqual([
      'assertion:alice-mistake-is-character-scoped',
      'assertion:bob-secret-hidden-from-alice',
      'assertion:bob-secret-hidden-from-visitor',
      'assertion:fork-future-isolated',
      'assertion:recall-differs-by-character',
      'assertion:replay-stable',
      'assertion:reported-speech-does-not-entail',
      'assertion:scene-departure-unschedules',
    ])
    expect(pack.packHash).toBe('sha256:515dd41a737d28139548364eefe3c7211c94a0f3a8b43bead4950a32f2f12c6d')
    expect(JSON.stringify(pack)).not.toMatch(/culprit|evidence|accuse|case status/iu)
  })

  it('preserves cognition, Scene scheduling and Authority across ten Rounds, restart and fork', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    await cp(tavernSocialSourceDirectory(), source, { recursive: true })
    const pack = await compileTavernSocialPack(source)
    const parent = {
      tenantId: brandId('tenant:tavern-reference', 'TenantId'),
      worldId: brandId('world:tavern-social', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }
    const child = { ...parent, branchId: brandId('branch:fork', 'BranchId') }
    const compiled = adaptTavernSocialPack(pack, parent)
    const visitorSecret = assertionParameters(pack, 'assertion:bob-secret-hidden-from-visitor')
    const aliceSecret = assertionParameters(pack, 'assertion:bob-secret-hidden-from-alice')
    const reportedSpeech = assertionParameters(pack, 'assertion:reported-speech-does-not-entail')
    const replayAssertion = assertionParameters(pack, 'assertion:replay-stable')
    const futureAssertion = assertionParameters(pack, 'assertion:fork-future-isolated')
    expect(visitorSecret.characterId).toBe(TAVERN_SOCIAL_IDS.visitor)
    expect(aliceSecret.characterId).toBe(TAVERN_SOCIAL_IDS.alice)
    expect(reportedSpeech.observerId).toBe(TAVERN_SOCIAL_IDS.alice)
    const firstEvidence = participantEvidence()
    const first = application(root, firstEvidence)
    const submitted = []
    try {
      expect(first.activate(compiled).status).toBe('activated')
      await rm(source, { recursive: true, force: true })

      const visitorView = await first.characterView(parent, TAVERN_SOCIAL_IDS.visitor)
      const aliceView = await first.characterView(parent, TAVERN_SOCIAL_IDS.alice)
      const bobView = await first.characterView(parent, TAVERN_SOCIAL_IDS.bob)
      expect(JSON.stringify(visitorView)).not.toContain('旧徽章')
      expect(JSON.stringify(aliceView)).not.toContain('旧徽章')
      expect(JSON.stringify(bobView)).toContain('旧徽章')
      expect(JSON.stringify(aliceView)).toContain('运酒车已经把橡木桶送到了后院')
      expect(JSON.stringify(visitorView)).not.toContain('运酒车已经把橡木桶送到了后院')
      expect(JSON.stringify(bobView)).not.toContain('运酒车已经把橡木桶送到了后院')
      expect(new Set([visitorView.goals[0]?.id, aliceView.goals[0]?.id, bobView.goals[0]?.id]).size).toBe(3)
      expect(await first.recallMemory(parent, TAVERN_SOCIAL_IDS.visitor, String(visitorSecret.query))).toEqual([])
      expect(await first.recallMemory(parent, TAVERN_SOCIAL_IDS.alice, String(aliceSecret.query))).toEqual([])
      expect(JSON.stringify(await first.recallMemory(parent, TAVERN_SOCIAL_IDS.bob, String(visitorSecret.query)))).toContain('旧徽章')

      const turns = [
        '晚上好。',
        `/take ${TAVERN_SOCIAL_IDS.token}`,
        'Bob，今晚地窖门怎么样？',
        `/move ${TAVERN_SOCIAL_IDS.courtyard}`,
        '这里很安静。',
        `/move ${TAVERN_SOCIAL_IDS.hall}`,
        '大家还在吗？',
        `/take ${TAVERN_SOCIAL_IDS.token}`,
        'Bob，你说的门呢？',
        `/move ${TAVERN_SOCIAL_IDS.courtyard}`,
      ]
      for (const [index, text] of turns.entries()) {
        const result = await first.submitText(parent, {
          text,
          idempotencyKey: `tavern:turn:${index + 1}`,
          principalId: TAVERN_SOCIAL_IDS.principal,
          correlationId: `tavern:turn:${index + 1}`,
        })
        expect(result.status).toBe('submitted')
        if (result.status === 'submitted') {
          expect(result.result.tick).toBe(index + 1)
          submitted.push(result)
        }
      }
      expect(submitted).toHaveLength(10)
      expect(submitted[7]?.result.status).toBe('rejected')
      expect(firstEvidence.calls.get('agent:alice')).toBe(5)
      expect(firstEvidence.calls.get('agent:bob')).toBe(8)
      expect(JSON.stringify(firstEvidence.contexts.get('agent:bob')?.[0])).toContain('旧徽章')
      expect(JSON.stringify(firstEvidence.contexts.get('agent:alice')?.[0])).not.toContain('旧徽章')

      const events = await first.eventHistory(parent)
      expect((await first.head(parent)).tick).toBe(10)
      expect(events.filter(event => event.eventType === 'world.tick-advanced')
        .map(event => (event.data as { tick: number }).tick)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(events.some(event => event.eventType.startsWith('investigation.'))).toBe(false)
      expect(currentEntityState(events, TAVERN_SOCIAL_IDS.token)).toMatchObject({
        holderId: TAVERN_SOCIAL_IDS.visitor,
        locationId: null,
      })
      expect(JSON.stringify((await first.characterView(parent, TAVERN_SOCIAL_IDS.alice)).observations))
        .toContain(String(reportedSpeech.statement))
      expect(JSON.stringify((await first.characterView(parent, TAVERN_SOCIAL_IDS.alice)).claims))
        .not.toContain(String(reportedSpeech.statement))
      expect(JSON.stringify(await first.recallMemory(parent, TAVERN_SOCIAL_IDS.alice, 'speech')))
        .toContain(String(reportedSpeech.statement))

      const delivered = await first.deliver(parent, 'tavern:deliver')
      expect(delivered).toBeGreaterThan(10)
      const presentations = []
      for (let sequence = 1; sequence <= delivered; sequence += 1) {
        presentations.push(await first.renderSession(parent, TAVERN_SOCIAL_IDS.session, sequence, { locale: 'zh-CN' }))
      }
      const rendered = JSON.stringify(presentations)
      expect(rendered).not.toContain('旧徽章')
      expect(rendered).not.toContain('运酒车已经把橡木桶送到了后院')
    } finally {
      await first.close()
    }

    const restartedEvidence = participantEvidence()
    const restarted = application(root, restartedEvidence)
    try {
      expect(restarted.activate(compiled).status).toBe('already_active')
      const replay = await restarted.submitText(parent, {
        text: '晚上好。',
        idempotencyKey: String(replayAssertion.idempotencyKey),
        principalId: TAVERN_SOCIAL_IDS.principal,
        correlationId: 'tavern:turn:1',
      })
      expect(replay).toEqual(submitted[0])
      expect([...restartedEvidence.calls.values()]).toEqual([])
      const beforeFork = await restarted.eventHistory(parent)
      const beforeHash = hashWorldJson('tavern-reference-history/v1', beforeFork)
      expect((await restarted.forkAtHead(parent, child, 'reference fork', 'tavern:fork')).forkSeq)
        .toBe((await restarted.head(parent)).headSeq)

      expect((await restarted.submitText(parent, {
        text: String(futureAssertion.query),
        idempotencyKey: 'tavern:turn:future',
        principalId: TAVERN_SOCIAL_IDS.principal,
        correlationId: 'tavern:turn:future',
      })).status).toBe('submitted')
      expect(JSON.stringify(await restarted.recallMemory(parent, TAVERN_SOCIAL_IDS.visitor, String(futureAssertion.query))))
        .toContain(String(futureAssertion.query))
      expect(await restarted.recallMemory(child, TAVERN_SOCIAL_IDS.visitor, String(futureAssertion.query))).toEqual([])
      expect(JSON.stringify(await restarted.eventHistory(child))).not.toContain(String(futureAssertion.query))
      expect(hashWorldJson('tavern-reference-history/v1', await restarted.eventHistory(child))).toBe(beforeHash)
      expect(restarted.getWorld(child).manifestHash).toBe(compiled.manifestHash)
    } finally {
      await restarted.close()
    }
  })
})
