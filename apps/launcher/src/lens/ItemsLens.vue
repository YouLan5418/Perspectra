<script setup lang="ts">
import { computed } from 'vue'
import type { LensItem, LensSection } from '../../../../desktop/lens/view.ts'
import { useLensStore } from './store.ts'
import { showValue } from './format.ts'
import ChangeBadge from './ChangeBadge.vue'

/** 通用分区（谁知道什么、地点、状态、物品、规则、预设）：一行一个条目，按字段原样列出。 */
const props = defineProps<{ section: LensSection }>()
const store = useLensStore()
const rows = computed(() => store.inSection(props.section))
const removed = computed(() => store.removedIn(props.section))
const owner = (item: LensItem) => (item.parentId ? (store.itemById.get(item.parentId)?.title ?? item.parentId) : '')
const summary = (item: LensItem) => item.fields.map(field => `${field.label}：${showValue(field.value)}`).join('　')
</script>

<template>
  <section class="cr-center">
    <div class="cr-scroll">
      <div class="lens-head"><span>条目</span><span>归属</span><span>内容</span></div>
      <button
        v-for="item in rows"
        :key="item.id"
        class="lens-item"
        :class="{ selected: store.selectedId === item.id }"
        :title="summary(item)"
        @click="store.select(item.id)"
      >
        <span class="lens-title">
          <span class="lens-ellipsis">{{ item.title }}</span>
          <ChangeBadge :change="store.changesById.get(item.id)" :child="store.hasChildChange(item.id)" />
        </span>
        <span class="lens-ellipsis cr-muted">{{ owner(item) }}</span>
        <span class="lens-ellipsis cr-muted">{{ summary(item) }}</span>
      </button>
      <div v-for="change in removed" :key="change.id" class="lens-item removed">
        <span class="lens-title">
          <span class="lens-ellipsis">{{ change.title }}</span
          ><ChangeBadge :change="change" />
        </span>
        <span></span>
        <span class="lens-ellipsis cr-muted">对比基准之后被删除</span>
      </div>
      <p v-if="!rows.length && !removed.length" class="cr-empty">这一类没有设置。</p>
    </div>
  </section>
</template>

<style scoped>
.lens-head,
.lens-item {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.6fr) minmax(0, 2fr);
  gap: 10px;
  align-items: center;
  padding: 0 10px;
  font-size: 13px;
}
.lens-head {
  height: 28px;
  color: var(--cr-faint);
  font-size: 11.5px;
  border-bottom: 1px solid var(--cr-line);
  position: sticky;
  top: 0;
  background: var(--cr-panel);
  z-index: 1;
}
.lens-item {
  width: 100%;
  min-height: var(--cr-row);
  border: 0;
  border-bottom: 1px solid var(--cr-line);
  border-left: 2px solid transparent;
  background: none;
  color: var(--cr-text);
  text-align: left;
}
.lens-item:hover {
  background: var(--cr-panel-2);
}
.lens-item.selected {
  background: var(--cr-blue-soft);
  border-left-color: var(--cr-blue);
}
.lens-item.removed {
  opacity: 0.6;
}
.lens-item.removed .lens-title > .lens-ellipsis {
  text-decoration: line-through;
}
.lens-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.lens-ellipsis {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 760px) {
  .lens-head,
  .lens-item {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .lens-head > :nth-child(2),
  .lens-item > :nth-child(2) {
    display: none;
  }
}
</style>
