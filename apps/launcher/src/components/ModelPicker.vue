<script setup lang="ts">
import { computed, watch } from 'vue'
import { RefreshCw } from '@lucide/vue'
import { useLauncherStore } from '../stores/launcher.ts'
import type { ModelTarget } from '../core-types.ts'
/** Picks a model from a connection's list; free typing stays available for gateways without /models. */
const props = defineProps<{ modelValue: ModelTarget | undefined; label: string; idPrefix: string }>()
const emit = defineEmits<{ 'update:modelValue': [ModelTarget] }>()
const store = useLauncherStore()
const connectionId = computed(() => props.modelValue?.connectionId ?? store.connections[0]?.id ?? '')
const list = computed(() => store.modelLists[connectionId.value])
watch(connectionId, id => { if (id && !store.modelLists[id]) void store.refreshModels(id) }, { immediate: true })
function update(next: Partial<ModelTarget>) {
  emit('update:modelValue', { connectionId: connectionId.value, model: props.modelValue?.model ?? '', ...next })
}
</script>
<template>
  <div class="model-picker">
    <div class="form-field"><label :for="idPrefix + '-connection'">{{ label }} · 连接</label>
      <select :id="idPrefix + '-connection'" :value="connectionId" @change="update({ connectionId: ($event.target as HTMLSelectElement).value, model: '' })">
        <option v-for="connection in store.connections" :key="connection.id" :value="connection.id">{{ connection.name }}</option>
      </select>
    </div>
    <div class="form-field"><label :for="idPrefix + '-model'">{{ label }} · 模型</label>
      <div class="model-input-row">
        <input :id="idPrefix + '-model'" :value="modelValue?.model ?? ''" :list="idPrefix + '-models'" autocomplete="off" spellcheck="false"
          :placeholder="list?.models.length ? '从列表选择或输入以过滤' : '输入模型标识'" @input="update({ model: ($event.target as HTMLInputElement).value })" />
        <button type="button" class="icon-button" :disabled="!connectionId || list?.loading" aria-label="刷新模型列表" title="刷新模型列表" @click="store.refreshModels(connectionId)"><RefreshCw :size="16" /></button>
      </div>
      <datalist :id="idPrefix + '-models'"><option v-for="model in list?.models ?? []" :key="model" :value="model" /></datalist>
      <small v-if="list?.loading" class="muted">正在获取模型列表…</small>
      <small v-else-if="list?.error" class="muted">{{ list.error }} 仍可直接输入模型标识。</small>
      <small v-else-if="list" class="muted">此连接共 {{ list.models.length }} 个可用模型。</small>
    </div>
  </div>
</template>
<style scoped>
.model-picker { display: grid; gap: 12px; }
.model-input-row { display: flex; gap: 8px; }
.model-input-row input { flex: 1; min-width: 0; }
.icon-button { border: 1px solid var(--border); border-radius: 10px; background: transparent; color: inherit; padding: 0 10px; cursor: pointer; }
.icon-button:disabled { opacity: .4; cursor: not-allowed; }
</style>
