<script setup lang="ts">
import { computed } from 'vue'
import { timeLabel } from './format.ts'
import { useCreatorStore } from './store.ts'

const store = useCreatorStore()
const capture = computed(() => store.captureEnabled ? ['采集已开启', 'ok'] as const : ['采集未开启', 'warn'] as const)
const storage = computed(() => store.world ? null : '未连接实例')
</script>

<template>
  <footer class="cr-status">
    <span :class="capture[1]"><b>采集</b> {{ capture[0] }}</span>
    <span v-if="store.world?.character">当前详情角色 <b>{{ store.label(store.world.character.id) }}</b></span>
    <span><b>最近更新</b> {{ timeLabel(store.updatedAt) || '—' }}</span>
    <span><b>事件</b> {{ store.history.length }} 条{{ store.truncated ? `（自序号 ${store.historyFloor + 1} 起）` : '' }}</span>
    <span><b>记录</b> {{ store.records.length }}/{{ store.recordTotal }} 条</span>
    <span v-if="store.loading" class="cr-loading">正在轮询…</span>
    <span v-if="store.failureCount > 0" class="danger"><b>失败或被拒绝</b> {{ store.failureCount }} 条</span>
    <span v-if="store.hiddenProcessCount > 0" class="warn"><b>处理过程已收起</b> {{ store.hiddenProcessCount }} 条</span>
    <span v-if="store.error" class="danger">{{ store.error }}</span>
    <span class="cr-spacer" />
    <span v-if="store.added > 0" class="warn">新增 {{ store.added }} 条</span>
    <span v-if="storage">{{ storage }}</span>
    <span v-else-if="store.limitations.length" :title="store.limitations.join('\n')">限制 {{ store.limitations.length }} 条</span>
  </footer>
</template>
