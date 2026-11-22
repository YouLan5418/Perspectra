<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { EventGrant } from '@perspectra/sdk'
import type { eventOptions } from '../../../host/src/editor/event-options.ts'
import { editorRequest } from './editor-api.ts'
const props = defineProps<{ options: Awaited<ReturnType<typeof eventOptions>> }>()
type Grant = { plugin: string; type: string; mode: 'durable' | 'live'; effect?: { key: string; value: boolean } }
const base = ref<EventGrant[]>([]),
  rows = ref<Grant[]>([]),
  error = ref(''),
  notice = ref(''),
  busy = ref(false)
const dirty = computed(() => JSON.stringify(rows.value) !== JSON.stringify(base.value))
function load(grants: readonly EventGrant[]) {
  base.value = JSON.parse(JSON.stringify(grants))
  rows.value = JSON.parse(JSON.stringify(grants))
}
watch(
  () => props.options.grants,
  grants => {
    if (!dirty.value) load(grants)
  },
  { immediate: true },
)
async function flush() {
  if (busy.value) throw new Error('请等订阅授权操作完成')
  if (!dirty.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await editorRequest('rule-save', { kind: 'grants', base: base.value, row: rows.value })
    load(rows.value)
    notice.value = '订阅授权已保存'
  } catch (e) {
    error.value = (e as Error).message
    throw e
  } finally {
    busy.value = false
  }
}
async function save() {
  try {
    await flush()
  } catch {
    /* flush displays the reason and retains the draft. */
  }
}
async function reload() {
  if (busy.value) return
  busy.value = true
  try {
    load((await editorRequest<Awaited<ReturnType<typeof eventOptions>>>('event-candidates')).grants)
    error.value = ''
    notice.value = '已载入已保存授权'
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
defineExpose({ flush })
</script>
<template>
  <details>
    <summary>插件事件订阅授权</summary>
    <fieldset :disabled="busy">
      <div v-for="(g, i) in rows" :key="i">
        <label
          >订阅插件 · 必填<select v-model="g.plugin" :aria-label="'订阅插件 ' + (i + 1)">
            <option v-for="id in options.plugins" :key="id">{{ id }}</option>
          </select></label
        >
        <label
          >订阅事件类型 · 必填<select v-model="g.type" :aria-label="'订阅事件类型 ' + (i + 1)">
            <option v-for="id in options.types" :key="id">{{ id }}</option>
          </select></label
        >
        <label
          >订阅方式<select v-model="g.mode" @change="g.mode === 'live' && delete g.effect">
            <option value="live">即时</option>
            <option value="durable">持久</option>
          </select></label
        >
        <template v-if="g.mode === 'durable'"
          ><label
            ><input
              type="checkbox"
              :checked="!!g.effect"
              @change="
                ($event.target as HTMLInputElement).checked
                  ? (g.effect = { key: options.writes[0]?.key ?? '', value: true })
                  : delete g.effect
              "
            />指定订阅可写的状态 · 选填</label
          >
          <template v-if="g.effect"
            ><label
              >订阅写入变量<select v-model="g.effect.key">
                <option v-for="v in options.writes" :key="v.key" :value="v.key">{{ v.label }} · {{ v.key }}</option>
              </select></label
            >
            <label
              >订阅写入值<select v-model="g.effect.value">
                <option :value="true">是</option>
                <option :value="false">否</option>
              </select></label
            ></template
          ></template
        >
        <button type="button" @click="rows.splice(i, 1)">移除此授权</button>
      </div>
      <button
        type="button"
        :disabled="!options.plugins.length || !options.types.length || rows.length >= 64"
        @click="rows.push({ plugin: options.plugins[0]!, type: options.types[0]!, mode: 'live' })"
      >
        添加订阅授权
      </button>
      <button type="button" :disabled="!dirty" @click="save">保存订阅授权</button
      ><button v-if="dirty" type="button" @click="reload">放弃授权修改并重读</button>
      <p v-if="!options.types.length">保存第一个世界事件后即可选择其类型。</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
    </fieldset>
  </details>
</template>
