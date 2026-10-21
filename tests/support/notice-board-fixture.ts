/** Small controlled world using the existing frozen interaction fixture and host commit path. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brandId, hashWorldJson, resolutionAuthority, RECALL_KEYWORD_TOKENIZER_ID,
  type FaultInjector, type InteractionPackageImplementation, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry, type CompiledWorldManifestV10 } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { SceneDecisionService } from '../../packages/application/src/scene-decision.ts'
import { frozenInteractionWorld, basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'
import { createNoticeBoardPackage, inspectId, boardText, privateText } from './notice-board-capability.ts'

export const npc = brandId('character:npc', 'CharacterId')
export const player = brandId('character:player', 'CharacterId')
export const bob = brandId('character:bob', 'CharacterId')
export const priorText = "\u3010\u4e3b\u89c2\u8ba4\u8bc6\uff0c\u53ef\u4fee\u6b63\u3011\u65c5\u4eba\u5728\u521d\u6b21\u524d\u5f80\u6216\u964c\u751f\u7684\u573a\u6240\u82e5\u53c2\u8003\u65e7\u6750\u6599\u5bb9\u6613\u6307\u9519\u4f4d\u7f6e\uff0c\u4f46\u82e5\u6309\u7167\u5f53\u65e5\u66f4\u65b0\u7684\u5730\u56fe\u5219\u80fd\u51c6\u786e\u627e\u5bf9\u76ee\u7684\u5730\uff1b\u5728\u719f\u6089\u7684\u5e38\u53bb\u573a\u6240\u80fd\u591f\u51c6\u786e\u6307\u5f15\u76ee\u7684\u5730\u3002"
export const playerText = '这栋办事楼我们都是头一回来。我去年保存的介绍说登记处在隔壁小屋，今天还没有核实，想先过去碰碰运气。'
export function inspectDecision(target = 'entity:hall-board', args: WorldJsonObject = {}) {
  return { decision: 'perform', actionType: 'interact', parameters: {
    targetRef: { kind: 'entity', id: target }, bindingId: 'binding:' + target + ':inspect',
    definitionRef: { id: inspectId, version: 1 }, arguments: args,
  } }
}
export function capabilityWorld() {
  const base = frozenInteractionWorld(), pack = createNoticeBoardPackage()
  const entities = [
    { entityId: 'entity:hall-board', kind: 'notice-board', locationId: 'location:room' },
    { entityId: 'entity:private-board', kind: 'notice-board', locationId: 'location:room' },
    { entityId: 'entity:distant-board', kind: 'notice-board', locationId: 'location:next' },
  ]
  const catalog = { ...base.manifest.interactionCatalog,
    packages: [basicInteractionPackage.lock, pack.lock],
    definitions: [...basicInteractionPackage.definitions, ...pack.definitions].map(d => ({
      ref: { id: d.spec.id, version: d.spec.version }, definitionHash: hashWorldJson('interaction-definition/v1', d.spec),
      implementationHash: d.implementationHash,
    })),
    bindings: entities.map(e => ({ bindingId: 'binding:' + e.entityId + ':inspect',
      targetRef: { kind: 'entity' as const, id: e.entityId }, definitionRef: { id: inspectId, version: 1 },
      config: { text: e.entityId === 'entity:private-board' ? privateText : boardText,
        publicRead: e.entityId !== 'entity:private-board', readerId: bob },
    })).sort((a,b) => a.bindingId < b.bindingId ? -1 : 1),
  }
  const manifest: CompiledWorldManifestV10 = { ...base.manifest, entities,
    metadata: { title: '办事楼公告牌实验', description: '大厅内有一块公告牌，可以查看。' },
    characters: base.manifest.characters.map(c => ({ ...c,
      name: c.characterId === npc ? '小芷' : c.characterId === player ? '旅人' : '陆舟',
      portrayal: c.characterId === npc ? { text: '说话自然，自己决定是否回应、怎样行动。' } : null })),
    locations: base.manifest.locations.map(l => ({ ...l, name: l.locationId === 'location:room' ? '办事楼大厅' : '隔壁小屋' })),
    interactionCatalog: catalog,
  }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const prior = [
    '旅人用旧酒店介绍指路，带你去了旧前台；你亲眼看见旧前台已经关闭。',
    '旅人在另一处陌生办事点使用旧材料指路；你亲眼看见到达的是错误窗口。',
    '旅人改用现场更新的地图后，你们到达了正确窗口。',
    '在你们熟悉的常去地点，旅人带路，你们顺利到达。',
  ]
  const genesisEvents: WorldEventDraft[] = base.genesisEvents.filter(e => !['entity.upsert'].includes(e.eventType)).map(e =>
    e.eventType === 'world.manifest-locked' ? { ...e, data: { ...e.data as WorldJsonObject, manifestHash } } : e)
  genesisEvents.push(...entities.map(e => ({ eventType: 'entity.upsert', eventVersion: 1, data: e })))
  genesisEvents.push(...prior.map((text,i) => ({ eventType: 'observation.upsert', eventVersion: 1, data: {
    id: 'prior:' + i, value: { observerId: npc, epistemicKind: 'direct_observation', content: text },
  } })))
  genesisEvents.push({ eventType: 'observation.upsert', eventVersion: 1, data: {
    id: 'private:canary', value: { observerId: bob, content: privateText },
  } })
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}
export function openCapabilityWorld(directory: string, fault?: FaultInjector, reopen = false, world = capabilityWorld(), extraPackages: readonly InteractionPackageImplementation[] = []) {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'world.sqlite'), address = world.manifest.address
  const store = new WorldStore(path, fault), leases = new WriterLeaseService(path)
  const availability = new CharacterRuntimeAvailabilityService(path)
  if (reopen) {
    if (store.readManifest(address)?.manifestHash !== world.manifestHash) {
      availability.close(); leases.close(); store.close()
      throw new Error('experiment history manifest differs')
    }
  } else store.activateBranch({ ...world, address, transactionId: brandId('genesis:commit','TransactionId'),
    roundId: brandId('genesis','InteractionRoundId'), correlationId: 'capability-experiment' })
  const memory = new CognitiveMemoryService(join(directory, 'memory.sqlite'), store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
  const rules = createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage, createNoticeBoardPackage(), ...extraPackages] })
  const scene = new SceneDecisionService(store, availability, 2)
  const sources = (characterId = npc) => {
    memory.catchUp(address, characterId, store.head(address).headSeq, 'capability-source-audit')
    const db = new DatabaseSync(join(directory, 'memory.sqlite'), { readOnly: true })
    try { return db.prepare('SELECT namespace_key,source_id,source_seq,source_hash,epistemic_kind,text_value FROM cognitive_memory_v2_sources WHERE namespace_key = ?')
      .all([address.tenantId,address.worldId,address.branchId,characterId].join('\x1f')) as unknown as WorldJsonObject[] }
    finally { db.close() }
  }
  async function submitPlayer(text: string, tag: string) {
    const owner = 'capability-player:' + tag, lease = leases.acquire(address, owner, 180000)
    try {
      const head = store.head(address), history = store.readEvents(address)
      const roundId = brandId(owner, 'InteractionRoundId'), actionId = owner + ':action'
      const action = { actionType: 'speak', parameters: { text, scope: 'direct', addresseeIds: [npc] } }
      const authority = resolutionAuthority('player','manual_player_immediate')
      const rulebook = rules.resolve(world.manifest.rulebook.rulebookId, world.manifest.rulebook.version, owner, address)
      const resolution = rulebook.resolve({ manifest: world.manifest, manifestHash: world.manifestHash, events: history,
        characterId: player, asOfWorldSeq: head.headSeq, resolutionAuthority: authority, roundId, actionId, action })
      if (resolution.status !== 'accepted') throw new Error('player speech rejected')
      const speech = resolution.events.find(e => e.eventType === 'character.speak')!
      const audience = scene.audienceForAction(address, player, history, head.headSeq,
        { scope: 'direct', recipientIds: [npc] }).fullContentCharacterIds
      const drafts: WorldEventDraft[] = [...resolution.events,
        { eventType:'action.resolved',eventVersion:1,data:{roundId,actionId,participantId:owner,actorId:player,
          actionType:'speak',sourceRole:'player',order:0,accepted:true,reason:null}},
        ...[...new Set([...audience,player])].map(observerId => ({ eventType:'observation.upsert',eventVersion:1,data:{
          id:actionId+':observer:'+observerId,value:{observerId,actionId,content:{actorId:player,actionType:'speak',speech:speech.data}},
        } })),
        {eventType:'world.tick-advanced',eventVersion:1,data:{tick:head.tick+1,roundId}},
      ]
      await store.commitRound({ address,expectedHeadSeq:head.headSeq,expectedTick:head.tick,nextTick:head.tick+1,
        transactionId:brandId(owner+':commit','TransactionId'),roundId,correlationId:owner,events:drafts,outbox:[],
        writerFencingToken:lease.fencingToken,authority:{actorId:player,actionId,action,status:'accepted',reason:null,resolutionAuthority:authority} })
      return store.readEvents(address).filter(e => e.seq>head.headSeq && e.eventType==='observation.upsert'
        && (e.data as WorldJsonObject).value !== undefined).map(e => (e.data as WorldJsonObject).value as WorldJsonObject)
        .filter(v => v.observerId===npc)
    } finally { leases.release(address,owner,lease.fencingToken) }
  }
  return { world,address,store,memory,leases,availability,rules,sources,submitPlayer,
    close: () => { memory.close();availability.close();leases.close();store.close() } }
}
