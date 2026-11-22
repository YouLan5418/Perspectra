<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  configObject,
  type ConfigField,
  type ConfigValue,
  type ConfigObject,
  type ConfigRecords,
  type FormKind,
} from '@perspectra/world-pack/editor-config'
import ConfigFieldEditor from './ConfigFieldEditor.vue'
import { newField, formLabel, formNames } from './config-form.ts'
const props = defineProps<{
  mode: FormKind
  schema: unknown
  config: unknown
  records: ConfigRecords
  initial?: string
}>()
const emit = defineEmits<{ change: [config: ConfigObject] }>()
const fieldLabel = (key: string) => formLabel(props.mode, key)
const spec = computed(() => props.schema as ConfigField),
  root = computed(() => configObject(props.config))
const fields = computed(() => Object.keys(spec.value?.properties ?? {}).filter(k => k !== 'plugin'))
const key = ref(props.initial ?? fields.value[0] ?? '')
watch(
  () => props.initial,
  k => {
    if (k && fields.value.includes(k)) key.value = k
  },
)
const field = computed(() => spec.value.properties?.[key.value]),
  required = computed(() => spec.value.required?.includes(key.value))
function update(v: ConfigValue) {
  emit('change', { ...root.value, [key.value]: v })
}
function unset() {
  const next = { ...root.value }
  delete next[key.value]
  emit('change', next)
}
</script>
<template>
  <section class="mode-fields" :aria-label="formNames[mode] + '字段表单'">
    <label
      >字段分类<select v-model="key" aria-label="字段分类">
        <option v-for="k in fields" :key="k" :value="k">{{ fieldLabel(k) }}</option>
      </select></label
    >
    <template v-if="field"
      ><h3>{{ fieldLabel(key) }} · {{ required ? '必填' : '选填' }}</h3>
      <label v-if="!required"
        ><input
          type="checkbox"
          :checked="Object.hasOwn(root, key)"
          @change="($event.target as HTMLInputElement).checked ? update(newField(field!)) : unset()"
        />设置{{ fieldLabel(key) }}</label
      >
      <ConfigFieldEditor
        v-if="required || Object.hasOwn(root, key)"
        :key="key"
        :schema="field"
        :path="[key]"
        :value="root[key]"
        :config="root"
        :mode="mode"
        :label="fieldLabel(key)"
        :records="records"
        @change="update"
      />
    </template>
  </section>
</template>
<style scoped>
.mode-fields {
  max-width: 48rem;
  display: grid;
  gap: 0.5rem;
}
.mode-fields h3 {
  margin: 0.5rem 0;
}
select {
  margin-left: 0.6rem;
}
</style>
