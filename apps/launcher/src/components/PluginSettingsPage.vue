<script setup lang="ts">
import { ChevronDown, ChevronRight, Search } from '@lucide/vue'
import { computed, reactive, ref } from 'vue'
import type { HostPluginSettings } from '../../../../desktop/host-plugin-settings.ts'
import type { PluginManifestInfo } from '../core-types.ts'
import { useLauncherStore } from '../stores/launcher.ts'
import { moduleRows, pickProvider, type ModuleRow } from '../stores/modules.ts'
import PluginSettingsBlock from './PluginSettingsBlock.vue'
import { Button } from './ui/button/index.ts'

/** The whole plugins page: which module each seam is running, then the plugins the player added. */
const store = useLauncherStore()
const plugins = computed(() => store.preferencesDraft.hostPlugins)

const query = ref('')
const open = reactive({ modules: true, plugins: true })
const expanded = reactive(new Set<string>())

/** Each plugin's card keeps a stable key and its latest manifest, including one not saved yet. */
const keys = new WeakMap<object, string>()
function keyOf(plugin: HostPluginSettings) {
  let key = keys.get(plugin)
  if (!key) {
    key = crypto.randomUUID()
    keys.set(plugin, key)
  }
  return key
}
const inspected = reactive(new Map<string, PluginManifestInfo>())
function infoOf(plugin: HostPluginSettings): PluginManifestInfo | undefined {
  return inspected.get(keyOf(plugin)) ?? store.pluginManifests[plugin.id]
}
const manifestOf = (plugin: HostPluginSettings) => {
  const info = infoOf(plugin)
  return info && 'manifest' in info ? info.manifest : undefined
}
const fileName = (path: string) => path.split(/[\\/]/u).pop() || ''
const titleOf = (plugin: HostPluginSettings) => manifestOf(plugin)?.name ?? (fileName(plugin.path) || '新插件')

const rows = computed(() => {
  const manifests: Record<string, PluginManifestInfo> = {}
  for (const plugin of plugins.value) {
    const info = infoOf(plugin)
    if (info) manifests[plugin.id] = info
  }
  return moduleRows(plugins.value, manifests)
})

const needle = computed(() => query.value.trim().toLowerCase())
const matches = (...parts: (string | undefined)[]) =>
  !needle.value || parts.some(part => part?.toLowerCase().includes(needle.value))
const visibleRows = computed(() =>
  rows.value.filter(row =>
    matches(row.label, row.description, row.effective, row.chip, ...row.providers.map(provider => provider.name)),
  ),
)
function pluginVisible(plugin: HostPluginSettings) {
  return matches(titleOf(plugin), manifestOf(plugin)?.description, plugin.id, plugin.path)
}
const anyPluginVisible = computed(() => plugins.value.some(pluginVisible))

function toggle(key: string) {
  if (!expanded.delete(key)) expanded.add(key)
}
function selected(row: ModuleRow) {
  return row.providers.find(provider => provider.enabled)?.pluginId ?? ''
}
function choose(row: ModuleRow, value: string) {
  pickProvider(store.preferencesDraft.hostPlugins, row, value || null)
}
function moduleBadge(row: ModuleRow) {
  if (row.conflict) return { text: '有冲突', tone: 'warn' }
  return row.providers.some(provider => provider.enabled)
    ? { text: '插件提供', tone: 'on' }
    : { text: row.single ? '官方' : '未使用', tone: 'off' }
}
function pluginBadge(plugin: HostPluginSettings) {
  const info = infoOf(plugin)
  if (info && 'error' in info) return { text: '清单有误', tone: 'warn' }
  if (plugin.enabled && store.skippedPlugins.some(item => item.id === plugin.id))
    return { text: '上次已跳过', tone: 'warn' }
  return plugin.enabled ? { text: '启动时加载', tone: 'on' } : { text: '未启用', tone: 'off' }
}
function addPlugin() {
  const plugin = { id: `plugin-${crypto.randomUUID()}`, path: '', enabled: false }
  store.preferencesDraft.hostPlugins.push(plugin)
  const added = store.preferencesDraft.hostPlugins.at(-1)!
  query.value = ''
  open.plugins = true
  expanded.add(keyOf(added))
}
function remove(index: number) {
  store.preferencesDraft.hostPlugins.splice(index, 1)
}
</script>

<template>
  <div class="plugin-page">
    <header class="plugin-page-head">
      <h3>插件</h3>
      <p class="muted">
        插件在下次启动游戏时加载。只添加你信任的本地插件，它们和游戏拥有相同的本机权限。密钥类配置保存在系统凭据管理器。
      </p>
    </header>

    <label class="plugin-search">
      <Search :size="16" aria-hidden="true" />
      <input v-model="query" type="search" placeholder="搜索模块或插件" aria-label="搜索模块或插件" />
    </label>

    <section class="plugin-group">
      <button
        class="plugin-group-head"
        type="button"
        :aria-expanded="open.modules"
        @click="open.modules = !open.modules"
      >
        <component :is="open.modules ? ChevronDown : ChevronRight" :size="16" aria-hidden="true" />
        <span>模块</span>
      </button>
      <p class="muted plugin-group-note">游戏的每个部分现在由谁提供。官方实现可以被插件替换。</p>
      <div v-show="open.modules" class="plugin-grid">
        <article v-for="row in visibleRows" :key="row.seam" class="plugin-card">
          <component
            :is="row.providers.length ? 'button' : 'div'"
            class="plugin-card-head"
            v-bind="row.providers.length ? { type: 'button', 'aria-expanded': expanded.has(row.seam) } : {}"
            @click="row.providers.length && toggle(row.seam)"
          >
            <span class="plugin-card-title">
              <strong>{{ row.label }}</strong>
              <span class="plugin-badge" :data-tone="moduleBadge(row).tone">{{ moduleBadge(row).text }}</span>
              <ChevronDown
                v-if="row.providers.length"
                class="plugin-card-chevron"
                :class="{ turned: expanded.has(row.seam) }"
                :size="16"
                aria-hidden="true"
              />
            </span>
            <span class="plugin-card-text">{{ row.description }}</span>
            <span v-if="row.chip" class="plugin-card-foot"
              ><code class="plugin-chip">{{ row.chip }}</code></span
            >
          </component>
          <p v-if="row.conflict" class="plugin-warning" role="alert">
            这个模块只能用一个。启用了多个时，只有第一个（{{ row.effective }}）生效，其余的不会加载。请选一个。
          </p>
          <div v-if="expanded.has(row.seam) || row.conflict" class="plugin-card-body">
            <div v-if="row.single" class="form-field">
              <label :for="`module-${row.seam}`">由谁提供</label>
              <select
                :id="`module-${row.seam}`"
                :value="selected(row)"
                @change="choose(row, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">官方默认</option>
                <option v-for="provider in row.providers" :key="provider.pluginId" :value="provider.pluginId">
                  {{ provider.name }}
                </option>
              </select>
            </div>
            <ul v-else class="plugin-provider-list">
              <li v-for="provider in row.providers" :key="provider.pluginId">
                {{ provider.name }}<span class="muted">{{ provider.enabled ? '' : '（未启用）' }}</span>
              </li>
            </ul>
          </div>
        </article>
      </div>
    </section>

    <section class="plugin-group">
      <button
        class="plugin-group-head"
        type="button"
        :aria-expanded="open.plugins"
        @click="open.plugins = !open.plugins"
      >
        <component :is="open.plugins ? ChevronDown : ChevronRight" :size="16" aria-hidden="true" />
        <span>本地插件</span>
      </button>
      <p class="muted plugin-group-note">你添加到这台电脑上的插件，名称和说明来自它旁边的 .plugin.json 清单。</p>
      <div v-show="open.plugins" class="plugin-grid">
        <!-- Stay mounted while collapsed or filtered out: each block reads its plugin's manifest for the card. -->
        <article
          v-for="(plugin, index) in plugins"
          v-show="pluginVisible(plugin)"
          :key="keyOf(plugin)"
          class="plugin-card"
          :class="{ wide: expanded.has(keyOf(plugin)) }"
        >
          <button
            class="plugin-card-head"
            type="button"
            :aria-expanded="expanded.has(keyOf(plugin))"
            @click="toggle(keyOf(plugin))"
          >
            <span class="plugin-card-title">
              <strong>{{ titleOf(plugin) }}</strong>
              <span class="plugin-badge" :data-tone="pluginBadge(plugin).tone">{{ pluginBadge(plugin).text }}</span>
              <ChevronDown
                class="plugin-card-chevron"
                :class="{ turned: expanded.has(keyOf(plugin)) }"
                :size="16"
                aria-hidden="true"
              />
            </span>
            <span v-if="manifestOf(plugin)?.description" class="plugin-card-text">{{
              manifestOf(plugin)!.description
            }}</span>
            <span class="plugin-card-foot">
              <code class="plugin-chip">{{ manifestOf(plugin)?.id ?? plugin.id }}</code>
            </span>
          </button>
          <div v-show="expanded.has(keyOf(plugin))" class="plugin-card-body">
            <PluginSettingsBlock
              :plugin="plugin"
              :index="index"
              @inspected="info => inspected.set(keyOf(plugin), info)"
              @remove="remove(index)"
            />
          </div>
        </article>
        <p v-if="!plugins.length" class="muted plugin-empty">还没有添加插件。</p>
        <p v-else-if="!anyPluginVisible" class="muted plugin-empty">没有找到匹配的插件。</p>
      </div>
      <Button
        v-show="open.plugins"
        class="plugin-add"
        variant="outline"
        :disabled="plugins.length >= 16"
        @click="addPlugin"
        >添加本地插件</Button
      >
    </section>
  </div>
</template>

<style scoped>
.plugin-page {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.plugin-page-head h3 {
  margin: 0 0 4px;
}
.plugin-page-head p {
  margin: 0;
}
.plugin-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--card-bg);
  color: var(--muted-foreground);
}
.plugin-search:focus-within {
  border-color: var(--selected-border);
}
.plugin-search input {
  flex: 1;
  min-width: 0;
  padding: 9px 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--foreground);
  font: inherit;
}
.plugin-search input::placeholder {
  color: var(--faint);
}
.plugin-group {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.plugin-group + .plugin-group {
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.plugin-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-self: start;
  padding: 2px 6px 2px 0;
  border: 0;
  background: none;
  color: var(--foreground);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.plugin-group-note {
  margin: 0 0 4px 22px;
  font-size: var(--font-small);
}
.plugin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr));
  grid-auto-flow: dense;
  gap: 10px;
  align-items: start;
}
.plugin-card {
  display: grid;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card-bg);
}
.plugin-card.wide {
  grid-column: 1 / -1;
}
.plugin-card-head {
  display: grid;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 12px 14px;
  border: 0;
  border-radius: inherit;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
}
button.plugin-card-head {
  cursor: pointer;
}
button.plugin-card-head:hover {
  background: var(--card-hover);
}
button.plugin-card-head:focus-visible,
.plugin-group-head:focus-visible {
  outline: 2px solid var(--selected-border);
  outline-offset: 2px;
}
.plugin-card-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.plugin-card-title strong {
  min-width: 0;
  overflow-wrap: anywhere;
}
.plugin-card-chevron {
  flex: none;
  margin-left: auto;
  color: var(--muted-foreground);
  transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1);
}
.plugin-card-chevron.turned {
  transform: rotate(180deg);
}
.plugin-card-text {
  color: var(--muted-foreground);
  font-size: var(--font-small);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.plugin-card-foot {
  display: flex;
  min-width: 0;
}
.plugin-chip {
  max-width: 100%;
  padding: 1px 6px;
  overflow: hidden;
  border-radius: 5px;
  background: var(--secondary);
  color: var(--muted-foreground);
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-badge {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--secondary);
  color: var(--muted-foreground);
  font-size: 11px;
  line-height: 18px;
}
.plugin-badge[data-tone='on'] {
  background: var(--selected);
  color: var(--foreground);
}
.plugin-badge[data-tone='warn'] {
  background: var(--warning-bg);
  color: var(--foreground);
}
.plugin-warning {
  margin: 0;
  padding: 0 14px 10px;
  color: var(--danger);
  font-size: 13px;
}
.plugin-card-body {
  min-width: 0;
  padding: 12px 14px 14px;
  border-top: 1px solid var(--border);
}
.plugin-provider-list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
}
.plugin-empty {
  grid-column: 1 / -1;
  margin: 0;
  padding: 16px;
  text-align: center;
}
.plugin-add {
  justify-self: start;
}
@media (prefers-reduced-motion: reduce) {
  .plugin-card-chevron {
    transition: none;
  }
}
</style>
