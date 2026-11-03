<script setup lang="ts">
import { computed } from 'vue'
import { useLauncherStore } from '@/stores/launcher'
import { moduleRows, pickProvider, type ModuleRow } from '@/stores/modules'

const store = useLauncherStore()
const rows = computed(() => moduleRows(store.preferencesDraft.hostPlugins, store.pluginManifests))

function selected(row: ModuleRow) {
  return row.providers.find(provider => provider.enabled)?.pluginId ?? ''
}
function choose(row: ModuleRow, value: string) {
  pickProvider(store.preferencesDraft.hostPlugins, row, value || null)
}
</script>

<template>
  <section class="settings-block module-block" aria-label="模块">
    <strong>模块</strong>
    <p class="muted">每个模块现在由谁提供。插件的声明来自它的清单，应用设置后这里才会更新。</p>
    <div v-for="row in rows" :key="row.seam" class="module-row form-field">
      <span class="muted">{{ row.label }}</span>
      <template v-if="row.single && row.providers.length">
        <select
          :aria-label="row.label"
          :value="selected(row)"
          @change="choose(row, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">官方默认</option>
          <option v-for="provider in row.providers" :key="provider.pluginId" :value="provider.pluginId">
            {{ provider.name }}
          </option>
        </select>
      </template>
      <span v-else>{{ row.effective }}</span>
      <p v-if="row.conflict" class="module-warning" role="alert">
        这个模块只能用一个。启用了多个时，只有第一个（{{ row.effective }}）生效，其余的不会加载。请选一个。
      </p>
    </div>
  </section>
</template>

<style scoped>
.module-block {
  display: grid;
  gap: 8px;
}
.module-row {
  display: grid;
  grid-template-columns: minmax(5em, 8em) minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}
.module-warning {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--danger, #b42318);
}
</style>
