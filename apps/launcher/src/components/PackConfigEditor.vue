<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import type { PackConfigDocument } from '../../../host/src/pack-config.ts'
import { useLauncherStore } from '../stores/launcher.ts'
const store = useLauncherStore()
const document = ref<PackConfigDocument>()
const selected = ref('')
const text = ref('')
const saved = ref('')
const mode = ref<'form' | 'json'>('form')
const loading = ref(false)
const error = ref('')
const notice = ref('')
const fieldDrafts = ref<Record<string, string>>({})
const fieldErrors = ref<Record<string, string>>({})
const invalidFields = computed(() => Object.keys(fieldErrors.value).length > 0)
const dirty = computed(() => text.value !== saved.value || Object.keys(fieldDrafts.value).length > 0)
const entry = computed(() => document.value?.entries.find(row => row.id === selected.value))
const parsed = computed<Record<string, unknown> | null>(() => {
  try {
    const value: unknown = JSON.parse(text.value)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
})
const properties = computed(() => {
  const values = entry.value?.schema.properties
  if (!values || typeof values !== 'object' || Array.isArray(values)) return []
  return Object.entries(values)
    .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
    .map(([key, value]) => ({ key, spec: value as Record<string, unknown> }))
})
const required = (key: string) => (entry.value?.schema.required as string[] | undefined)?.includes(key) ?? false
const simple = (spec: Record<string, unknown>) =>
  ['string', 'integer', 'number', 'boolean'].includes(String(spec.type)) || Array.isArray(spec.enum)
const display = (key: string, spec: Record<string, unknown>): string => {
  if (Object.hasOwn(fieldDrafts.value, key)) return fieldDrafts.value[key]!
  const value = parsed.value?.[key]
  if (value === undefined) return ''
  return simple(spec) && !Array.isArray(spec.enum) ? String(value) : JSON.stringify(value, null, 2)
}
function update(key: string, spec: Record<string, unknown>, value: string) {
  if (!parsed.value) return
  const next = { ...parsed.value }
  fieldDrafts.value[key] = value
  try {
    if (value === '') delete next[key]
    else if (Array.isArray(spec.enum) || !simple(spec)) next[key] = JSON.parse(value)
    else if (spec.type === 'boolean') next[key] = value === 'true'
    else if (spec.type === 'number' || spec.type === 'integer') {
      const number = Number(value)
      if (!Number.isFinite(number)) throw new Error('数值无效')
      next[key] = number
    } else next[key] = value
    text.value = JSON.stringify(next, null, 2)
    error.value = ''
    delete fieldErrors.value[key]
    delete fieldDrafts.value[key]
  } catch {
    fieldErrors.value[key] = key + '：请输入有效的 JSON 或数值。'
  }
}
function choose(id: string) {
  if (dirty.value && !confirm('放弃当前未保存的配置修改？')) return false
  fieldDrafts.value = {}
  fieldErrors.value = {}
  selected.value = id
  text.value = document.value?.entries.find(row => row.id === id)?.text ?? ''
  saved.value = text.value
  mode.value = parsed.value ? 'form' : 'json'
  error.value = ''
  return true
}
function selectEntry(event: Event) {
  const select = event.target as HTMLSelectElement
  if (!choose(select.value)) select.value = selected.value
}
async function load() {
  loading.value = true
  error.value = ''
  try {
    document.value = await store.inspectPackConfiguration()
    fieldDrafts.value = {}
    fieldErrors.value = {}
    saved.value = text.value
    choose(
      document.value.entries.some(row => row.id === selected.value)
        ? selected.value
        : (document.value.entries[0]?.id ?? ''),
    )
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    loading.value = false
  }
}
function reload() {
  if (!dirty.value || confirm('放弃当前未保存的配置修改？')) void load()
}
async function save() {
  if (invalidFields.value) return
  if (!entry.value || !document.value) return
  error.value = ''
  notice.value = ''
  if (!parsed.value) {
    error.value = '配置必须是有效的 JSON 对象。'
    return
  }
  loading.value = true
  try {
    if (!(await store.savePackConfiguration(entry.value.id, document.value.packHash, parsed.value))) {
      error.value = store.notice || '保存未完成。'
      return
    }
    saved.value = text.value
    await load()
    notice.value = '源包已保存并重新校验。已有实例保持原包版本，请创建新实例试玩。'
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    loading.value = false
  }
}
const dirtyCheck = inject<{ current: null | (() => boolean) }>('launcher-dirty')
const check = () => dirty.value
onMounted(() => {
  if (dirtyCheck) dirtyCheck.current = check
  void load()
})
onBeforeUnmount(() => {
  if (dirtyCheck?.current === check) dirtyCheck.current = null
})
</script>

<template>
  <section class="pack-config-editor" aria-label="玩法配置">
    <header>
      <h3>玩法配置</h3>
      <p>修改当前源包的规则与内容。保存会先检查字段和引用；已有存档不随配置改写。</p>
    </header>
    <p v-if="store.running" role="status">请结束游戏后再保存源包配置。</p>
    <label v-if="document?.entries.length" class="config-choice"
      >选择玩法
      <select :value="selected" :disabled="loading" @change="selectEntry">
        <option v-for="item in document.entries" :key="item.id" :value="item.id">{{ item.title }}</option>
      </select>
    </label>
    <p v-if="entry" class="config-path">配置位置：{{ entry.path }}</p>
    <p v-if="document?.validation" class="config-note" role="status">{{ document.validation }}</p>
    <template v-if="entry">
      <div class="config-modes" role="group" aria-label="配置编辑方式">
        <button
          type="button"
          :aria-pressed="mode === 'form'"
          :disabled="!parsed || invalidFields"
          @click="mode = 'form'"
        >
          常用字段
        </button>
        <button type="button" :aria-pressed="mode === 'json'" :disabled="invalidFields" @click="mode = 'json'">
          完整 JSON
        </button>
      </div>
      <form @submit.prevent="save">
        <fieldset :disabled="loading || store.running">
          <template v-if="mode === 'form' && parsed">
            <label v-for="{ key, spec } in properties" :key="key" class="config-field">
              <span>{{ spec.title || key }}{{ required(key) ? ' *' : '（可选）' }}</span>
              <small v-if="spec.description">{{ spec.description }}</small>
              <select
                v-if="Array.isArray(spec.enum)"
                :value="display(key, spec)"
                :required="required(key)"
                @change="update(key, spec, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">请选择</option>
                <option v-for="(value, index) in spec.enum" :key="index" :value="JSON.stringify(value)">
                  {{ value }}
                </option>
              </select>
              <select
                v-else-if="spec.type === 'boolean'"
                :value="display(key, spec)"
                :required="required(key)"
                @change="update(key, spec, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">请选择</option>
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
              <input
                v-else-if="spec.type === 'integer' || spec.type === 'number'"
                type="number"
                :value="display(key, spec)"
                :min="spec.minimum as number | undefined"
                :max="spec.maximum as number | undefined"
                step="any"
                :required="required(key)"
                @input="update(key, spec, ($event.target as HTMLInputElement).value)"
              />
              <input
                v-else-if="spec.type === 'string'"
                type="text"
                :value="display(key, spec)"
                :minlength="spec.minLength as number | undefined"
                :maxlength="spec.maxLength as number | undefined"
                :required="required(key)"
                @input="update(key, spec, ($event.target as HTMLInputElement).value)"
              />
              <template v-else>
                <textarea
                  rows="7"
                  :value="display(key, spec)"
                  :required="required(key)"
                  @input="update(key, spec, ($event.target as HTMLTextAreaElement).value)"
                ></textarea
                ><small>结构化字段使用 JSON 编辑；保存时校验完整结构和实体引用。</small></template
              >
            </label>
            <p v-if="!properties.length">此配置没有可生成表单的字段，请使用完整 JSON。</p>
          </template>
          <label v-else class="config-field"
            ><span>配置 JSON</span
            ><textarea v-model="text" rows="18" spellcheck="false" aria-label="配置 JSON"></textarea>
          </label>
        </fieldset>
        <p v-for="(message, key) in fieldErrors" :key="key" class="config-error" role="alert">{{ message }}</p>
        <p v-if="error" class="config-error" role="alert">{{ error }}</p>
        <p v-if="notice" class="config-note" role="status">{{ notice }}</p>
        <div class="config-buttons">
          <button type="submit" :disabled="loading || store.running || !dirty || invalidFields">校验并保存源包</button
          ><button type="button" :disabled="loading" @click="reload">重新载入</button>
        </div>
      </form>
    </template>
    <p v-else-if="!loading && !error">当前启用的玩法没有提供可编辑配置。</p>
    <p v-if="error && !entry" class="config-error" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">正在读取或校验配置…</p>
  </section>
</template>

<style scoped>
.pack-config-editor {
  display: grid;
  gap: 14px;
  min-width: 0;
  color: var(--foreground);
}
header h3 {
  margin: 0 0 6px;
}
header p,
.config-note {
  margin: 0;
  line-height: 1.65;
  color: var(--muted-foreground);
}
.config-choice,
.config-field {
  display: grid;
  gap: 7px;
  min-width: 0;
}
.config-field + .config-field {
  margin-top: 18px;
}
.config-field > span {
  font-weight: 600;
}
.config-field small,
.config-path {
  font-size: 12px;
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}
select,
input,
textarea {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 9px 11px;
  background: var(--background);
  color: inherit;
  font: inherit;
}
textarea {
  resize: vertical;
  font-size: 13px;
  line-height: 1.6;
}
fieldset {
  padding: 0;
  margin: 0;
  border: 0;
  min-width: 0;
}
.config-modes,
.config-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
button {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--background);
  color: inherit;
  cursor: pointer;
}
button[aria-pressed='true'] {
  font-weight: 700;
  border-color: currentColor;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
:where(input, select, textarea, button):focus-visible {
  outline: 2px solid var(--foreground);
  outline-offset: 2px;
}
.config-error {
  border-left: 3px solid currentColor;
  padding-left: 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.config-buttons {
  margin-top: 16px;
}
@media (max-width: 480px) {
  .config-buttons button {
    flex: 1 1 100%;
  }
  .config-path {
    font-size: 11px;
  }
}
</style>
