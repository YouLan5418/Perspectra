<script setup lang="ts">
import { inject } from 'vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog/index.ts'
defineProps<{ open: boolean; title: string; description: string; wide?: boolean }>()
defineEmits<{ close: [] }>()
/** 放进本局抽屉或设置窗口时只渲染标题与内容，不再弹出叠加的对话框。 */
const embedded = inject('launcher-embedded', false)
</script>
<template>
  <section v-if="embedded && open" class="drawer-panel" :aria-label="title">
    <header class="drawer-panel-head">
      <h2>{{ title }}</h2>
      <p>{{ description }}</p>
    </header>
    <slot />
  </section>
  <Dialog v-else-if="!embedded" :open="open" @update:open="!$event && $emit('close')"
    ><DialogContent :class="['launcher-dialog', { 'launcher-dialog-wide': wide }]"
      ><DialogHeader
        ><DialogTitle>{{ title }}</DialogTitle
        ><DialogDescription>{{ description }}</DialogDescription></DialogHeader
      ><slot /></DialogContent
  ></Dialog>
</template>
