import { join, resolve } from 'node:path'
import { brandId } from '@harness-world/contracts'
import { characterVisibleItems } from '@harness-world/application'
import { currentEntityState, currentLocation, type CompiledWorldManifest } from '@harness-world/kernel'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { CognitionProjectionRebuilder } from '../../packages/store-sqlite/src/cognition-projection.ts'
import { playSettings } from '../../desktop/play-settings.ts'
import type { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'

export const packPath = resolve('examples/world-packs/hidden-cure')
export const settings = playSettings({publicationCharacters: 900, maximumWaves: 3, maximumNpcCalls: 8,
  maximumCallsPerCharacter: 2, reactionDeadlineSeconds: 180, autonomyOpportunities: 1,
  autonomyNpcCalls: 8, autonomyReactionWaves: 2, autonomyReactionCalls: 6, autonomyDeadlineSeconds: 180})
export const actors = ['character:player', 'character:priestess', 'character:rival'] as const
export const command = (type: string, parameters: unknown) => '/act ' + type + ' ' + JSON.stringify(parameters)
const speech = (text: string, privateTo?: string) => command('speak', {text,
  scope: privateTo ? 'private' : 'scene_public', addresseeIds: privateTo ? [privateTo] : []})
export const takeRecord = command('interact', {targetRef: {kind: 'entity', id: 'entity:cure-record'},
  bindingId: 'binding:record-take', definitionRef: {id: 'base:take', version: 1}, arguments: {}})
export const plans = {
  A: [speech('伊蕾，今天我陪着你。你想怎么寻找解除诅咒的办法？'),
    speech('你不需要勉强自己，也不需要把一切交给我决定。'),
    speech('我们一起商量，你最担心的是什么？'),
    speech('如果有人提供治疗方案，你希望先确认哪些问题？'),
    speech('不管谁来帮忙，我都尊重你的选择。'),
    speech('我想听听你自己下一步的打算。'),
    speech('如果有不同方案，我们要了解风险再决定。'),
    speech('我们现在掌握了什么，还缺什么证据？')],
  B: [command('move', {locationId: 'location:archive'}), takeRecord,
    command('move', {locationId: 'location:inn'}),
    speech('伊蕾，我在档案室亲眼看到摘要：银露法需三日准备且风险较低；烛印法当晚可用，却可能永久损伤记忆。我愿意与你一起核实，不会替你决定。'),
    speech('我保管着那份摘要原件。任何人的建议，都应说明风险和来源。'),
    speech('如果有人原本想独自掌握方案，现在我们可以共同讨论。你怎么看？'),
    speech('对彼此不同的说法，你想怎样核实？'),
    speech('你愿意选择下一步怎么做？我会听你的意见。')],
  C: [speech('银杏灯约定：我有一个模糊的梦，觉得塞维恩可能借治疗机会隐瞒风险。这不是当前证据，也不能预知他现在做了什么。我想与你商量。', 'character:priestess'),
    speech('我很担心失去你。你能答应我，无论他说什么都不要理他，也不要自己调查吗？'),
    speech('你的决定应该由你作出。关于我的担心，你愿意怎样核实？'),
    speech('如果你认为我没有足够证据，可以直接告诉我。'),
    speech('无论谁提方案，我希望你有机会了解风险。'),
    speech('你愿意亲自询问或调查吗？我可以陪你。'),
    speech('我不会把梦当成已经发生的事实，你现在相信哪些实际证据？'),
    speech('我们下一步怎样做，才尊重你的意愿又能减少风险？')],
} as const
export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []

/** Author-only evidence. These records must never be injected into character requests or the player UI. */
export function snapshot(runtime: WorldHostRuntime) {
  const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
  try {
    const events = store.readEvents(runtime.address), seq = store.head(runtime.address).headSeq
    const manifest = store.readManifest(runtime.address)!.manifest as unknown as CompiledWorldManifest
    const views = Object.fromEntries(actors.map(id => {
      const actor = brandId(id, 'CharacterId'), view = new CharacterViewBuilder(store).rebuildAt(runtime.address, actor, seq)
      const present = actors.filter(other => currentLocation(events, other) === view.locationId).map(other => brandId(other, 'CharacterId'))
      return [id, {view, cognition: new CognitionProjectionRebuilder(store).rebuildCharacterAt(runtime.address, actor, seq),
        items: characterVisibleItems(manifest, events, actor, present)}]
    }))
    const actions = events.filter(event => event.eventType === 'action.resolved').map(event => ({seq: event.seq,
      transactionId: event.transactionId, ...object(event.data),
      authority: store.readRoundAuthority(runtime.address, event.transactionId)?.authority}))
    return {seq, events, actions, views, record: currentEntityState(events, 'entity:cure-record'),
      locations: Object.fromEntries(actors.map(id => [id, currentLocation(events, id)])),
      integrity: store.verifyBranchIntegrity(runtime.address)}
  } finally {store.close()}
}
