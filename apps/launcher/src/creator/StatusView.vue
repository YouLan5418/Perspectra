<script setup lang="ts">
import { computed } from 'vue'
import { asRecord, inlineJson } from './format.ts'
import { useCreatorStore } from './store.ts'

const store = useCreatorStore()
const publicEntries = computed(() => Object.entries(asRecord(store.world?.statusTruth?.public)))
const characterEntries = computed(() => Object.entries(asRecord(store.world?.statusTruth?.characters)))
function select(path: string, label: string) {
  store.select({ kind: 'status', id: path, label: `状态 · ${label}` })
}
</script>

<template>
  <div class="cr-scroll">
    <section class="cr-section">
      <h2>公开状态</h2>
      <div class="cr-grid">
        <div
          v-for="[key, value] in publicEntries"
          :key="key"
          class="cr-field-card"
          :class="{ selected: store.selection?.id === `public.${key}` }"
          @click="select(`public.${key}`, key)"
        >
          <small>{{ key }}</small
          ><span class="cr-mono">{{ inlineJson(value, 90) }}</span>
        </div>
      </div>
      <p v-if="!publicEntries.length" class="cr-muted">未安装状态模块时为 null；当前没有可读的公开状态。</p>
    </section>

    <section v-for="[characterId, values] in characterEntries" :key="characterId" class="cr-section">
      <h2>{{ store.label(characterId) }} 的私有状态</h2>
      <div class="cr-grid">
        <div
          v-for="[key, value] in Object.entries(asRecord(values))"
          :key="key"
          class="cr-field-card"
          :class="{ selected: store.selection?.id === `characters.${characterId}.${key}` }"
          @click="select(`characters.${characterId}.${key}`, `${store.label(characterId)} · ${key}`)"
        >
          <small>{{ key }}</small
          ><span class="cr-mono">{{ inlineJson(value, 90) }}</span>
        </div>
      </div>
      <p v-if="!Object.keys(asRecord(values)).length" class="cr-muted">这个角色当前没有私有状态。</p>
    </section>

    <section class="cr-section">
      <h2>读取边界</h2>
      <p class="cr-muted">
        状态值从已提交的 status.updated
        世界事件推导；读取不运行作者脚本。对象和数组按状态键整体记录，需要追踪变化时请查看轨迹页的相关事件。
      </p>
    </section>
  </div>
</template>
