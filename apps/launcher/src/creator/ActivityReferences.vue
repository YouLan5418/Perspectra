<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ActivityReference } from '@perspectra/host/editor/activity-references'
const props = defineProps<{ rows: ActivityReference[]; activity: string }>()
const emit = defineEmits<{ source: [r: ActivityReference]; target: [r: ActivityReference] }>()
const query = ref(''),
  all = ref(false),
  target = ref<ActivityReference>()
const filtered = computed(() =>
  props.rows.filter(r => {
    const t = target.value
    if (t && (r.kind !== t.kind || r.scope !== t.scope || r.id !== t.id)) return false
    if (!t && !all.value && r.activity !== props.activity) return false
    return [r.source, r.fieldLabel, r.target, r.id, r.activity, r.choice]
      .join(' ')
      .toLowerCase()
      .includes(query.value.trim().toLowerCase())
  }),
)
function findUses(r: ActivityReference) {
  target.value = r
  query.value = ''
}
</script>
<template>
  <label>查找引用<input v-model="query" type="search" placeholder="对象名称、活动、字段或 ID" /></label>
  <div v-if="target">
    <b>{{ target.target }} · 使用位置</b> <button @click="target = undefined">清除筛选</button>
  </div>
  <label v-else><input v-model="all" type="checkbox" /> 包内全部低代码活动</label>
  <p v-if="!filtered.length">没有匹配的引用。</p>
  <div
    v-for="r in filtered"
    :key="[r.activity, r.choice, r.field].join('/')"
    class="row"
    :class="{ invalid: !r.valid }"
  >
    <button class="source" @click="emit('source', r)">{{ r.source }} › {{ r.fieldLabel }}</button>
    <b>{{ r.target }} <small v-if="!r.valid">· 引用失效</small></b
    ><small>{{ r.id }}</small>
    <div>
      <button :disabled="!r.valid" @click="emit('target', r)">打开定义</button>
      <button @click="findUses(r)">所有使用位置</button>
    </div>
  </div>
</template>
<style scoped>
.row {
  border-top: 1px solid #ddd;
  padding: 12px 0;
  display: grid;
  gap: 4px;
}
.invalid {
  border-left: 3px solid #ad2929;
  padding-left: 8px;
  color: #a22222;
}
button,
input {
  font: inherit;
}
input[type='search'] {
  display: block;
  width: 100%;
  padding: 8px;
  box-sizing: border-box;
}
button {
  cursor: pointer;
  background: white;
  border: 1px solid #ccc;
  border-radius: 3px;
  padding: 4px 7px;
}
.source {
  text-align: left;
  text-decoration: underline;
  border: 0;
  padding: 0;
}
label {
  display: block;
  margin: 9px 0;
}
small {
  overflow-wrap: anywhere;
}
</style>
