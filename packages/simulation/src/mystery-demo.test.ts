import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId, canonicalizeWorldJson, hashWorldJson, WorldError, type WorldJsonValue } from '@harness-world/contracts'
import { SpeakMoveRulebook, WorldSpecCompiler } from '@harness-world/kernel'
import {
  compileMysteryDemo,
  createMysteryIntentCatalog,
  createMysteryDemoSpec,
  MYSTERY_DEMO_IDS,
  MysteryDemoScenario,
  requireMysterySnapshotValue,
} from './mystery-demo.ts'
import { createMysteryRulebookRegistry } from './mystery-rulebooks.ts'

const directories: string[] = []

function paths() {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-mystery-demo-'))
  directories.push(directory)
  return { worldPath: join(directory, 'world.sqlite'), sessionPath: join(directory, 'session.sqlite') }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('three-role mystery Demo', () => {
  it('requires explicit mystery registration before activating a v4 world', async () => {
    const application = new WorldApplication(paths())
    try {
      expect(() => application.activate(compileMysteryDemo())).toThrowError(expect.objectContaining<Partial<WorldError>>({
        envelope: expect.objectContaining({ errorCode: 'RULEBOOK_NOT_REGISTERED', retryable: false }),
      }))
      expect(application.activeBranchCount).toBe(0)
    } finally {
      await application.close()
    }
  })

  it('rejects new v3 activation even in the mystery composition', async () => {
    const storage = paths()
    const application = new WorldApplication({ ...storage, rulebooks: createMysteryRulebookRegistry() })
    const input = createMysteryDemoSpec() as unknown as Record<string, WorldJsonValue>
    input.address = { tenantId: 'tenant:mystery-demo', worldId: 'world:historical-v3', branchId: 'branch:main' }
    input.rulebook = { rulebookId: 'builtin:speak-move', version: 3 }
    try {
      expect(() => application.activate(new WorldSpecCompiler().compile(input))).toThrowError(expect.objectContaining<Partial<WorldError>>({
        envelope: expect.objectContaining({ errorCode: 'INVALID_REQUEST', details: expect.objectContaining({ version: 3 }) }),
      }))
    } finally {
      await application.close()
    }
  })

  it('freezes the pre-extraction v3/v4 resolver and complete v4 opening authority', async () => {
    const compiled = compileMysteryDemo()
    expect(createMysteryRulebookRegistry().resolve('builtin:speak-move', 4, 'golden:affordances').affordances({
      manifest: compiled.manifest,
      events: [],
      characterId: MYSTERY_DEMO_IDS.player,
    }).map(value => value.actionType)).toEqual([
      'speak', 'move', 'take', 'inspect', 'ask', 'present_evidence', 'accuse',
    ])
    const history = compiled.genesisEvents.map(event => ({ eventType: event.eventType, data: event.data }))
    const resolver = new SpeakMoveRulebook()
    const expected = {
      3: {
        canonical: '{"events":[{"data":{"characterId":"character:player","entityId":"entity:study-desk","evidenceId":"evidence:key-moved"},"eventType":"entity.inspected","eventVersion":1},{"data":{"id":"observation:investigation-rule:ae6fb03457048d92328fbd3e","value":{"content":{"actionType":"inspect","entityId":"entity:study-desk","evidenceId":"evidence:key-moved"},"observerId":"character:player","source":"rulebook:investigation/v3"}},"eventType":"observation.upsert","eventVersion":1}],"status":"accepted"}',
        hash: 'sha256:f0d034b14d9475800fc374b15d9c1e0aa397eb0283b218780384f71af3a44e17',
      },
      4: {
        canonical: '{"events":[{"data":{"characterId":"character:player","entityId":"entity:study-desk","evidenceId":"evidence:inspection:entity:study-desk"},"eventType":"entity.inspected","eventVersion":1},{"data":{"id":"observation:investigation-rule:b79470cae2bfd82d3db3f191","value":{"content":{"actionType":"inspect","entityId":"entity:study-desk","evidenceId":"evidence:inspection:entity:study-desk"},"observerId":"character:player","source":"rulebook:investigation/v4"}},"eventType":"observation.upsert","eventVersion":1}],"status":"accepted"}',
        hash: 'sha256:6ed41bbc926130d7129e8468abc96f5abec2f4c4c596f79022f82582409d5b5e',
      },
    } as const
    for (const version of [3, 4] as const) {
      const resolution = resolver.resolve(
        { ...compiled.manifest, rulebook: { ...compiled.manifest.rulebook, version } },
        history,
        MYSTERY_DEMO_IDS.player,
        { actionType: 'inspect', parameters: { entityId: MYSTERY_DEMO_IDS.desk } },
      )
      const worldJson = resolution as unknown as WorldJsonValue
      expect(Buffer.from(canonicalizeWorldJson(worldJson)).toString('utf8')).toBe(expected[version].canonical)
      expect(hashWorldJson('golden-rulebook-resolution', worldJson)).toBe(expected[version].hash)
    }

    const storage = paths()
    const scenario = new MysteryDemoScenario(storage)
    try {
      const result = await scenario.runOpeningTurn()
      const snapshot = await scenario.snapshot()
      expect(compiled.manifestHash).toBe('sha256:f67a4b25ea6ba8da8a16fd483659f65a9ae2ae7abb4e482760ce3bc0df78c87b')
      expect(compiled.manifest.registries.events.registryHash).toBe('sha256:d56ebc9fe0e53f9cb3e30a82412ec93cc6a8a5abd1002baf15f4b10ac12431e5')
      expect(compiled.manifest.registries.actions.registryHash).toBe('sha256:dfbd5d4595ce0c907708ab74c47e04c93f9bdc13f89328fe248068f2986de1b1')
      expect(compiled.manifest.registries.rules.registryHash).toBe('sha256:461ccdbe42dbc2e1f5362454988ea4209749846f660e7c4fb8c3118a1927ef68')
      expect(result.bundleHash).toBe('sha256:c2edcb778256681228ed25f603b5680b4a8f2c6a8a6956a3aa57fd4928f5e77c')
      expect(snapshot.authority?.authorityHash).toBe('sha256:740be7222b37f69ea511b847675ac7222a0c6699fdffb33d86f4ed9cc6704b4f')
      expect(snapshot.eventHashes).toEqual([
        'sha256:d4ab2261885bd4aa3c199abba726902a58ba224f9d6f0fc1c993fa3d2fe299cd',
        'sha256:493cbd984a55adb42dd825627e42dec679779dc8b712d79665fc81010aaa2502',
        'sha256:bea4528784b9f2c4461c1765b0b6e48b9a55623460c385b0a6c5ce00e3f0c920',
        'sha256:d6f5cfe31223c2cbad59bb2bd1950e5ffd4541dea1d1d056eca613cbd3bc2a8e',
        'sha256:26bc4efcaa188727ec53feec891380968e9e59537bcaed6a4a7121ff6e32b57e',
        'sha256:17d76129c107b9861164b3651a356c0283fc9b3d8045134fc5a8aeefc481051c',
        'sha256:7cd451128e4bef97156e2040e53ef2b0849db3acd66be2ff72c3626fba29f3e4',
        'sha256:f9c2110036ff325f2dd7a3001793d74033dc543f05724b483173d759fab9ab07',
        'sha256:501f0b08ef5d554f5888689947f5efd394268a50501dff40ca43b87754fe5c94',
        'sha256:60b5e2d1755f03513e2535d7f4078acf44b6c3b62833afccff2c8509a98eac2c',
        'sha256:17f58339b05286120498fbce2156977a76a920fe8f10f016922158acc0d66dab',
        'sha256:46e9b23e4a1c9587fecd85cef6838ac2abf53f73e105f80401e146bfadf7c3ea',
        'sha256:5021de39c36db204c307ea00842ad8cd6bcd4230186cc234499c96c5daa73e54',
        'sha256:baa1c11ba6c90940d23e160078bf9efb408b66cdfb9bf25782d7c5caf9695007',
        'sha256:9c04303a2d4f301bc896fa16781cf09648b3514715f56d50b3642b577c7ad1a0',
        'sha256:773be49ae96e8481b6e3802330ce189f279d68dcb6f41429a25765dc1716d1c7',
        'sha256:ce5ccbe04a61a902a041c386e011c50d44cf5589f13d3c03c4953a140715057c',
        'sha256:b15388d98dfd8c92c5c28e064404903dca4737627cadff6848f35da5569a87c0',
        'sha256:edc24f9a019be8e547c5227de40ba04b804e19228bf65f63ee692197dc206604',
        'sha256:219e141f93cb5837b3b6e9c17ba2f4cba7994491f56274da1a5b864fb23a0982',
        'sha256:42ba74d1016d67339bc3953d9ce3d0ea17942adb812dbc4f50430b03ca1bc7b3',
        'sha256:7f8f3b1b76bc5b810c3f66c5bb9d0ba314a523e9ee53ef237b12699a4b6d1d53',
        'sha256:451c43271c7e1d72c379f06e995ae88c40a3ce6e717de99d17bad8d362e265f0',
        'sha256:d3857d18d23ddabe7836073259c54f9702a57f3b2a1e6276f409bb8eb6b3373e',
        'sha256:77a2234b59a1385589bdb44d96fe9ed878e736a91d3dd83b49d7def5ab09c94c',
        'sha256:1932ec5161189c1219536b91f9db329caf52b709369790bb54a84c81a4388b96',
        'sha256:0413cd5dd5f48260495ccc2acd7c4afaf56651cea9ef41b820a2db82327d4f1b',
        'sha256:b5be31d2712e8ac52578224da87f2426d9765eec330780685e19f7b0afd329cb',
        'sha256:72433bcc81443c7edd495bbc09da964d6dc104ef477d89d1d531a24d1b191538',
        'sha256:afd827fae795d2c3e372d81e95a2dd063b5d7b1ce967cc23e3fdc59c91d6bbdf',
        'sha256:7a5d8a19e390da6fe365462022591c97883dddc71d1847ace422e3b3063d171d',
        'sha256:39dc5921eafb8c77bc6fc89a3aa5c97d497b4dcc82e3b7bfc8326656c80e79cf',
        'sha256:c4319044658dc050979a820b52b7458b233a1090c48934b5655606836685537c',
        'sha256:729ea848e6380a12447e2441241c27116385fd086634ed4f6899ed9b37cbed65',
      ])
    } finally {
      await scenario.close()
    }
  })

  it('fails closed when an expected snapshot binding is absent', () => {
    expect(requireMysterySnapshotValue('present', 'fixture')).toBe('present')
    expect(() => requireMysterySnapshotValue(undefined, 'fixture')).toThrow('missing fixture')
  })

  it('compiles one stable TURN_DRIVEN world with private knowledge and distinct observations', () => {
    const first = compileMysteryDemo()
    const second = compileMysteryDemo()
    expect(second).toEqual(first)
    expect(first.manifest).toMatchObject({
      metadata: { title: '灰林宅邸疑案' },
      rulebook: { rulebookId: 'builtin:speak-move', version: 4 },
      entities: expect.arrayContaining([
        expect.objectContaining({ entityId: MYSTERY_DEMO_IDS.key, locationId: 'location:study' }),
        expect.objectContaining({ entityId: MYSTERY_DEMO_IDS.desk, locationId: 'location:study' }),
      ]),
      characters: expect.arrayContaining([
        expect.objectContaining({ characterId: MYSTERY_DEMO_IDS.alice }),
        expect.objectContaining({ characterId: MYSTERY_DEMO_IDS.bob }),
        expect.objectContaining({ characterId: MYSTERY_DEMO_IDS.detective }),
      ]),
    })
    const editable = createMysteryDemoSpec() as unknown as { metadata: { title: string; description: string } }
    editable.metadata = { title: '调用方副本', description: '' }
    expect(compileMysteryDemo().manifest.metadata.title).toBe('灰林宅邸疑案')

    const extended = {
      ...first,
      manifest: {
        ...first.manifest,
        characters: [...first.manifest.characters, {
          characterId: brandId('character:guest', 'CharacterId'), name: 'Guest', locationId: 'location:study',
        }],
        entities: [...first.manifest.entities, {
          entityId: 'entity:guest-note', locationId: 'location:study', kind: 'note',
        }],
      },
    }
    expect(createMysteryIntentCatalog(extended)).toMatchObject({
      characters: expect.arrayContaining([{ id: 'character:guest', aliases: ['Guest'] }]),
      entities: expect.arrayContaining([{ id: 'entity:guest-note', aliases: ['entity:guest-note'] }]),
      evidence: expect.arrayContaining([{
        id: 'evidence:inspection:entity:guest-note', aliases: ['evidence:inspection:entity:guest-note'],
      }]),
    })
  })

  it('runs Bob taking the key through Proposal and Rulebook, then replays identically after restart', async () => {
    const storage = paths()
    const first = new MysteryDemoScenario(storage)
    try {
      expect(first.activate()).toMatchObject({ status: 'activated', tick: 0 })
      const genesis = await first.snapshot()
      expect(genesis.tick).toBe(0)
      expect(genesis.entity).toEqual({
        entityId: MYSTERY_DEMO_IDS.key, locationId: 'location:study', holderId: null, kind: 'key',
      })
      expect(genesis.authority).toBeNull()
      expect(JSON.stringify(genesis.views.alice)).not.toContain('is_culprit')
      expect(JSON.stringify(genesis.views.player)).not.toContain('is_culprit')
      expect(JSON.stringify(genesis.views.bob)).toContain('is_culprit')
      expect(JSON.stringify(genesis.views.detective)).toContain('may_be_involved')
      expect(genesis.views.alice.scenes.map(value => value.sceneId)).toEqual([MYSTERY_DEMO_IDS.scene])
      expect(new Set([
        genesis.views.alice.observations[0]?.value,
        genesis.views.bob.observations[0]?.value,
        genesis.views.detective.observations[0]?.value,
      ].map(value => JSON.stringify(value))).size).toBe(3)

      const result = await first.runOpeningTurn()
      expect(result).toMatchObject({ status: 'accepted', tick: 1 })
      expect(first.providerCalls).toEqual({ bob: 1, director: 1 })
      const committed = await first.snapshot()
      expect(committed.entity).toEqual({
        entityId: MYSTERY_DEMO_IDS.key, locationId: null, holderId: MYSTERY_DEMO_IDS.bob, kind: 'key',
      })
      expect(committed.authority?.authority).toMatchObject({
        participants: expect.arrayContaining([
          expect.objectContaining({ participantId: 'player' }),
          expect.objectContaining({ participantId: 'agent:bob', terminalStatus: 'proposed' }),
          expect.objectContaining({ participantId: 'director:detective-observer', terminalStatus: 'proposed' }),
        ]),
        actions: expect.arrayContaining([
          expect.objectContaining({ participantId: 'agent:bob', actionType: 'take' }),
        ]),
        resolutions: expect.arrayContaining([
          expect.objectContaining({ status: 'accepted' }),
        ]),
      })
      expect(JSON.stringify(committed.authority)).not.toContain('agent:alice')
      expect(await first.deliver()).toBe(2)
      const eventHashes = committed.eventHashes
      const viewHashes = Object.values(committed.views).map(view => view.bundleHash)
      await first.close()

      const restarted = new MysteryDemoScenario(storage)
      try {
        expect(await restarted.runOpeningTurn()).toEqual(result)
        expect(restarted.providerCalls).toEqual({ bob: 0, director: 0 })
        const replay = await restarted.snapshot()
        expect(replay.eventHashes).toEqual(eventHashes)
        expect(Object.values(replay.views).map(view => view.bundleHash)).toEqual(viewHashes)
        expect(replay.entity).toEqual(committed.entity)
        expect(await restarted.deliver()).toBe(0)
      } finally {
        await restarted.close()
      }
    } finally {
      await first.close()
    }
  })

  it('runs a multi-Turn investigation from natural language through evidence and a correct accusation', async () => {
    const storage = paths()
    const first = new MysteryDemoScenario(storage)
    await first.runOpeningTurn()
    const asked = await first.submitPlayerText('询问鲍勃关于钥匙', 'mystery-demo:ask-bob')
    expect(asked).toMatchObject({ status: 'submitted', action: { actionType: 'ask' }, result: { status: 'accepted', tick: 2 } })
    const beforeClarification = await first.snapshot()
    expect(JSON.stringify(beforeClarification.views.player)).toContain('我没碰过那把钥匙。')
    expect(JSON.stringify(beforeClarification.views.bob)).toContain('我没碰过那把钥匙。')
    expect(await first.submitPlayerText('检查柜子', 'mystery-demo:unknown-target')).toMatchObject({
      status: 'clarification_required', reason: 'inspection target is unknown',
    })
    expect((await first.snapshot()).eventHashes).toEqual(beforeClarification.eventHashes)
    const inspected = await first.submitPlayerText('检查一下书桌', 'mystery-demo:inspect-desk')
    expect(inspected).toMatchObject({ status: 'submitted', action: { actionType: 'inspect' }, result: { status: 'accepted', tick: 3 } })
    const premature = await first.submitPlayerText('指控鲍勃：钥匙痕迹', 'mystery-demo:premature-accusation')
    expect(premature).toMatchObject({ status: 'submitted', result: { status: 'rejected', reason: 'EVIDENCE_NOT_PRESENTED', tick: 4 } })
    const presented = await first.submitPlayerText('向侦探出示钥匙痕迹', 'mystery-demo:present-key-trace')
    expect(presented).toMatchObject({ status: 'submitted', action: { actionType: 'present_evidence' }, result: { status: 'accepted', tick: 5 } })
    const incorrect = await first.submitPlayerText('指控爱丽丝：钥匙痕迹', 'mystery-demo:accuse-alice')
    expect(incorrect).toMatchObject({ status: 'submitted', result: { status: 'accepted', tick: 6 } })
    expect((await first.snapshot()).investigation.status).toBe('open')
    const correct = await first.submitPlayerText('指控鲍勃：钥匙痕迹', 'mystery-demo:accuse-bob')
    expect(correct).toMatchObject({ status: 'submitted', result: { status: 'accepted', tick: 7 } })
    expect(first.providerCalls).toEqual({ bob: 7, director: 7 })
    const solved = await first.snapshot()
    expect(solved.investigation).toMatchObject({
      status: 'solved', culpritId: MYSTERY_DEMO_IDS.bob,
      evidence: [{
        evidenceId: MYSTERY_DEMO_IDS.keyMovedEvidence,
        discoveredBy: [MYSTERY_DEMO_IDS.player],
        presentedBy: [MYSTERY_DEMO_IDS.player],
      }],
    })
    expect(JSON.stringify(solved.views.player)).toContain(MYSTERY_DEMO_IDS.keyMovedEvidence)
    expect(JSON.stringify(solved.views.player)).not.toContain('is_culprit')
    expect(solved.authority?.authority).toMatchObject({
      actions: expect.arrayContaining([expect.objectContaining({ actionType: 'accuse', participantId: 'player' })]),
    })
    expect(await first.deliver()).toBe(10)
    const hashes = solved.eventHashes
    await first.close()

    const restarted = new MysteryDemoScenario(storage)
    try {
      expect(await restarted.submitPlayerText('指控鲍勃：钥匙痕迹', 'mystery-demo:accuse-bob')).toEqual(correct)
      expect(restarted.providerCalls).toEqual({ bob: 0, director: 0 })
      expect((await restarted.snapshot()).eventHashes).toEqual(hashes)
      expect(await restarted.deliver()).toBe(0)
    } finally {
      await restarted.close()
    }
  })

  it('keeps a legal pre-opening key inspection usable across later Turns and restart', async () => {
    const storage = paths()
    const first = new MysteryDemoScenario(storage)
    try {
      const inspected = await first.submitPlayerText('检查一下钥匙', 'mystery-demo:inspect-key-first')
      expect(inspected).toMatchObject({ status: 'submitted', result: { status: 'accepted', tick: 1 } })
      expect((await first.snapshot()).investigation.evidence).toContainEqual({
        evidenceId: MYSTERY_DEMO_IDS.keyEvidence,
        discoveredBy: [MYSTERY_DEMO_IDS.player],
        presentedBy: [],
      })
      expect(await first.submitPlayerText('询问鲍勃关于钥匙', 'mystery-demo:ask-after-key')).toMatchObject({
        status: 'submitted', result: { status: 'accepted', tick: 2 },
      })
    } finally {
      await first.close()
    }
    const restarted = new MysteryDemoScenario(storage)
    try {
      expect(await restarted.submitPlayerText('向侦探出示钥匙本身', 'mystery-demo:present-key-itself')).toMatchObject({
        status: 'submitted', result: { status: 'accepted', tick: 3 },
      })
    } finally {
      await restarted.close()
    }
  })
})
