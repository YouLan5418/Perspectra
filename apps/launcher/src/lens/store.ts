import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import type { LensSnapshot } from '../../../../desktop/lens/session.ts'
import type { LensChange } from '../../../../desktop/lens/diff.ts'
import type { LensNpcPlan, LensStart, LensStep } from '../../../../desktop/lens/simulation.ts'
import type { LensItem, LensSection } from '../../../../desktop/lens/view.ts'
import { lensRequest } from '../services/desktop.ts'
import { mockLensSnapshot } from '../mock.ts'

export type LensViewName = LensSection | 'simulation' | 'requests'

/** 透视页面的状态：后端每个操作都返回完整快照，这里只整体替换，不在前端改写包内容。 */
export const useLensStore = defineStore('lens', () => {
  const real = isTauri()
  /** 快照含 HostState 等递归结构；用 shallowRef 避免深层类型展开，替换时整体赋值。 */
  const snapshot = shallowRef<LensSnapshot | null>(null)
  const view = ref<LensViewName>('characters')
  const selectedId = ref('')
  const busy = ref(false)
  const error = ref('')

  const items = computed(() => snapshot.value?.view.items ?? [])
  const itemById = computed(() => new Map(items.value.map(item => [item.id, item])))
  const changesById = computed(() => new Map((snapshot.value?.changes ?? []).map(change => [change.id, change])))
  /** 子条目有变化的父条目。已删除的子条目不再带 parentId，按“父 id + /”前缀归属（例如事件的条件）。 */
  const changedParents = computed(() => {
    const parents = new Set<string>()
    for (const change of snapshot.value?.changes ?? []) {
      const parentId = itemById.value.get(change.id)?.parentId
      if (parentId !== undefined) parents.add(parentId)
      else if (change.kind === 'removed') {
        const slash = change.id.indexOf('/')
        if (slash > 0 && itemById.value.has(change.id.slice(0, slash))) parents.add(change.id.slice(0, slash))
      }
    }
    return parents
  })
  const hasChildChange = (id: string) => changedParents.value.has(id)
  const requestsOpenCount = computed(
    () => (snapshot.value?.requests ?? []).filter(r => r.state === 'open' || r.state === 'changed').length,
  )
  const selected = computed(() => itemById.value.get(selectedId.value))
  const childrenOf = (id: string) => items.value.filter(item => item.parentId === id)
  const inSection = (section: LensSection) => items.value.filter(item => item.section === section)
  /** 已删除的条目不在当前视图里，只能从改动列表找回标题。 */
  const removedIn = (section: LensSection) =>
    (snapshot.value?.changes ?? []).filter(
      (change): change is Extract<LensChange, { kind: 'removed' }> =>
        change.kind === 'removed' && change.section === section,
    )
  /** 一个分区里有改动的条目数（含已删除）。 */
  const changeCount = (section: LensSection) =>
    (snapshot.value?.changes ?? []).filter(change =>
      change.kind === 'removed' ? change.section === section : itemById.value.get(change.id)?.section === section,
    ).length

  async function call(operation: string, data: Record<string, unknown> = {}): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    error.value = ''
    try {
      // 浏览器预览没有桌面后端：任何操作都回到同一份固定样例。
      snapshot.value = real ? await lensRequest(operation, data) : mockLensSnapshot()
      return true
    } catch (cause) {
      error.value = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '透视操作失败。'
      return false
    } finally {
      busy.value = false
    }
  }

  function select(id: string) {
    const item = itemById.value.get(id)
    if (!item) return
    selectedId.value = id
  }
  /** 跳到另一个条目：切到它所在分区并选中。 */
  function jump(id: string) {
    const item: LensItem | undefined = itemById.value.get(id)
    if (!item) return
    view.value = item.section
    selectedId.value = id
  }

  async function open(packageId: string) {
    snapshot.value = null
    selectedId.value = ''
    view.value = 'characters'
    await call('lens-open', { packageId })
  }
  async function close() {
    if (real && snapshot.value) {
      try {
        await lensRequest('lens-close')
      } catch {
        /* 关闭失败时后端会在下次打开时替换旧透视；页面照常关闭。 */
      }
    }
    snapshot.value = null
    error.value = ''
  }
  /** 先交给后端本步的 NPC 行为（空对象清掉上一步没用完的设置），再走这一步。 */
  async function step(next: LensStep, plans: Record<string, readonly LensNpcPlan[]>) {
    if ((await call('lens-npc-plans', { plans })) === false) return false
    return call('lens-step', { step: next })
  }

  return {
    real,
    snapshot,
    view,
    selectedId,
    busy,
    error,
    items,
    itemById,
    changesById,
    hasChildChange,
    requestsOpenCount,
    selected,
    childrenOf,
    inSection,
    removedIn,
    changeCount,
    call,
    select,
    jump,
    open,
    close,
    step,
    reload: () => call('lens-reload'),
    markSeen: () => call('lens-seen'),
    saveCheckpoint: (name: string) => call('lens-checkpoint', { name }),
    setBaseline: (baseline: { kind: 'seen' } | { kind: 'checkpoint'; name: string }) =>
      call('lens-baseline', { baseline }),
    addRequest: (itemId: string, note: string) => call('lens-request-add', { itemId, note }),
    closeRequest: (id: string) => call('lens-request-close', { id }),
    restart: (start: LensStart) => call('lens-restart', { start }),
    runScenario: (name: string) => call('lens-scenario', { name }),
  }
})
