<script setup lang="ts">
import { computed, ref } from 'vue'
import { asRecord, inlineJson } from './format.ts'
import { useCreatorStore } from './store.ts'

const store = useCreatorStore()
const publicEntries = computed(() => Object.entries(asRecord(store.world?.statusTruth?.public)))
const characterEntries = computed(() => Object.entries(asRecord(store.world?.statusTruth?.characters)))
const catalog = computed(() => store.world?.statusOperations)
const search = ref('')
const roles = { player: '玩家', npc: 'NPC', any: '玩家与 NPC' }
const filtered = computed(() => {
  const query = search.value.trim().toLowerCase()
  return catalog.value?.operations.filter(op => (op.id + ' ' + op.label).toLowerCase().includes(query)) ?? []
})
function select(path: string, label: string) {
  store.select({ kind: 'status', id: path, label: `状态 · ${label}` })
}
</script>

<template>
  <div class="cr-scroll">
    <section v-if="catalog" class="cr-section">
      <h2>状态操作 · {{ catalog.operations.length }} / {{ catalog.limit }}</h2>
      <p>玩家最近一次候选中有 {{ catalog.operations.filter(op => op.offeredToPlayer).length }} 个不同的状态操作。</p>
      <p v-for="(error, actor) in catalog.policyErrors" :key="actor" class="cr-banner danger">
        {{ store.label(actor) }} 的操作许可检查失败：{{ error }}
      </p>
      <details v-if="catalog.operations.length">
        <summary>查看已声明的操作</summary>
        <input
          v-model="search"
          type="search"
          class="cr-input"
          aria-label="搜索状态操作"
          placeholder="搜索名称或操作 ID"
        />
        <table class="cr-operations">
          <thead>
            <tr>
              <th>操作</th>
              <th>适用角色</th>
              <th>玩家候选</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="op in filtered" :key="op.id">
              <td>
                {{ op.label }}<small class="cr-mono">{{ op.id }}</small>
              </td>
              <td>{{ roles[op.actors] }}</td>
              <td>{{ op.offeredToPlayer ? '已列出' : '未列出' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!filtered.length" class="cr-muted">没有匹配的操作。</p>
      </details>
    </section>
    <p v-else-if="store.world" class="cr-muted">当前实例没有提供状态操作目录。</p>
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

<style scoped>
summary {
  cursor: pointer;
}
.cr-input {
  margin: 8px 0;
}
.cr-operations {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}
.cr-operations th,
.cr-operations td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--cr-line);
}
.cr-operations small {
  display: block;
  color: var(--cr-dim);
  overflow-wrap: anywhere;
}
</style>
