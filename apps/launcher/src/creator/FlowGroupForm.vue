<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EditorGraph, LayoutNode } from '../../../host/src/editor/activity-graph.ts'
const props = defineProps<{ graph: EditorGraph; parent: string; id: string }>()
const emit = defineEmits<{ apply: [layout: LayoutNode[]]; dissolve: [layout: LayoutNode[]] }>()
const original = props.graph.layout?.find(n => n.id === props.id)
const title = ref(original?.title ?? '')
const selected = ref((props.graph.layout ?? []).filter(n => !!props.id && n.parent === props.id).map(n => n.id))
const members = computed(() => {
  const layout = props.graph.layout ?? []
  return [
    ...props.graph.choices.map(c => ({ id: c.id, title: c.label })),
    ...layout.filter(n => n.title).map(n => ({ id: n.id, title: n.title! })),
  ].filter(n => {
    const parent = layout.find(r => r.id === n.id)?.parent ?? ''
    return n.id !== props.id && (parent === props.parent || (!!props.id && parent === props.id))
  })
})
function reparent(n: LayoutNode, parent: string): LayoutNode {
  return { id: n.id, ...(n.title ? { title: n.title } : {}), ...(parent ? { parent } : {}) }
}
function apply(dissolve = false) {
  const map = new Map((props.graph.layout ?? []).map(n => [n.id, { ...n }]))
  const id = props.id || 'group-' + crypto.randomUUID().slice(0, 12)
  if (dissolve) map.delete(id)
  else map.set(id, { ...map.get(id), id, title: title.value.trim(), ...(props.parent ? { parent: props.parent } : {}) })
  for (const member of members.value) {
    const n = map.get(member.id) ?? { id: member.id }
    const parent = !dissolve && selected.value.includes(member.id) ? id : props.parent
    if (parent !== (n.parent ?? '')) map.set(n.id, reparent(n, parent))
  }
  if (dissolve) emit('dissolve', [...map.values()])
  else emit('apply', [...map.values()])
}
</script>
<template>
  <form @submit.prevent="apply()">
    <label>子流程名称<input v-model="title" required maxlength="80" /></label>
    <fieldset>
      <legend>包含的节点</legend>
      <label v-for="m in members" :key="m.id"
        ><input v-model="selected" type="checkbox" :value="m.id" /> {{ m.title }}</label
      >
    </fieldset>
    <button :disabled="!title.trim()">保存子流程</button>
    <button v-if="id" type="button" @click="apply(true)">解散到上层</button>
  </form>
</template>
<style scoped>
form {
  display: grid;
  gap: 15px;
}
label {
  display: block;
  margin: 6px 0;
}
input:not([type='checkbox']) {
  display: block;
  width: 100%;
  box-sizing: border-box;
}
button,
input {
  font: inherit;
  padding: 6px 8px;
}
fieldset {
  border: 1px solid #ccc;
}
button {
  cursor: pointer;
  background: #fff;
  border: 1px solid #999;
  border-radius: 3px;
}
</style>
