<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Plus, Pencil } from '@lucide/vue'
import type { WorldRecord } from '@perspectra/world-pack/editor-fields'
import { editorRequest } from './editor-api.ts'
const props = defineProps<{ locationId: string; records: WorldRecord[]; refresh: () => Promise<void> }>()
const emit = defineEmits<{ open: [id: string] }>()
const items = computed(() => props.records.filter(r => r.kind === 'item' && r.values.locationId === props.locationId))
const kinds = computed(() => [...new Set(props.records.filter(r => r.kind === 'item').map(r => String(r.values.kind)))])
const draft = ref<{ item: WorldRecord | null; name: string; kind: string }>()
const nameInput = ref<HTMLInputElement>(),
  busy = ref(false),
  error = ref('')
const dirty = computed(
  () =>
    draft.value &&
    (draft.value.name !== (draft.value.item?.values.name ?? '') ||
      draft.value.kind !== (draft.value.item?.values.kind ?? '')),
)
async function save() {
  const edit = draft.value
  if (!edit || !dirty.value) return
  if (!edit.kind.trim()) throw new Error('请填写物品种类。')
  try {
    await editorRequest('record-save', {
      kind: 'item',
      id: edit.item?.id,
      base: edit.item?.values ?? null,
      values: { name: edit.name, kind: edit.kind, ...(!edit.item ? { locationId: props.locationId } : {}) },
    })
  } catch (e) {
    if ((e as { status?: number }).status !== 409) throw e
    await props.refresh()
    draft.value = undefined
    throw new Error('物品已被其他编辑更新，已载入最新记录。')
  }
  draft.value = undefined
  await props.refresh()
}
async function run(work: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await work()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
function edit(item: WorldRecord | null) {
  void run(async () => {
    await save()
    const latest = item ? items.value.find(r => r.id === item.id) : null
    if (item && !latest) throw new Error('此物品已移出当前地点。')
    draft.value = {
      item: latest ?? null,
      name: String(latest?.values.name ?? ''),
      kind: String(latest?.values.kind ?? ''),
    }
    await nextTick()
    nameInput.value?.focus()
  })
}
function cancel() {
  draft.value = undefined
  error.value = ''
}
defineExpose({
  async flush() {
    if (busy.value) throw new Error('请等物品保存完成')
    await save()
  },
})
</script>
<template>
  <section class="placed" aria-label="此地物品" :inert="busy">
    <header>
      <h3>
        此地物品 <small>{{ items.length }}</small>
      </h3>
      <button type="button" @click="edit(null)"><Plus :size="14" aria-hidden="true" />新建物品</button>
    </header>
    <p v-if="!items.length && !draft">此地点还没有放置物品。</p>
    <div v-for="item in items" :key="item.id" class="item-row">
      <button class="link" type="button" @click="emit('open', item.id)">{{ item.name }}</button
      ><small>{{ item.values.kind }}</small>
      <button type="button" :aria-label="'编辑' + item.name" @click="edit(item)">
        <Pencil :size="14" aria-hidden="true" />
      </button>
    </div>
    <form v-if="draft" @submit.prevent="run(save)">
      <label>物品名 <small>选填</small><input ref="nameInput" v-model="draft.name" /></label>
      <label>物品种类 <small>必填</small><input required v-model="draft.kind" list="placed-item-kinds" /></label>
      <datalist id="placed-item-kinds"><option v-for="k in kinds" :key="k" :value="k" /></datalist>
      <div>
        <button :disabled="!dirty">保存物品</button>
        <button type="button" @click="cancel">取消</button>
      </div>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.placed header,
.item-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.placed header {
  justify-content: space-between;
  margin-bottom: 10px;
}
h3 {
  margin: 0;
  font-size: 16px;
}
small {
  color: #666;
  font-size: 12px;
}
button {
  font: inherit;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  padding: 5px 9px;
  background: white;
  border: 1px solid #ccc;
  border-radius: 3px;
}
.item-row {
  padding: 7px 0;
  border-top: 1px solid #ddd;
}
.item-row small {
  margin-left: auto;
  overflow-wrap: anywhere;
}
.item-row .link {
  flex-shrink: 0;
  max-width: 55%;
  overflow-wrap: anywhere;
}
.link {
  border: 0;
  padding-left: 0;
  text-align: left;
  text-decoration: underline;
  text-underline-offset: 3px;
}
form {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}
label input {
  display: block;
  margin-top: 4px;
  width: 100%;
  box-sizing: border-box;
  padding: 7px;
  border: 1px solid #aaa;
  border-radius: 3px;
}
[role='alert'] {
  color: #9b2020;
}
</style>
