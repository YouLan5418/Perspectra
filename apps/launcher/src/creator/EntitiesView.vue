<script setup lang="ts">
import { computed } from 'vue'
import { asRecord, inlineJson, readable } from './format.ts'
import { useCreatorStore } from './store.ts'
import type { CreatorHistoryItem } from '../../../../tests/experiments/creator-history.ts'

const store = useCreatorStore()
interface Change { seq: number; eventType: string; before: string; after: string; followsHolder: boolean }
/** 物品流转使用纵向时间线：先看当前保管，再看最近的保管／地点变化。 */
const changes = computed(() => {
  const table: Record<string, Change[]> = {}
  const seen = new Set<string>()
  const push = (entityId: string, item: CreatorHistoryItem) => {
    if (!entityId || !item.entityChange || seen.has(`${entityId}:${item.event.seq}`)) return
    seen.add(`${entityId}:${item.event.seq}`)
    const list = table[entityId] ?? []
    list.push({
      seq: item.event.seq, eventType: item.event.eventType,
      before: store.label(asRecord(item.entityChange.before).holderId as string) || '无人保管',
      after: store.label(asRecord(item.entityChange.after).holderId as string) || '无人保管',
      followsHolder: item.entityChange.followsHolder,
    })
    table[entityId] = list
  }
  // 随携带者移动的事件本身没有 entityId，由实体查询结果归到被查询的物品。
  const attribute = (item: CreatorHistoryItem) => {
    const data = asRecord(item.event.data)
    return String(data.entityId ?? data.id ?? asRecord(item.entityChange?.after).entityId ?? asRecord(item.entityChange?.before).entityId ?? '')
  }
  for (const item of store.history) push(attribute(item), item)
  for (const [entityId, items] of Object.entries(store.entityHistory)) for (const item of items) push(entityId, item)
  for (const list of Object.values(table)) list.sort((a, b) => a.seq - b.seq)
  return table
})
</script>

<template>
  <div class="cr-scroll">
    <div class="cr-list-head" style="grid-template-columns: minmax(120px, 1fr) minmax(0, 1fr) minmax(0, 1.2fr) 110px">
      <span>物品</span><span>保管者</span><span>有效地点</span><span>最近变更</span>
    </div>
    <div v-for="entity in store.entities" :key="entity.id" class="cr-list-row" style="grid-template-columns: minmax(120px, 1fr) minmax(0, 1fr) minmax(0, 1.2fr) 110px"
      :class="{ selected: store.selection?.id === entity.id }" @click="store.selectEntity(entity.id, entity.name)">
      <span class="cr-strong">{{ entity.name }}</span>
      <span class="cr-muted">{{ store.label(asRecord(entity.state).holderId as string) || '无人保管' }}</span>
      <span class="cr-muted">{{ store.label(entity.effectiveLocationId, 'locations') || '未知' }} · {{ entity.locationBasis === 'holder' ? '随保管者' : entity.locationBasis === 'entity' ? '物品自身' : '未知' }}</span>
      <span class="cr-muted">#{{ entity.lastChangeSeq }}</span>
    </div>
    <p v-if="!store.entities.length" class="cr-muted" style="padding: 12px">没有事件日志重建出的受追踪物品。</p>

    <section v-for="entity in store.entities" :key="entity.id" class="cr-section">
      <h2>{{ entity.name }} · 流转时间线</h2>
      <div class="cr-timeline">
        <div v-for="change in (changes[entity.id] ?? []).slice().reverse()" :key="change.seq" class="cr-timeline-item" :class="change.followsHolder ? 'warn' : 'ok'">
          <div class="cr-tl-main">{{ change.before }} → {{ change.after }}</div>
          <div class="cr-tl-sub">{{ change.eventType }} · #{{ change.seq }}<span v-if="change.followsHolder"> · 随保管者移动，不是独立转移</span></div>
          <button class="cr-button tiny" @click="store.focus(`e${change.seq}`); store.view = 'trace'">在轨迹中查看</button>
        </div>
        <p v-if="!(changes[entity.id] ?? []).length" class="cr-muted">当前已载入的历史里没有结构化流转记录；打开物品详情或在轨迹页按物品筛选可读取完整历史。</p>
      </div>
      <div class="cr-kv" style="margin-top: 8px">
        <dt>当前状态</dt><dd class="cr-mono">{{ inlineJson(entity.state, 200) }}</dd>
        <dt>保管含义</dt><dd>{{ entity.holderMeaning === 'custody' ? '保管或携带，未单独追踪法律所有权' : entity.holderMeaning }}</dd>
        <dt>物品观察</dt><dd>{{ readable(asRecord(entity.state).name) || entity.name }} 只按结构化实体目标建立关联。</dd>
      </div>
    </section>
  </div>
</template>
