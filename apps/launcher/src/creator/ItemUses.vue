<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { editorRequest } from './editor-api.ts'
import type { ItemUse, itemUses } from '../../../host/src/editor/item-uses.ts'
type Report = ReturnType<typeof itemUses>
const props = defineProps<{ id: string }>(),
  emit = defineEmits<{ open: [use: ItemUse] }>()
const report = ref<Report>(),
  error = ref(''),
  busy = ref(false)
const labels = { take: '可拿起', drop: '可放下', give: '可交给他人' }
async function read() {
  report.value = await editorRequest<Report>('item-uses', { id: props.id })
}
async function update(key: keyof typeof labels, checked: boolean) {
  if (!report.value || busy.value) return
  busy.value = true
  error.value = ''
  const base = report.value.actions.allowed
  try {
    report.value.actions = await editorRequest('item-actions-save', {
      id: props.id,
      base,
      allowed: { ...base, [key]: checked },
    })
  } catch (e) {
    error.value = (e as Error).message
    try {
      await read()
    } catch {
      report.value = undefined
    }
  } finally {
    busy.value = false
  }
}
onMounted(() =>
  read().catch(e => {
    error.value = e.message
  }),
)
</script>
<template>
  <section class="item-uses">
    <h3>物品用途</h3>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="report"
      ><ul>
        <li v-for="r in report.uses" :key="[r.section, r.id, r.choice, r.field].join('/')">
          <button @click="emit('open', r)">{{ r.label }}</button>
        </li>
      </ul>
      <fieldset v-if="report.actions.mode === 'template' || report.actions.mode === 'new'" :disabled="busy">
        <legend>物品操作 · 选填</legend>
        <label v-for="(label, key) in labels" :key="key"
          ><input
            type="checkbox"
            :checked="report.actions.allowed[key]"
            @change="update(key, ($event.target as HTMLInputElement).checked)"
          />{{ label }}</label
        >
      </fieldset>
      <p v-else-if="report.actions.mode === 'inactive'">包内状态脚本未启用，请检查包声明。</p>
      <p v-else>自定义状态脚本 · 请在源文件中编辑操作。</p>
      <p v-if="report.actions.operations.length">
        脚本登记的物品操作 · {{ report.actions.operations.map(o => o.label).join('、') }}
      </p>
      <details v-if="report.actions.source">
        <summary>查看 {{ report.actions.file }}</summary>
        <pre>{{ report.actions.source }}</pre>
      </details>
    </template>
  </section>
</template>
<style scoped>
.item-uses ul {
  padding-left: 1.2rem;
}
.item-uses li {
  margin: 0.3rem 0;
}
.item-uses fieldset label {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-right: 0.8rem;
}
.item-uses input[type='checkbox'] {
  width: auto;
}
.item-uses pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 22rem;
  overflow: auto;
}
</style>
