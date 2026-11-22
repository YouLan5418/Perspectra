<script setup lang="ts">
import { computed, ref } from 'vue'
const slots = defineModel<string[]>(),
  props = defineProps<{ candidates: string[] }>()
const entry = ref(''),
  available = computed(() => props.candidates.filter(s => !slots.value?.includes(s)))
function add(value: string) {
  const name = value.trim()
  if (name && !slots.value?.includes(name)) slots.value = [...(slots.value ?? []), name]
  entry.value = ''
}
</script>
<template>
  <fieldset class="slots">
    <legend>装备槽 · 选填</legend>
    <ul v-if="slots?.length">
      <li v-for="slot in slots" :key="slot">
        {{ slot }}
        <button type="button" :aria-label="'移除槽位 ' + slot" @click="slots = slots?.filter(s => s !== slot)">
          移除
        </button>
      </li>
    </ul>
    <label v-if="available.length"
      >添加已有槽位<select aria-label="添加已有槽位" value="" @change="add(($event.target as HTMLSelectElement).value)">
        <option value="">选择槽位</option>
        <option v-for="s in available" :key="s" :value="s">{{ s }}</option>
      </select></label
    >
    <label>新槽位名称<input v-model="entry" @keydown.enter.prevent="add(entry)" /></label
    ><button type="button" :disabled="!entry.trim() || slots?.includes(entry.trim())" @click="add(entry)">
      创建并添加槽位
    </button>
  </fieldset>
</template>
<style scoped>
.slots ul {
  padding: 0;
  list-style: none;
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.slots {
  display: grid;
  gap: 0.5rem;
}
.slots button {
  width: fit-content;
}
</style>
