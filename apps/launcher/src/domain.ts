import type { GameInstance, ModelConfiguration, ModelProfile, StoryNode, StorylineShare, ExportScope, GamePackage } from './types.ts'

export function resolveModel(configuration: ModelConfiguration, characterId: string, groupId: string): string | null {
  if (!configuration.overridesEnabled) return configuration.defaultModelId
  return configuration.characters[characterId] || configuration.groups[groupId] || configuration.defaultModelId
}
export function availableModel(id: string | null, profiles: ModelProfile[]): ModelProfile | undefined {
  return profiles.find(profile => profile.id === id)
}
/** Follows immutable parent links, even when a new line starts at an old node. */
export function historyTo(nodes: readonly StoryNode[], currentId: string): StoryNode[] {
  const indexed = new Map(nodes.map(node => [node.id, node]))
  const result: StoryNode[] = []
  const visited = new Set<string>()
  let next: string | null = currentId
  while (next) {
    if (visited.has(next)) throw new Error('故事历史关系异常。')
    visited.add(next)
    const node = indexed.get(next)
    if (!node) throw new Error('故事历史节点缺失。')
    result.unshift(node)
    next = node.parentNodeId
  }
  return result
}
/** Only seeded mock metadata can reach this preview. Never serialize a store or settings object. */
export function createSharePreview(instance: GameInstance, pack: GamePackage, scope: ExportScope): StorylineShare {
  const selected = instance.storylines.find(line => line.id === instance.currentStorylineId)
  if (!selected) throw new Error('当前故事线不存在。')
  const lines = scope === 'tree' ? instance.storylines : [selected]
  const ids = new Set(lines.flatMap(line =>
    (scope === 'current-node' ? [instance.nodes.find(node => node.id === line.currentNodeId)].filter((node): node is StoryNode => !!node) : historyTo(instance.nodes, line.currentNodeId))
      .map(node => node.id)))
  return {
    prototype: true, packageId: pack.id, packageVersion: instance.packageVersion, scope,
    storylineId: selected.id, currentNodeId: selected.currentNodeId,
    storylines: lines.map(line => ({
      id: line.id, name: line.name, parentStorylineId: line.parentStorylineId, parentNodeId: line.parentNodeId,
      currentNodeId: line.currentNodeId,
      source: { kind: line.source.kind, label: line.source.label, storylineId: line.source.storylineId, nodeId: line.source.nodeId, turn: line.source.turn },
    })),
    nodes: instance.nodes.filter(node => ids.has(node.id)).map(node => ({
      id: node.id, parentNodeId: node.parentNodeId, turn: node.turn, title: node.title, summary: node.summary, createdAt: node.createdAt,
    })),
    modelReference: { ...pack.recommendation },
  }
}
