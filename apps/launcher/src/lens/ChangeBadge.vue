<script setup lang="ts">
import type { LensChange } from '../../../../desktop/lens/diff.ts'

/** 与对比基准相比的改动标记；`child` 表示条目本身没变、但它下面有条目变了。 */
defineProps<{ change?: LensChange | undefined; child?: boolean }>()
const LABEL = { added: '新增', changed: '修改', removed: '删除' } as const
const TONE = { added: 'ok', changed: 'warn', removed: 'danger' } as const
</script>

<template>
  <span v-if="change" class="cr-tag lens-badge" :class="TONE[change.kind]">{{ LABEL[change.kind] }}</span>
  <span v-else-if="child" class="cr-tag line lens-badge">含变化</span>
</template>

<style scoped>
.lens-badge.ok {
  background: var(--cr-context-soft);
  padding: 0 6px;
}
</style>
