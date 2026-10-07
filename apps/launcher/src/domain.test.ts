import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSharePreview, historyTo, resolveModel } from './domain.ts'
import { createMockInstance, packages } from './mock.ts'
import { useLauncherStore } from './stores/launcher.ts'

beforeEach(() => setActivePinia(createPinia()))
describe('Launcher prototype boundaries', () => {
  it('resolves character, group, and default without enabling hidden overrides', () => {
    const configuration = { defaultModelId: 'flash', overridesEnabled: true, groups: { main: 'pro' }, characters: { actor: 'gpt' } }
    expect(resolveModel(configuration, 'actor', 'main')).toBe('gpt')
    expect(resolveModel(configuration, 'other', 'main')).toBe('pro')
    expect(resolveModel(configuration, 'other', 'other')).toBe('flash')
    expect(resolveModel({ ...configuration, overridesEnabled: false }, 'actor', 'main')).toBe('flash')
  })
  it('creates a line at an old node without deleting or changing the old future', () => {
    const store = useLauncherStore()
    const before = JSON.stringify(store.currentInstance!.nodes)
    const oldLine = { ...store.currentStoryline! }
    const crossroads = store.currentHistory[1]!
    store.forkAt(crossroads.id, '我的选择')
    expect(JSON.stringify(store.currentInstance!.nodes)).toBe(before)
    expect(store.currentInstance!.storylines.find(line => line.id === oldLine.id)).toEqual(oldLine)
    expect(store.currentStoryline!.parentNodeId).toBe(crossroads.id)
    expect(store.currentHistory.map(node => node.turn)).toEqual([0, 80])
  })
  it('imports into a distinct instance and remaps models locally', () => {
    const store = useLauncherStore()
    const old = JSON.stringify(store.currentInstance)
    const oldId = store.currentInstance!.id
    store.globalDefaultModelId = 'pro'
    store.importMockStory()
    expect(store.currentInstance!.id).not.toBe(oldId)
    expect(JSON.stringify(store.instances.find(instance => instance.id === oldId))).toBe(old)
    expect(store.currentModel!.id).toBe('pro')
    expect(store.currentStoryline!.source.kind).toBe('shared')
    expect(store.currentNode!.turn).toBe(173)
    store.forkAt(store.currentHistory[1]!.id, '从朋友的过去开始')
    expect(store.currentHistory.map(node => node.turn)).toEqual([0, 80])
  })
  it('projects only explicit sharing fields, with no credential or local setting leakage', () => {
    const instance = createMockInstance()
    Object.assign(instance, { apiKey: 'secret-key', token: 'secret-token', dataDirectory: 'D:/private/path' })
    Object.assign(instance.model, { endpoint: 'https://private.example', apiKey: 'secret-model' })
    Object.assign(instance.nodes[0]!, { privatePath: 'D:/private/node' })
    const preview = createSharePreview(instance, packages[0]!, 'tree')
    const text = JSON.stringify(preview)
    for (const privateValue of ['secret-key', 'secret-token', 'D:/private/path', 'secret-model', 'private.example', 'D:/private/node']) expect(text).not.toContain(privateValue)
    expect(preview.nodes).toHaveLength(5)
    expect(createSharePreview(instance, packages[0]!, 'current-node').nodes).toHaveLength(1)
    expect(createSharePreview(instance, packages[0]!, 'storyline').nodes.map(node => node.turn)).toEqual([0, 80, 173, 284])
  })
  it('blocks an invalid package and a missing model, but allows degraded packages', () => {
    const store = useLauncherStore()
    store.selectPackage('last-light')
    store.startMock()
    expect(store.core.state).toBe('idle')
    store.selectPackage('quiet-town')
    store.currentInstance!.model.defaultModelId = null
    store.startMock()
    expect(store.core.state).toBe('idle')
    store.currentInstance!.model.defaultModelId = 'flash'
    store.startMock()
    expect(store.core.state).toBe('running')
    store.stopMock()
    expect(store.core.state).toBe('idle')
  })
  it('reports missing or cyclic mock history rather than hiding it', () => {
    expect(() => historyTo([], 'missing')).toThrow('节点缺失')
    const node = { id: 'a', parentNodeId: 'a', turn: 0, title: '', summary: '', createdAt: '' }
    expect(() => historyTo([node], 'a')).toThrow('关系异常')
  })
})
