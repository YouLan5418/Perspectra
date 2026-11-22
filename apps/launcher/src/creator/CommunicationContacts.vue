<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  configCandidates,
  configObject,
  type ConfigObject,
  type ConfigRecords,
} from '@perspectra/world-pack/editor-config'
const props = defineProps<{
  config: ConfigObject
  records: ConfigRecords
  initial?: string | undefined
  scopedActor?: boolean
}>()
const emit = defineEmits<{ change: [config: ConfigObject] }>()
const actor = ref(props.initial || props.records.player || props.records.characters[0]?.id || '')
const people = computed(
  () => configCandidates('communication', props.config, props.records, ['contacts', actor.value]) ?? [],
)
const links = computed(() => configObject(props.config.contacts))
function contacts(sender: string) {
  const list = links.value[sender]
  return Array.isArray(list) ? list : []
}
function set(sender: string, recipient: string, enabled: boolean) {
  const list = contacts(sender)
  const next = enabled ? [...new Set([...list, recipient])] : list.filter(id => id !== recipient)
  emit('change', { ...props.config, contacts: { ...links.value, [sender]: next } })
}
</script>
<template>
  <div class="contacts">
    <label v-if="!scopedActor"
      >通信媒介 · 必填<input
        aria-label="通信媒介"
        maxlength="40"
        :value="config.medium"
        @input="emit('change', { ...config, medium: ($event.target as HTMLInputElement).value })"
    /></label>
    <label v-if="!scopedActor"
      >查看谁的通讯录<select aria-label="通讯录角色" v-model="actor">
        <option v-for="person in records.characters" :key="person.id" :value="person.id">
          {{ person.name }} · {{ person.id }}
        </option>
      </select></label
    >
    <table>
      <caption>
        联系人 · 选填
      </caption>
      <thead>
        <tr>
          <th>角色</th>
          <th>可发给对方</th>
          <th>可收到对方来信</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="other in people" :key="other.id">
          <th scope="row">
            {{ other.name }}<small>{{ other.id }}</small>
          </th>
          <td>
            <input
              type="checkbox"
              :aria-label="'可发给' + other.name + ' · ' + other.id"
              :checked="contacts(actor).includes(other.id)"
              @change="set(actor, other.id, ($event.target as HTMLInputElement).checked)"
            />
          </td>
          <td>
            <input
              type="checkbox"
              :aria-label="'可收到' + other.name + '的来信 · ' + other.id"
              :checked="contacts(other.id).includes(actor)"
              @change="set(other.id, actor, ($event.target as HTMLInputElement).checked)"
            />
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="!people.length">添加其他角色后即可选择联系人。</p>
  </div>
</template>
<style scoped>
.contacts {
  display: grid;
  gap: 0.8rem;
  max-width: 48rem;
}
label {
  display: grid;
  gap: 0.2rem;
}
input:not([type='checkbox']),
select {
  max-width: 24rem;
  padding: 0.4rem;
}
table {
  border-collapse: collapse;
  width: 100%;
}
caption {
  text-align: left;
  font-weight: 600;
  margin-bottom: 0.4rem;
}
th,
td {
  padding: 0.45rem;
  border-bottom: 1px solid #ddd;
}
th:first-child {
  text-align: left;
}
td {
  text-align: center;
}
small {
  display: block;
  overflow-wrap: anywhere;
  color: #646464;
  font-weight: 400;
}
</style>
