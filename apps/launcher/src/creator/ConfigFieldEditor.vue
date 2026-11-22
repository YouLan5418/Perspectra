<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  configObject,
  configAt,
  configCandidates,
  type ConfigField,
  type ConfigValue,
  type ConfigObject,
  type ConfigRecords,
  type FormKind,
} from '@perspectra/world-pack/editor-config'
import { formLabel, branchLabel, branchOf, newField, freeSchema, freeTypes } from './config-form.ts'
const props = defineProps<{
  schema: ConfigField
  value: ConfigValue | undefined
  label: string
  path: string[]
  mode: FormKind
  config: ConfigObject
  records: ConfigRecords
}>()
const emit = defineEmits<{ change: [value: ConfigValue] }>()
const fieldLabel = (key: string) => formLabel(props.mode, key)
const free = computed(() => Object.keys(props.schema).length === 0)
const variant = computed(() => branchOf(props.schema, props.value)),
  field = computed(() => (free.value ? freeSchema(props.value) : (props.schema.oneOf?.[variant.value] ?? props.schema)))
const object = computed(() => configObject(props.value)),
  array = computed(() => (Array.isArray(props.value) ? props.value : []))
const options = computed(() => configCandidates(props.mode, props.config, props.records, props.path)),
  keys = computed(() => configCandidates(props.mode, props.config, props.records, props.path, true))
const available = computed(() => keys.value?.filter(r => !Object.hasOwn(object.value, r.id)))
const row = ref(0),
  dictKey = ref(''),
  newKey = ref('')
const dict = computed(() => Object.keys(object.value).filter(k => !Object.hasOwn(field.value.properties ?? {}, k)))
const selectedKey = computed(() => (dict.value.includes(dictKey.value) ? dictKey.value : (dict.value[0] ?? '')))
const index = computed(() => Math.min(row.value, Math.max(0, array.value.length - 1)))
watch(
  () => JSON.stringify(props.path),
  () => {
    row.value = 0
    dictKey.value = ''
    newKey.value = ''
  },
)
function objectField(k: string, v: ConfigValue) {
  if (props.mode === 'stage' && props.path[2] === 'expressions' && k === 'sheet' && v !== object.value.sheet) {
    const sheet = configObject(configAt(props.config, ['characters', props.path[1]!, 'sheets', String(v)]))
    const count = Number(sheet.columns ?? 4) * Number(sheet.rows ?? 4)
    const cell = Number(object.value.cell)
    emit('change', { ...object.value, sheet: v, cell: Number.isInteger(cell) && cell >= 0 && cell < count ? cell : 0 })
    return
  }
  if (
    ((props.mode === 'autonomy' && k === 'activityKey') ||
      (props.mode === 'stage' && props.path[0] === 'autoplay' && k === 'activity')) &&
    v !== object.value[k]
  ) {
    const options = props.records.activityMenus?.find(a => a.id === v)?.operations ?? []
    const operation =
      options.find(o => o.id === object.value.operation)?.id ?? (options.length === 1 ? options[0]!.id : '')
    emit('change', { ...object.value, [k]: v, operation })
    return
  }
  emit('change', { ...object.value, [k]: v })
}
function remove(k: string) {
  const out = { ...object.value }
  delete out[k]
  emit('change', out)
}
function addKey() {
  const k = newKey.value.trim(),
    schema = field.value.additionalProperties
  if (
    !k ||
    !schema ||
    typeof schema !== 'object' ||
    ['__proto__', 'prototype', 'constructor'].includes(k) ||
    Object.hasOwn(object.value, k) ||
    (available.value && !available.value.some(r => r.id === k))
  )
    return
  objectField(k, newField(schema))
  dictKey.value = k
  newKey.value = ''
}
function addRow() {
  if (!field.value.items) return
  row.value = array.value.length
  emit('change', [...array.value, newField(field.value.items)])
}
function replaceRow(i: number, v: ConfigValue) {
  const out = [...array.value]
  out[i] = v
  emit('change', out)
}
function moveRow(offset: -1 | 1) {
  const i = index.value,
    next = i + offset,
    rows = [...array.value]
  if (next < 0 || next >= rows.length) return
  rows.splice(next, 0, rows.splice(i, 1)[0]!)
  row.value = next
  emit('change', rows)
}
function removeRow() {
  const i = index.value
  emit(
    'change',
    array.value.filter((_, j) => j !== i),
  )
  row.value = Math.max(0, i - 1)
}
function arrayLabel(value: ConfigValue, i: number) {
  const o = configObject(value)
  const actor =
    typeof o.characterId === 'string' ? props.records.characters.find(c => c.id === o.characterId)?.name : undefined
  const v = o.label ?? o.name ?? o.title ?? actor ?? o.operation ?? o.actionType ?? o.id ?? o.key ?? o.factId ?? o.kind
  return (
    i +
    1 +
    ' · ' +
    (v !== undefined ? fieldLabel(String(v)) : typeof value === 'object' ? '记录' : String(value) || '新记录')
  )
}
const inputs = computed(() => ({ mode: props.mode, records: props.records, config: props.config }))
</script>
<template>
  <div class="config-field">
    <label v-if="free"
      >{{ label }}格式<select
        :aria-label="label + '格式'"
        :value="field.type"
        @change="emit('change', newField({ type: ($event.target as HTMLSelectElement).value }))"
      >
        <option v-for="(name, type) in freeTypes" :value="type" :key="type">{{ name }}</option>
      </select></label
    >
    <label v-if="schema.oneOf"
      >{{ label }}类型<select
        :aria-label="label + '类型'"
        :value="variant"
        @change="emit('change', newField(schema.oneOf![Number(($event.target as HTMLSelectElement).value)]!))"
      >
        <option v-for="(b, i) in schema.oneOf" :key="i" :value="i">{{ branchLabel(b, i) }}</option>
      </select></label
    >
    <template v-if="field.type === 'object'">
      <template v-for="(child, k) in field.properties" :key="k">
        <div v-if="!field.required?.includes(String(k))" class="optional">
          <label
            ><input
              type="checkbox"
              :checked="Object.hasOwn(object, k)"
              @change="
                ($event.target as HTMLInputElement).checked
                  ? objectField(String(k), newField(child))
                  : remove(String(k))
              "
            />设置{{ fieldLabel(String(k)) }} · 选填</label
          >
        </div>
        <fieldset v-if="Object.hasOwn(object, k) || field.required?.includes(String(k))">
          <legend>{{ fieldLabel(String(k)) }}{{ field.required?.includes(String(k)) ? ' · 必填' : '' }}</legend>
          <ConfigFieldEditor
            v-bind="inputs"
            :schema="child"
            :value="object[k]"
            :label="fieldLabel(String(k))"
            :path="[...path, String(k)]"
            @change="v => objectField(String(k), v)"
          />
        </fieldset>
      </template>
      <template v-if="field.additionalProperties && typeof field.additionalProperties === 'object'">
        <label v-if="dict.length"
          >{{ label }}记录<select
            :aria-label="label + '记录'"
            :value="selectedKey"
            @change="dictKey = ($event.target as HTMLSelectElement).value"
          >
            <option v-for="k in dict" :key="k" :value="k">
              {{
                keys?.find(r => r.id === k)?.name ?? configObject(object[k]).label ?? configObject(object[k]).name ?? k
              }}
              · {{ k }}
            </option>
          </select></label
        >
        <div class="actions">
          <label
            >新增{{ label
            }}<select v-if="available" v-model="newKey" :aria-label="'新增' + label">
              <option value="">选择已有记录</option>
              <option v-for="r in available" :key="r.id" :value="r.id">{{ r.name }} · {{ r.id }}</option></select
            ><input v-else v-model="newKey" :aria-label="'新增' + label" placeholder="新记录的键" /></label
          ><button
            type="button"
            :disabled="
              !newKey.trim() || Object.hasOwn(object, newKey.trim()) || dict.length >= (field.maxProperties ?? Infinity)
            "
            @click="addKey"
          >
            添加{{ label }}记录
          </button>
        </div>
        <template v-if="selectedKey"
          ><ConfigFieldEditor
            v-bind="inputs"
            :key="selectedKey"
            :schema="field.additionalProperties"
            :value="object[selectedKey]"
            :label="keys?.find(r => r.id === selectedKey)?.name ?? selectedKey"
            :path="[...path, selectedKey]"
            @change="v => objectField(selectedKey, v)"
          /><button type="button" :disabled="dict.length <= (field.minProperties ?? 0)" @click="remove(selectedKey)">
            移除当前{{ label }}记录
          </button></template
        >
      </template>
      <small v-if="field.anyOf"
        >至少填写一项：{{
          field.anyOf
            .flatMap(s => s.required ?? [])
            .map(fieldLabel)
            .join('、')
        }}</small
      >
    </template>
    <div v-else-if="field.prefixItems" class="actions">
      <label v-for="(child, i) in field.prefixItems" :key="i"
        >{{ child.title }}
        <ConfigFieldEditor
          v-bind="inputs"
          :schema="child"
          :value="array[i]"
          :path="[...path, String(i)]"
          :label="label + ' · ' + child.title"
          @change="v => replaceRow(i, v)"
        />
      </label>
    </div>
    <template v-else-if="field.type === 'array' && field.items">
      <div class="actions">
        <label v-if="array.length"
          >{{ label }}记录<select :aria-label="label + '记录'" v-model.number="row">
            <option v-for="(v, i) in array" :key="i" :value="i">{{ arrayLabel(v, i) }}</option>
          </select></label
        ><button type="button" :disabled="array.length >= (field.maxItems ?? Infinity)" @click="addRow">
          添加{{ label }}</button
        ><button v-if="array.length > 1" type="button" :disabled="index === 0" @click="moveRow(-1)">
          上移{{ label }}</button
        ><button v-if="array.length > 1" type="button" :disabled="index === array.length - 1" @click="moveRow(1)">
          下移{{ label }}</button
        ><button v-if="array.length" type="button" :disabled="array.length <= (field.minItems ?? 0)" @click="removeRow">
          移除当前{{ label }}
        </button>
      </div>
      <ConfigFieldEditor
        v-if="array.length"
        v-bind="inputs"
        :key="index"
        :schema="field.items"
        :value="array[index]"
        :label="label"
        :path="[...path, String(index)]"
        @change="v => replaceRow(index, v)"
      />
    </template>
    <span v-else-if="field.type === 'null'">空值</span>
    <span v-else-if="field.const !== undefined">{{ fieldLabel(String(field.const)) }}</span>
    <select
      v-else-if="field.enum"
      :aria-label="label"
      :value="value"
      @change="emit('change', field.enum!.find(v => String(v) === ($event.target as HTMLSelectElement).value)!)"
    >
      <option v-for="v in field.enum" :key="String(v)" :value="v">{{ fieldLabel(String(v)) }}</option>
    </select>
    <select
      v-else-if="options"
      :aria-label="label"
      :value="value ?? ''"
      @change="
        emit(
          'change',
          field.type === 'integer'
            ? Number(($event.target as HTMLSelectElement).value)
            : ($event.target as HTMLSelectElement).value,
        )
      "
    >
      <option value="" disabled>{{ options.length ? '选择已有记录' : '暂无可引用记录' }}</option>
      <option v-if="value && !options.some(o => o.id === String(value))" :value="value" disabled>
        {{ value }} · 引用待核对
      </option>
      <option v-for="o in options" :key="o.id" :value="o.id">{{ o.name }} · {{ o.id }}</option>
    </select>
    <label v-else-if="field.type === 'boolean'"
      ><input
        :aria-label="label"
        type="checkbox"
        :checked="value === true"
        @change="emit('change', ($event.target as HTMLInputElement).checked)"
      />{{ label }}</label
    >
    <input
      v-else-if="field.type === 'number' || field.type === 'integer'"
      :aria-label="label"
      type="number"
      :step="field.type === 'integer' ? 1 : 'any'"
      :min="field.minimum"
      :max="field.maximum"
      :value="value"
      @input="
        emit(
          'change',
          ($event.target as HTMLInputElement).value === '' ? '' : ($event.target as HTMLInputElement).valueAsNumber,
        )
      "
    />
    <textarea
      v-else-if="
        free ||
        [
          'truth',
          'opening',
          'description',
          'endings',
          'say',
          'first',
          'again',
          'summary',
          'speakingStyle',
          'text',
          'impulseText',
        ].includes(path.at(-1)!) ||
        path.includes('endings')
      "
      :aria-label="label"
      :maxlength="field.maxLength"
      :value="String(value ?? '')"
      rows="3"
      @input="emit('change', ($event.target as HTMLTextAreaElement).value)"
    />
    <input
      v-else
      :aria-label="label"
      :maxlength="field.maxLength"
      :pattern="field.pattern"
      :value="value"
      @input="emit('change', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>
<style scoped>
.config-field {
  display: grid;
  gap: 0.45rem;
  min-width: 0;
}
fieldset {
  border: 0;
  border-left: 2px solid #d7d7d7;
  padding: 0.35rem 0.7rem;
  margin: 0.15rem 0;
  min-width: 0;
}
legend {
  font-size: 0.85rem;
  color: #555;
}
input:not([type='checkbox']),
select,
textarea {
  box-sizing: border-box;
  width: 100%;
  max-width: 42rem;
  padding: 0.35rem;
}
.actions {
  display: flex;
  gap: 0.5rem;
  align-items: end;
  flex-wrap: wrap;
}
.optional {
  margin-top: 0.4rem;
}
</style>
