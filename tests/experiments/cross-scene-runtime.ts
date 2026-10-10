import { readFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { brandId, hashWorldJson, interactionPackageDescription, RECALL_KEYWORD_TOKENIZER_ID, type WorldJsonObject } from '@harness-world/contracts'
import { adaptCompiledWorldPack, compileWorldPackSource } from '@harness-world/world-pack'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { WorldBootstrap, FrozenInteractionRulebook, createCoreRulebookRegistry } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService, CharacterViewBuilder, SessionDeliveryAdapter } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { runPrototypeActivations } from '../../packages/application/src/prototype-activation-cycle.ts'
import { CrossSceneCommunication } from './cross-scene-communication.ts'
import { CrossScenePhone, phoneCalls, type PhoneOperation } from './cross-scene-phone.ts'
import { SceneDecisionService } from '../../packages/application/src/scene-decision.ts'
import { PackActivities } from './pack-activities.ts'
import { playerTranscript } from './playtest-view.ts'
import { saveStoryNode } from '../../desktop/story-nodes.ts'
import { PlaytestMemoryCore, type MemoryContextBudget } from './playtest-memory-core.ts'
import type { CoreRunner } from './hindsight-python.ts'

export async function crossSceneRuntime(dataDirectory: string, decide: (request: PrototypeTurnRequest, signal: AbortSignal) => Promise<unknown>, options: { phone?: boolean; packPath?: string; activities?: boolean; storyNodes?: boolean; memoryCoreRun?: CoreRunner; memoryCoreBuildRun?: CoreRunner; memoryContextBudget?: MemoryContextBudget } = {}) {
  mkdirSync(dataDirectory, { recursive: true })
  const packPath = resolve(options.packPath ?? `examples/world-packs/cross-scene-${options.phone ? 'phone' : 'sms'}`)
  const installed = createInstalledInteractionPackages()
  const pack = await compileWorldPackSource(packPath, installed.map(interactionPackageDescription))
  let compiled = adaptCompiledWorldPack(pack, { address: { tenantId: brandId(options.storyNodes ? 'tenant:web-playtest' : 'tenant:sms-experiment', 'TenantId'),
    worldId: brandId(`world:${options.storyNodes ? 'web-playtest' : options.phone ? 'phone' : 'sms'}:${pack.packHash.slice(7, 23)}`, 'WorldId'), branchId: brandId('branch:main', 'BranchId') },
    principalId: options.storyNodes ? 'principal:web-playtest' : 'principal:sms', sessionId: brandId(options.storyNodes ? 'session:web-playtest' : 'session:sms', 'SessionId') })
  // Only this experimental host installs the call event; default compiled worlds stay unchanged.
  if (options.phone) {
    const name = 'communication.call-updated', version = 1
    const definitions = [...compiled.manifest.registries.events.definitions,
      { name, version, schemaHash: hashWorldJson('registry-definition-schema', { name, version }) }]
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const manifest = { ...compiled.manifest, registries: { ...compiled.manifest.registries,
      events: { definitions, registryHash: hashWorldJson('compiled-event-registry', definitions) } } }
    const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
    const genesisEvents = compiled.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
      ? { ...event, data: { ...(event.data as WorldJsonObject), manifestHash } } : event)
    compiled = { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
  }
  const manifest = compiled.manifest, address = manifest.address, path = join(dataDirectory, 'world.sqlite')
  const store = new WorldStore(path)
  new WorldBootstrap(store, true, new FrozenInteractionRulebook(installed)).activate(compiled)
  const leases = new WriterLeaseService(path), availability = new CharacterRuntimeAvailabilityService(path)
  availability.initialize(address, manifest.characters.map(c => ({ characterId: c.characterId, state: 'ready' as const })))
  const memory = new CognitiveMemoryService(join(dataDirectory, 'memory.sqlite'), store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
  const session = options.storyNodes ? new SessionDeliveryAdapter(join(dataDirectory, 'session.sqlite')) : undefined
  const memoryCore = options.memoryCoreRun ? new PlaytestMemoryCore(dataDirectory, address, options.memoryCoreRun,
    options.memoryContextBudget, { run: options.memoryCoreBuildRun ?? options.memoryCoreRun }) : undefined
  // Core follows the ordinary host: only callable NPCs have archives and identity histories.
  const characterIds = manifest.characters.map(c => c.characterId).filter(id => id !== 'character:player')
  const rebuildPath = join(dataDirectory, 'rebuild-memory.json')
  if (existsSync(rebuildPath)) {
    try {
      if (!options.storyNodes) throw new TypeError('恢复节点需要启用故事节点实验')
      const rebuild = JSON.parse(readFileSync(rebuildPath, 'utf8')) as { headSeq: number; packHash: string }
      if (rebuild.packHash !== pack.packHash || rebuild.headSeq !== store.head(address).headSeq) throw new TypeError('故事节点恢复前缀不一致')
      const archivesPath = join(dataDirectory, 'core-memory.json')
      const archives = existsSync(archivesPath) ? JSON.parse(readFileSync(archivesPath, 'utf8')) as WorldJsonObject : {}
      const aliasesPath = join(dataDirectory, 'memory-aliases.json')
      if (memoryCore) {
        memoryCore.restoreArchives(archives, characterIds)
        memoryCore.snapshotAliases(characterIds)
      } else {
        if (Object.keys(archives).length) throw new TypeError('原生记忆实验不消费 Core 快照')
        if (existsSync(aliasesPath) && Object.keys(JSON.parse(readFileSync(aliasesPath, 'utf8')) as object).length) throw new TypeError('原生记忆实验不恢复 Core 身份别名')
      }
      for (const character of manifest.characters) memory.catchUp(address, character.characterId, rebuild.headSeq, 'communication-node:rebuild')
      unlinkSync(rebuildPath)
    } catch (error) { await memoryCore?.close(); memory.close(); session?.close(); availability.close(); leases.close(); store.close(); throw error }
  }
  const base = createCoreRulebookRegistry({ interactionPackages: installed }).resolve('builtin:speak-move', 2, 'sms', address)
  const config: unknown = JSON.parse(readFileSync(join(packPath, 'communication.json'), 'utf8'))
  const scenes = new SceneDecisionService(store, availability, 2)
  const communication = options.phone ? new CrossScenePhone(config, manifest, base,
    (events, actor) => scenes.decideFromEvents(address, brandId(actor, 'CharacterId'), events, events.length).observerIds)
    : new CrossSceneCommunication(config, manifest, base)
  const playerId = brandId('character:player', 'CharacterId'), npcIds = manifest.characters.map(c => c.characterId).filter(id => id !== playerId)
  const activities = options.activities ? PackActivities.load(packPath, pack, path, address, playerId) : undefined
  if (options.activities && !activities) throw new TypeError('组合实验缺少活动脚本')
  // Activity is the outer rule boundary: its existing policy checks precede communication execution.
  const rulebooks = activities?.rulebooks(communication.resolver()) ?? communication.registry()
  const resolver = rulebooks.resolve('builtin:speak-move', 2, 'communication-experiment', address)
  const turn = new PrototypeCharacterTurn({ address, store, leases, availability, ...(memoryCore ? {
    shortTermAfterSeq: (actor: typeof playerId) => memoryCore.shortTermAfterSeq(actor),
  } : { memory }), rulebooks,
    executionResult: input => String((input.action.parameters as WorldJsonObject).bindingId).startsWith('experiment:')
      ? communication.executionResult(input) : activities?.executionResult(input) ?? communication.executionResult(input),
    decide: async (request, signal) => {
      const projected = memoryCore ? await memoryCore.project(request, signal) : request
      const decision = await decide(projected, signal)
      memoryCore?.recordDecision(projected, decision)
      return decision
    },
    projectContext: (context, canPerform) => ({ ...(activities?.projectContext(context, canPerform) ?? context),
      communicationInstruction: options.phone ? phoneInstruction : communicationInstruction }),
    ...(activities ? { validateDecision: (decision: WorldJsonObject, request: PrototypeTurnRequest) => activities.validateDecision(decision, request) } : {}) })
  const view = (id: string) => new CharacterViewBuilder(store).rebuildAt(address, brandId(id, 'CharacterId'), store.head(address).headSeq)
  const react = async (sent: { afterSeq: number; status: string }, signal: AbortSignal) => {
    const cycle = await runPrototypeActivations({ store, address, turn, afterSeq: sent.afterSeq, characterIds: npcIds, signal,
      presentCharacterIds: () => [], limits: { maximumWaves: 3, maximumNpcCalls: 12, maximumCallsPerCharacter: 2, reactionDeadlineSeconds: 120 } })
    const names = new Map(manifest.characters.map(c => [String(c.characterId), c.name]))
    return { sent, cycle, transcript: playerTranscript(view(playerId), names, playerId) }
  }
  let activeWork = 0, saving = false
  const work = async <T>(operation: () => Promise<T>) => {
    if (saving) throw new Error('正在保存节点，暂不能执行行动')
    activeWork++
    try { return await operation() } finally { activeWork-- }
  }
  return { store, leases, availability, memory, memoryCore, communication, activities, resolver, manifest, address, packHash: pack.packHash, turn, view,
    async refreshMemory() {
      if (!memoryCore) throw new Error('没有启用 Core 记忆实验')
      return work(() => memoryCore.refresh(characterIds, new AbortController().signal, () => {}))
    },
    activate(id: string, input: Parameters<PrototypeCharacterTurn['run']>[1] = {}) { return work(() => turn.run(brandId(id, 'CharacterId'), input)) },
    async saveNode(title: string) {
      if (!options.storyNodes) throw new Error('没有启用故事节点实验')
      if (activeWork || saving) throw new Error('等待当前行动完成后保存节点')
      saving = true
      try {
        memoryCore?.cancelBackground()
        await memoryCore?.waitForBackground()
        const head = store.head(address)
        for (const character of manifest.characters) memory.catchUp(address, character.characterId, head.headSeq, 'communication-node:save')
        return await saveStoryNode(dataDirectory, address, pack.packHash, title, memoryCore?.snapshotAliases(characterIds) ?? {},
          undefined, undefined, memoryCore?.snapshotArchives(characterIds) ?? {})
      } finally { saving = false }
    },
    async send(text: string, recipientId = 'character:companion', signal = new AbortController().signal) {
      return work(async () => {
        const sent = await communication.send({ store, leases, address, manifest, actorId: playerId, recipientId, text, resolver })
        return react(sent, signal)
      })
    },
    async phone(operation: PhoneOperation, text?: string, recipientId = 'character:companion', signal = new AbortController().signal) {
      if (!(communication instanceof CrossScenePhone)) throw new TypeError('当前入口没有电话能力')
      const phone = communication
      return work(async () => {
        const call = phone.callFor(store.readEvents(address), playerId)
          ?? phoneCalls(store.readEvents(address)).findLast(c => [c.callerId, c.calleeId].includes(playerId))
        const sent = await communication.perform({ store, leases, address, manifest, actorId: playerId,
          parameters: phone.phoneParameters(operation, recipientId, operation === 'call' ? undefined : call?.callId, text), resolver })
        return { ...await react(sent, signal), calls: phoneCalls(store.readEvents(address)) }
      })
    },
    async close() { await memoryCore?.close(); memory.close(); session?.close(); availability.close(); leases.close(); store.close() },
  }
}

export const communicationInstruction = '这是跨场景通信实验。experiment:message 是一次远程投递；targetRef 是联系人，不表示在场。arguments.text 自主填写要发出的消息正文，不要复制空示例。远程回复必须 perform 此交互；publish 是本地表达，不能送到远端。短信只证明发送者这样说，不证明正文描述的事情发生。发送后可继续本地表达或 abstain。'
export const phoneInstruction = '这是跨场景电话实验。phone-call 发出呼叫；收到呼叫后你自主选择 phone-accept 接听、phone-decline 拒接，也可 abstain 暂不处理。接通后 phone-say 的 arguments.text 自主填写你要在电话里说的话，本地旁观者可能听见你的这一端声音，但听不见远端声音；普通 publish 只在本地传播，不经过电话。phone-hangup 结束连接。复制可用操作的绑定、定义和 callId，不要复制空正文。接听只授权这次连接，不授予对方房间视野。话语是说话者的陈述，不证明受控事实发生。你自主决定内容与是否继续通话。'
export function communicationContext(request: PrototypeTurnRequest): PrototypeTurnRequest {
  return { ...request, context: { ...request.context, communicationInstruction: request.context.communicationInstruction ?? communicationInstruction } as WorldJsonObject }
}
