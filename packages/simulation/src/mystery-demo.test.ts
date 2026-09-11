import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import {
  brandId,
  canonicalizeWorldJson,
  createErrorEnvelope,
  deterministicId,
  failWorld,
  hashWorldJson,
  WorldError,
  type FaultInjector,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { WorldSpecCompiler } from '@harness-world/kernel'
import { BranchQuarantineService, WorldStore } from '@harness-world/store-sqlite'
import {
  compileMysteryDemo,
  compileLegacyMysteryDemo,
  createLegacyMysteryDemoSpec,
  createMysteryIntentCatalog,
  createMysteryDemoSpec,
  MYSTERY_DEMO_IDS,
  MysteryDemoScenario,
  requireMysterySnapshotValue,
} from './mystery-demo.ts'
import { createMysteryRulebookRegistry, MysteryRulebookResolver } from './mystery-rulebooks.ts'

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

  it('rejects an unsupported versioned Scene policy at activation', async () => {
    const storage = paths()
    const application = new WorldApplication({ ...storage, rulebooks: createMysteryRulebookRegistry() })
    const input = createMysteryDemoSpec() as unknown as Record<string, WorldJsonValue>
    input.address = { tenantId: 'tenant:mystery-demo', worldId: 'world:bad-scene-policy', branchId: 'branch:main' }
    input.plugins = [
      { pluginId: 'builtin:agent-context', version: '2.0.0' },
      { pluginId: 'builtin:scene-decision', version: '9.0.0' },
    ]
    const compiled = new WorldSpecCompiler().compile(input)
    try {
      expect(() => application.activate(compiled)).toThrowError(expect.objectContaining<Partial<WorldError>>({
        envelope: expect.objectContaining({ errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE' }),
      }))
    } finally {
      await application.close()
    }
  })

  it('validates Agent Context v2 configuration and keeps legacy Memory disabled', async () => {
    const unsupportedStorage = paths()
    const unsupported = new WorldApplication({
      ...unsupportedStorage,
      memoryPath: `${unsupportedStorage.worldPath}.memory.sqlite`,
      rulebooks: createMysteryRulebookRegistry(),
    })
    const unsupportedInput = createMysteryDemoSpec() as unknown as Record<string, WorldJsonValue>
    unsupportedInput.address = { tenantId: 'tenant:mystery-demo', worldId: 'world:bad-context-policy', branchId: 'branch:main' }
    unsupportedInput.plugins = [
      { pluginId: 'builtin:agent-context', version: '9.0.0' },
      { pluginId: 'builtin:scene-decision', version: '1.0.0' },
    ]
    const unsupportedCompiled = new WorldSpecCompiler().compile(unsupportedInput)
    try {
      expect(() => unsupported.activate(unsupportedCompiled)).toThrowError(expect.objectContaining<Partial<WorldError>>({
        envelope: expect.objectContaining({ errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE' }),
      }))
    } finally {
      await unsupported.close()
    }

    const missingStorage = paths()
    const missing = new WorldApplication({ ...missingStorage, rulebooks: createMysteryRulebookRegistry() })
    try {
      const compiled = compileMysteryDemo()
      expect(() => missing.activate(compiled)).toThrow('memoryPath')
    } finally {
      await missing.close()
    }

    const legacyStorage = paths()
    const legacy = new WorldApplication({ ...legacyStorage, rulebooks: createMysteryRulebookRegistry() })
    const legacyCompiled = compileLegacyMysteryDemo()
    try {
      legacy.activate(legacyCompiled)
      await expect(legacy.recallMemory(
        legacyCompiled.manifest.address,
        brandId(MYSTERY_DEMO_IDS.bob, 'CharacterId'),
        'is_culprit',
      )).rejects.toThrowError(expect.objectContaining<Partial<WorldError>>({
        envelope: expect.objectContaining({ errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE' }),
      }))
    } finally {
      await legacy.close()
    }
  })

  it('freezes the pre-extraction v3/v4 resolver and complete v4 opening authority', async () => {
    const compiled = compileLegacyMysteryDemo()
    expect(createMysteryRulebookRegistry().resolve('builtin:speak-move', 4, 'golden:affordances').affordances({
      manifest: compiled.manifest,
      events: [],
      characterId: MYSTERY_DEMO_IDS.player,
    }).map(value => value.actionType)).toEqual([
      'speak', 'move', 'take', 'inspect', 'ask', 'present_evidence', 'accuse',
    ])
    const history = compiled.genesisEvents.map(event => ({ eventType: event.eventType, data: event.data }))
    const resolver = new MysteryRulebookResolver()
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
      const resolution = resolver.resolve({
        manifest: { ...compiled.manifest, rulebook: { ...compiled.manifest.rulebook, version } },
        events: history,
        characterId: MYSTERY_DEMO_IDS.player,
        action: { actionType: 'inspect', parameters: { entityId: MYSTERY_DEMO_IDS.desk } },
      })
      const worldJson = resolution as unknown as WorldJsonValue
      expect(Buffer.from(canonicalizeWorldJson(worldJson)).toString('utf8')).toBe(expected[version].canonical)
      expect(hashWorldJson('golden-rulebook-resolution', worldJson)).toBe(expected[version].hash)
    }

    const storage = paths()
    const scenario = new MysteryDemoScenario({ ...storage, compatibility: 'legacy-v4' })
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

  it('freezes ask, present, and culprit-resolution bytes for both legacy investigation versions', () => {
    const compiled = compileLegacyMysteryDemo()
    const resolver = new MysteryRulebookResolver()
    const expected = {
      3: [
        { actionType: 'ask', canonical: '{"events":[{"data":{"characterId":"character:player","targetCharacterId":"character:bob","topicId":"entity:study-desk"},"eventType":"character.asked","eventVersion":1},{"data":{"id":"observation:investigation-rule:e8538963132be22de72762e7","value":{"content":{"actionType":"ask","targetCharacterId":"character:bob","topicId":"entity:study-desk"},"observerId":"character:player","source":"rulebook:investigation/v3"}},"eventType":"observation.upsert","eventVersion":1}],"status":"accepted"}', hash: 'sha256:43686d94731269aa6136bb08fc66536b56ce4bb1caf98c7737b3b6b49866d6b9' },
        { actionType: 'present_evidence', canonical: '{"events":[{"data":{"characterId":"character:player","evidenceId":"evidence:key-moved","targetCharacterId":"character:detective"},"eventType":"evidence.presented","eventVersion":1},{"data":{"id":"observation:investigation-rule:64aa2a73e3b7a60bbf7e72f6","value":{"content":{"actionType":"present_evidence","evidenceId":"evidence:key-moved","targetCharacterId":"character:detective"},"observerId":"character:player","source":"rulebook:investigation/v3"}},"eventType":"observation.upsert","eventVersion":1}],"status":"accepted"}', hash: 'sha256:aeef283c2d7e463f2d4fd1bac5356dce663b2cc4c6feca216c81da549376cf51' },
        { actionType: 'accuse', canonical: '{"events":[{"data":{"characterId":"character:player","evidenceIds":["evidence:key-moved"],"outcome":"correct","suspectId":"character:bob"},"eventType":"investigation.accusation-resolved","eventVersion":1},{"data":{"culpritId":"character:bob","resolvedBy":"character:player"},"eventType":"investigation.case-closed","eventVersion":1},{"data":{"id":"observation:investigation-rule:193ac801625dc4c0f02c2e3f","value":{"content":{"actionType":"accuse","evidenceIds":["evidence:key-moved"],"outcome":"correct","suspectId":"character:bob"},"observerId":"character:player","source":"rulebook:investigation/v3"}},"eventType":"observation.upsert","eventVersion":1}],"status":"accepted"}', hash: 'sha256:249279f48e4d55a1db755322a4d8fa40101401df10fcdee0884bf852a948e5ee' },
      ],
      4: [
        { actionType: 'ask', canonical: '{"events":[{"data":{"characterId":"character:player","targetCharacterId":"character:bob","topicId":"entity:study-desk"},"eventType":"character.asked","eventVersion":1},{"data":{"id":"observation:investigation-rule:e8538963132be22de72762e7","value":{"content":{"actionType":"ask","targetCharacterId":"character:bob","topicId":"entity:study-desk"},"observerId":"character:player","source":"rulebook:investigation/v4"}},"eventType":"observation.upsert","eventVersion":1}],"status":"accepted"}', hash: 'sha256:ac19993c0b58f6eddaa8e839c7eeb6300c7d6e9977e89081b9cc58300790df6d' },
        { actionType: 'present_evidence', canonical: '{"events":[{"data":{"characterId":"character:player","evidenceId":"evidence:inspection:entity:study-desk","targetCharacterId":"character:detective"},"eventType":"evidence.presented","eventVersion":1},{"data":{"id":"observation:investigation-rule:e2e4589583e5289baeaca809","value":{"content":{"actionType":"present_evidence","evidenceId":"evidence:inspection:entity:study-desk","targetCharacterId":"character:detective"},"observerId":"character:player","source":"rulebook:investigation/v4"}},"eventType":"observation.upsert","eventVersion":1}],"status":"accepted"}', hash: 'sha256:7a87315f703d21f86354ddbb1bf598d7a607f244d683b9dc47349ed390e032f3' },
        { actionType: 'accuse', canonical: '{"events":[{"data":{"characterId":"character:player","evidenceIds":["evidence:inspection:entity:study-desk"],"outcome":"correct","suspectId":"character:bob"},"eventType":"investigation.accusation-resolved","eventVersion":1},{"data":{"culpritId":"character:bob","resolvedBy":"character:player"},"eventType":"investigation.case-closed","eventVersion":1},{"data":{"id":"observation:investigation-rule:277454bc177eaf84e4455d7d","value":{"content":{"actionType":"accuse","evidenceIds":["evidence:inspection:entity:study-desk"],"outcome":"correct","suspectId":"character:bob"},"observerId":"character:player","source":"rulebook:investigation/v4"}},"eventType":"observation.upsert","eventVersion":1}],"status":"accepted"}', hash: 'sha256:6f5d4587950816fbdd2d8efec3e76bffb6c11b124a758c189740615b67e389e7' },
      ],
    } as const
    for (const version of [3, 4] as const) {
      const manifest = { ...compiled.manifest, rulebook: { ...compiled.manifest.rulebook, version } }
      let history = compiled.genesisEvents.map(event => ({ eventType: event.eventType, data: event.data }))
      const evidenceId = version === 3 ? 'evidence:key-moved' : 'evidence:inspection:entity:study-desk'
      const inspected = resolver.resolve({
        manifest, events: history, characterId: MYSTERY_DEMO_IDS.player,
        action: { actionType: 'inspect', parameters: { entityId: MYSTERY_DEMO_IDS.desk } },
      })
      history = [...history, ...inspected.events.map(event => ({ eventType: event.eventType, data: event.data }))]
      const actions = [
        { actionType: 'ask', parameters: { targetCharacterId: MYSTERY_DEMO_IDS.bob, topicId: MYSTERY_DEMO_IDS.desk } },
        { actionType: 'present_evidence', parameters: { evidenceId, targetCharacterId: MYSTERY_DEMO_IDS.detective } },
        { actionType: 'accuse', parameters: { suspectId: MYSTERY_DEMO_IDS.bob, evidenceIds: [evidenceId] } },
      ] as const
      for (const [index, action] of actions.entries()) {
        const resolution = resolver.resolve({ manifest, events: history, characterId: MYSTERY_DEMO_IDS.player, action })
        const worldJson = resolution as unknown as WorldJsonValue
        expect(Buffer.from(canonicalizeWorldJson(worldJson)).toString('utf8')).toBe(expected[version][index]!.canonical)
        expect(hashWorldJson('golden-rulebook-resolution', worldJson)).toBe(expected[version][index]!.hash)
        history = [...history, ...resolution.events.map(event => ({ eventType: event.eventType, data: event.data }))]
      }
    }
  })

  it.each([3, 4] as const)('keeps an existing v%s world operational through submit, fork, archive, and quarantine recovery', async version => {
    const storage = paths()
    const input = createLegacyMysteryDemoSpec() as unknown as Record<string, WorldJsonValue>
    input.address = {
      tenantId: 'tenant:mystery-demo', worldId: `world:legacy-lifecycle-v${version}`, branchId: 'branch:main',
    }
    input.rulebook = { rulebookId: 'builtin:speak-move', version }
    const compiled = new WorldSpecCompiler().compile(input)
    if (version === 3) {
      const bootstrapStore = new WorldStore(storage.worldPath)
      try {
        const identity = {
          address: compiled.manifest.address,
          manifestHash: compiled.manifestHash,
          genesisHash: compiled.genesisHash,
        }
        bootstrapStore.activateBranch({
          address: compiled.manifest.address,
          manifest: compiled.manifest,
          manifestHash: compiled.manifestHash,
          genesisEvents: compiled.genesisEvents,
          genesisHash: compiled.genesisHash,
          transactionId: brandId(deterministicId('transaction:genesis', identity), 'TransactionId'),
          roundId: brandId(deterministicId('round:genesis', identity), 'InteractionRoundId'),
          correlationId: 'legacy-v3-frozen-fixture',
        })
      } finally {
        bootstrapStore.close()
      }
    }
    const application = new WorldApplication({ ...storage, rulebooks: createMysteryRulebookRegistry() })
    const parent = compiled.manifest.address
    const child = { ...parent, branchId: brandId(`branch:legacy-v${version}-child`, 'BranchId') }
    try {
      if (version === 4) application.activate(compiled)
      await expect(application.submit(parent, {
        idempotencyKey: `legacy-v${version}:inspect`, principalId: 'principal:mystery-player',
        action: { actionType: 'inspect', parameters: { entityId: MYSTERY_DEMO_IDS.desk } },
        correlationId: `legacy-v${version}:inspect`,
      })).resolves.toMatchObject({ status: 'accepted', tick: 1 })
      await application.deliver(parent, `legacy-v${version}:deliver-parent`)
      await application.release(parent)
      const quarantine = new BranchQuarantineService(storage.worldPath)
      try {
        quarantine.quarantine({
          address: parent,
          error: createErrorEnvelope({
            errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', message: 'legacy lifecycle drill',
            retryable: false, correlationId: `legacy-v${version}:quarantine`, address: parent,
          }),
          source: 'mystery-legacy-lifecycle.test',
        })
      } finally {
        quarantine.close()
      }
      await expect(application.quarantineRecover(parent, `legacy-v${version}:recover`))
        .resolves.toMatchObject({ status: 'recovered' })
      await expect(application.submit(parent, {
        idempotencyKey: `legacy-v${version}:after-recovery`, principalId: 'principal:mystery-player',
        action: { actionType: 'speak', parameters: { text: '恢复后继续调查。' } },
        correlationId: `legacy-v${version}:after-recovery`,
      })).resolves.toMatchObject({ status: 'accepted', tick: 2 })
      await application.deliver(parent, `legacy-v${version}:deliver-recovered-parent`)
      await expect(application.forkAtHead(parent, child, 'legacy lifecycle fixture', `legacy-v${version}:fork`))
        .resolves.toMatchObject({ forkSeq: expect.any(Number) })
      await expect(application.submit(child, {
        idempotencyKey: `legacy-v${version}:child-ask`, principalId: 'principal:mystery-player',
        action: {
          actionType: 'ask',
          parameters: { targetCharacterId: MYSTERY_DEMO_IDS.bob, topicId: MYSTERY_DEMO_IDS.desk },
        },
        correlationId: `legacy-v${version}:child-ask`,
      })).resolves.toMatchObject({ status: 'accepted', tick: 3 })
      await application.deliver(child, `legacy-v${version}:deliver-child`)
      await expect(application.archive(child, 'legacy lifecycle complete', `legacy-v${version}:archive`))
        .resolves.toMatchObject({ state: { lifecycleState: 'archived' } })
    } finally {
      await application.close()
    }

    const generic = new WorldApplication(storage)
    try {
      await expect(generic.head(parent)).rejects.toMatchObject({ envelope: { errorCode: 'RULEBOOK_NOT_REGISTERED' } })
      expect(generic.activeBranchCount).toBe(0)
    } finally {
      await generic.close()
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
      expect(genesis.views.alice.scenes).toEqual([])
      expect(genesis.views.bob.scenes.map(value => value.sceneId)).toEqual([MYSTERY_DEMO_IDS.scene])
      expect(await first.recall(MYSTERY_DEMO_IDS.bob, 'is_culprit')).toHaveLength(1)
      expect(await first.recall(MYSTERY_DEMO_IDS.alice, 'is_culprit', genesis.headSeq)).toEqual([])
      expect(await first.recall(MYSTERY_DEMO_IDS.detective, 'may_be_involved')).toHaveLength(1)
      expect(await first.recall(MYSTERY_DEMO_IDS.player, 'is_culprit')).toEqual([])
      // The diagnostic reports the default limit and the candidate count each Recall was choosing from.
      expect(await first.diagnoseRecall(MYSTERY_DEMO_IDS.bob, 'is_culprit'))
        .toMatchObject({ schemaVersion: 'recall-candidates/v1', matchedCount: 1, limit: 10 })
      expect(await first.diagnoseRecall(MYSTERY_DEMO_IDS.detective, 'may_be_involved'))
        .toMatchObject({ matchedCount: 1 })
      expect(await first.diagnoseRecall(MYSTERY_DEMO_IDS.player, 'is_culprit')).toMatchObject({ matchedCount: 0 })
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
      expect(JSON.stringify(committed.views.player)).toContain('"actionType":"take"')
      expect(JSON.stringify(committed.views.bob)).toContain('"actionType":"take"')
      expect(JSON.stringify(committed.views.detective)).toContain('"actionType":"take"')
      expect(JSON.stringify(committed.views.alice)).not.toContain('"actionType":"take"')
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
      const authorityParticipants = (committed.authority?.authority.participants ?? []) as Array<Record<string, unknown>>
      const bobAuthority = authorityParticipants.find(value => value.participantId === 'agent:bob')!
      const directorAuthority = authorityParticipants.find(value => value.participantId === 'director:detective-observer')!
      expect(bobAuthority).toMatchObject({ memorySourceRefs: [], recallResultHash: expect.stringMatching(/^sha256:/u) })
      expect(bobAuthority.contextHash).not.toBe(directorAuthority.contextHash)
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

  it('keeps Cognitive Memory isolated across a fork and its parent future', async () => {
    const storage = paths()
    const application = new WorldApplication({
      ...storage,
      memoryPath: `${storage.worldPath}.memory.sqlite`,
      rulebooks: createMysteryRulebookRegistry(),
    })
    const compiled = compileMysteryDemo()
    const parent = compiled.manifest.address
    const child = { ...parent, branchId: brandId('branch:memory-child', 'BranchId') }
    const bob = brandId(MYSTERY_DEMO_IDS.bob, 'CharacterId')
    try {
      application.activate(compiled)
      await application.submit(parent, {
        idempotencyKey: 'memory:before-fork', principalId: 'principal:mystery-player',
        action: { actionType: 'speak', parameters: { text: '共同前缀' } }, correlationId: 'memory:before-fork',
      })
      await application.deliver(parent, 'memory:deliver-before-fork')
      await application.forkAtHead(parent, child, 'memory isolation', 'memory:fork')
      await application.submit(parent, {
        idempotencyKey: 'memory:future', principalId: 'principal:mystery-player',
        action: { actionType: 'speak', parameters: { text: 'FUTURE_CANARY' } }, correlationId: 'memory:future',
      })
      expect(await application.recallMemory(parent, bob, 'FUTURE_CANARY')).toHaveLength(1)
      expect(await application.recallMemory(child, bob, 'FUTURE_CANARY')).toEqual([])
      expect(await application.recallMemory(child, bob, '共同前缀')).toHaveLength(1)
    } finally {
      await application.close()
    }
  })

  it('recovers committed cognitive jobs after a process stops before Memory catch-up', async () => {
    const storage = paths()
    const first = new MysteryDemoScenario({
      ...storage,
      faultInjector: {
        hit(point) {
          if (point === 'memory.before-catchup') throw new Error('simulated Memory worker outage')
        },
      },
    })
    let committed
    try {
      committed = await first.submitPlayerText('这轮事实必须先提交。', 'memory:restart-worker')
      expect(committed).toMatchObject({ status: 'submitted', result: { tick: 1 } })
    } finally {
      await first.close()
    }
    const before = new WorldStore(storage.worldPath)
    expect(before.readCognitiveJobs(compileMysteryDemo().manifest.address)).not.toHaveLength(0)
    expect(before.readCognitiveJobs(compileMysteryDemo().manifest.address).every(job => job.status === 'failed')).toBe(true)
    before.close()

    const restarted = new MysteryDemoScenario(storage)
    try {
      expect(await restarted.submitPlayerText('这轮事实必须先提交。', 'memory:restart-worker')).toEqual(committed)
      expect(restarted.providerCalls).toEqual({ bob: 0, director: 0 })
      const recovered = new WorldStore(storage.worldPath)
      expect(recovered.readCognitiveJobs(compileMysteryDemo().manifest.address)).toEqual([])
      expect(recovered.readCognitiveJobs(compileMysteryDemo().manifest.address, true).every(job => job.status === 'completed')).toBe(true)
      recovered.close()
    } finally {
      await restarted.close()
    }
  })

  it('closes a partial mount when a pending cognitive job fails integrity verification', async () => {
    const storage = paths()
    const scenario = new MysteryDemoScenario(storage)
    await scenario.runOpeningTurn()
    await scenario.close()
    const raw = new DatabaseSync(storage.worldPath)
    raw.prepare(`UPDATE world_cognitive_jobs SET status = 'pending', job_hash = 'sha256:forged'`).run()
    raw.close()

    const application = new WorldApplication({
      ...storage,
      memoryPath: `${storage.worldPath}.memory.sqlite`,
      rulebooks: createMysteryRulebookRegistry(),
    })
    try {
      await expect(application.head(compileMysteryDemo().manifest.address))
        .rejects.toMatchObject({ envelope: { errorCode: 'BUNDLE_HASH_MISMATCH' } })
      expect(application.activeBranchCount).toBe(0)
    } finally {
      await application.close()
    }
  })

  it('requires the configured Memory store before recovering a Context v2 branch', async () => {
    const storage = paths()
    const scenario = new MysteryDemoScenario(storage)
    await scenario.runOpeningTurn()
    await scenario.close()
    const compiled = compileMysteryDemo()
    const quarantine = new BranchQuarantineService(storage.worldPath)
    quarantine.quarantine({
      address: compiled.manifest.address,
      error: createErrorEnvelope({
        errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', message: 'missing Memory recovery fixture',
        retryable: false, correlationId: 'memory:missing-recovery', address: compiled.manifest.address,
      }),
      source: 'mystery-demo.test',
    })
    quarantine.close()

    const application = new WorldApplication({ ...storage, rulebooks: createMysteryRulebookRegistry() })
    try {
      await expect(application.quarantineRecover(compiled.manifest.address, 'memory:missing-recovery'))
        .rejects.toMatchObject({ envelope: { errorCode: 'RECOVERY_VALIDATION_FAILED' } })
    } finally {
      await application.close()
    }
  })

  it('repairs a divergent derived Memory namespace during quarantine recovery', async () => {
    const storage = paths()
    const memoryPath = `${storage.worldPath}.memory.sqlite`
    const scenario = new MysteryDemoScenario({ ...storage, memoryPath })
    await scenario.runOpeningTurn()
    await scenario.close()

    const raw = new DatabaseSync(memoryPath)
    raw.prepare(`UPDATE memory_source_mappings SET source_hash = 'sha256:forged'`).run()
    raw.close()

    const application = new WorldApplication({
      ...storage, memoryPath, rulebooks: createMysteryRulebookRegistry(),
    })
    const compiled = compileMysteryDemo()
    const bob = brandId(MYSTERY_DEMO_IDS.bob, 'CharacterId')
    try {
      await expect(application.recallMemory(compiled.manifest.address, bob, 'is_culprit'))
        .rejects.toMatchObject({ envelope: { errorCode: 'MEMORY_SOURCE_UNVERIFIED' } })
      expect(application.quarantineExplain(compiled.manifest.address)).toMatchObject({ runtimePhase: 'quarantined' })
      await expect(application.quarantineRecover(compiled.manifest.address, 'memory:repair'))
        .resolves.toMatchObject({ status: 'recovered', validationHash: expect.stringMatching(/^sha256:/) })
      expect(await application.recallMemory(compiled.manifest.address, bob, 'is_culprit')).toHaveLength(1)
    } finally {
      await application.close()
    }
  })

  it('degrades runtime Memory faults but preserves the quarantine boundary for integrity faults', async () => {
    const injector = (category: 'provider' | 'integrity'): FaultInjector => ({
      hit(point) {
        if (point !== 'memory.before-catchup') return
        failWorld({
          errorCode: category === 'integrity' ? 'BUNDLE_HASH_MISMATCH' : 'MODEL_PROVIDER_FAILED',
          category,
          message: `${category} memory fixture`,
          retryable: category !== 'integrity',
          correlationId: `memory:${category}`,
        })
      },
    })
    const degraded = new MysteryDemoScenario({ ...paths(), faultInjector: injector('provider') })
    try {
      await expect(degraded.submitPlayerText('普通对白', 'memory:provider-fault')).resolves.toMatchObject({
        status: 'submitted', result: { status: 'accepted', tick: 1 },
      })
    } finally {
      await degraded.close()
    }
    const quarantined = new MysteryDemoScenario({ ...paths(), faultInjector: injector('integrity') })
    try {
      await expect(quarantined.submitPlayerText('普通对白', 'memory:integrity-fault'))
        .rejects.toMatchObject({ envelope: { errorCode: 'BUNDLE_HASH_MISMATCH' } })
    } finally {
      await quarantined.close()
    }
  })
})
