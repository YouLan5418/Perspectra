<script setup lang="ts">
import { cueTriggers, type cueFlow } from '@perspectra/host/editor/rpg-cues'
defineProps<{ rows: ReturnType<typeof cueFlow>; selected?: number }>()
const emit = defineEmits<{ select: [index: number] }>()
</script>
<template>
  <ol v-if="rows.length" class="cue-flow" aria-label="遭遇演出流程图">
    <li v-for="r in rows" :key="r.index">
      <button type="button" :aria-pressed="selected === r.index" @click="emit('select', r.index)">
        <strong>{{ r.when === 'turn' ? '第 ' + r.round + ' 轮' : cueTriggers[r.when] }}</strong>
        <span>{{ r.actor }}</span
        ><span>{{ [r.skill, r.target].filter(Boolean).join(' → ') }}</span> <small v-if="r.say">“{{ r.say }}”</small
        ><small v-if="r.warning" class="warning">{{ r.warning }}</small>
      </button>
    </li>
  </ol>
  <p v-else>这张地图还没有演出。</p>
</template>
<style scoped>
.cue-flow {
  list-style: none;
  margin: 0;
  padding: 0;
}
.cue-flow li + li::before {
  content: '';
  display: block;
  height: 0.7rem;
  border-left: 2px solid #90aba0;
  margin-left: 1.2rem;
}
.cue-flow button {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.35rem 0.8rem;
  width: 100%;
  text-align: left;
  border: 1px solid #a6bab2;
  border-radius: 0.35rem;
  padding: 0.55rem 0.75rem;
  background: #f8fbfa;
  color: inherit;
}
.cue-flow button[aria-pressed='true'] {
  border-color: #326352;
  box-shadow: inset 3px 0 #326352;
}
.cue-flow small {
  overflow-wrap: anywhere;
}
.warning {
  color: #88451e;
}
</style>
