<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { PLUGIN_SKIP_REASON, useLauncherStore } from '../stores/launcher.ts'
import type { HostPluginSettings } from '../../../../desktop/host-plugin-settings.ts'
import type { PluginManifestInfo, PluginManifest } from '../core-types.ts'
import { Button } from './ui/button/index.ts'

/** One saved plugin in settings: its file, what its manifest says it is and uses, and its config form. */
const props = defineProps<{ plugin: HostPluginSettings; index: number }>()
const emit = defineEmits<{ remove: [] }>()
const store = useLauncherStore()

const SERVICE_LABELS: Record<PluginManifest['services'][number], string> = {
  frontendServices: '语音与背景音乐',
  capabilities: '外部能力（结果经世界包规则裁定）',
  playerFeed: '读取你能看到的对话',
}

const info = ref<PluginManifestInfo>()
let timer: ReturnType<typeof setTimeout> | undefined
watch(
  () => props.plugin.path,
  path => {
    clearTimeout(timer)
    info.value = undefined
    if (!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(path.trim()) || !/\.(?:mjs|js)$/i.test(path.trim())) return
    // Wait for typing to settle; the launcher reads the sidecar manifest without running the plugin.
    timer = setTimeout(async () => {
      const result = await store.inspectPlugin(path.trim())
      if (props.plugin.path !== path) return
      info.value = result
      if ('manifest' in result) void store.refreshPluginSecrets(props.plugin.id, secretFields(result.manifest))
    }, 300)
  },
  { immediate: true },
)
onUnmounted(() => clearTimeout(timer))

const manifest = computed(() => (info.value && 'manifest' in info.value ? info.value.manifest : undefined))
const fields = computed(() => Object.entries(manifest.value?.config ?? {}))
function secretFields(value: PluginManifest) {
  return Object.entries(value.config ?? {})
    .filter(([, field]) => field.type === 'string' && field.secret)
    .map(([name]) => name)
}
const skipped = computed(() => store.skippedPlugins.find(item => item.id === props.plugin.id))

function value(name: string) {
  return props.plugin.config?.[name]
}
/** An empty input removes the saved value, so the manifest default applies again. */
function setValue(name: string, next: string | number | boolean | undefined) {
  const config = { ...props.plugin.config }
  if (next === undefined || next === '' || (typeof next === 'number' && Number.isNaN(next))) delete config[name]
  else config[name] = next
  if (Object.keys(config).length) props.plugin.config = config
  else delete props.plugin.config
}
function secretDraft(name: string) {
  return store.pluginSecretDrafts[props.plugin.id]?.[name]
}
function setSecret(name: string, next: string) {
  store.pluginSecretDrafts[props.plugin.id] = { ...store.pluginSecretDrafts[props.plugin.id], [name]: next }
}
function secretStored(name: string) {
  return store.pluginSecretsStored[props.plugin.id]?.includes(name) ?? false
}
</script>

<template>
  <section class="settings-block plugin-block">
    <div class="form-field">
      <label :for="`plugin-id-${index}`">插件 ID</label
      ><input :id="`plugin-id-${index}`" v-model="plugin.id" maxlength="64" />
    </div>
    <div class="form-field">
      <label :for="`plugin-path-${index}`">插件文件（.mjs / .js 绝对路径）</label
      ><input :id="`plugin-path-${index}`" v-model="plugin.path" />
    </div>

    <div v-if="manifest" class="plugin-manifest">
      <p class="plugin-title">
        <strong>{{ manifest.name }}</strong> <span class="muted">v{{ manifest.version }}</span>
        <span v-if="manifest.author" class="muted"> · {{ manifest.author }}</span>
      </p>
      <p v-if="manifest.description" class="muted">{{ manifest.description }}</p>
      <p class="plugin-services">
        <span class="muted">声明使用：</span>
        <span v-for="service in manifest.services" :key="service" class="plugin-service">{{
          SERVICE_LABELS[service]
        }}</span>
        <span v-if="!manifest.services.length" class="muted">不使用游戏提供的服务</span>
      </p>
      <p class="muted plugin-note">这是插件作者的声明，宿主不强制；插件是本地代码，拥有与游戏相同的本机权限。</p>
    </div>
    <p v-else-if="info && 'missing' in info" class="muted">
      未提供插件清单：名称、作者和所用服务未知，也没有可配置的选项。
    </p>
    <p v-else-if="info && 'error' in info" class="plugin-skipped" role="status">{{ info.error }}</p>

    <div v-if="fields.length" class="plugin-config">
      <template v-for="[name, field] in fields" :key="name">
        <!-- Not a .form-field: its full-width input styling would stretch the checkbox. -->
        <div v-if="field.type === 'boolean'" class="plugin-boolean">
          <label class="checkbox-row"
            ><input
              type="checkbox"
              :checked="(value(name) ?? field.default ?? false) as boolean"
              @change="setValue(name, ($event.target as HTMLInputElement).checked)"
            />{{ field.title }}</label
          >
          <p v-if="field.description" class="muted field-help">{{ field.description }}</p>
        </div>
        <div v-else class="form-field">
          <label :for="`plugin-${index}-${name}`"
            >{{ field.title }}<span v-if="field.required" aria-label="必填"> *</span></label
          >
          <select
            v-if="field.type === 'string' && field.enum"
            :id="`plugin-${index}-${name}`"
            :value="value(name) ?? field.default ?? ''"
            @change="setValue(name, ($event.target as HTMLSelectElement).value)"
          >
            <option v-if="!field.required && field.default === undefined" value="">（不设置）</option>
            <option v-for="option in field.enum" :key="option" :value="option">{{ option }}</option>
          </select>
          <template v-else-if="field.type === 'string' && field.secret">
            <input
              :id="`plugin-${index}-${name}`"
              type="password"
              autocomplete="off"
              :disabled="!store.real"
              :placeholder="secretStored(name) ? '已保存在系统凭据管理器，输入可替换' : '未设置'"
              :value="secretDraft(name) ?? ''"
              @input="setSecret(name, ($event.target as HTMLInputElement).value)"
            />
            <Button
              v-if="secretStored(name) && secretDraft(name) === undefined"
              variant="outline"
              class="secret-clear"
              @click="setSecret(name, '')"
              >清除已保存的值</Button
            >
          </template>
          <input
            v-else-if="field.type === 'string'"
            :id="`plugin-${index}-${name}`"
            :maxlength="field.maxLength ?? 4096"
            :placeholder="field.default === undefined ? '' : `默认：${field.default}`"
            :value="value(name) ?? ''"
            @input="setValue(name, ($event.target as HTMLInputElement).value)"
          />
          <input
            v-else
            :id="`plugin-${index}-${name}`"
            type="number"
            :step="field.type === 'integer' ? 1 : 'any'"
            :min="field.minimum"
            :max="field.maximum"
            :placeholder="field.default === undefined ? '' : `默认：${field.default}`"
            :value="value(name) ?? ''"
            @input="
              setValue(
                name,
                ($event.target as HTMLInputElement).value === ''
                  ? undefined
                  : Number(($event.target as HTMLInputElement).value),
              )
            "
          />
          <p v-if="field.description" class="muted field-help">{{ field.description }}</p>
          <p v-if="field.type === 'string' && field.secret && !store.real" class="muted field-help">
            浏览器预览无法访问系统凭据管理器。
          </p>
        </div>
      </template>
    </div>

    <label class="checkbox-row"><input v-model="plugin.enabled" type="checkbox" />启动游戏时加载此插件</label>
    <p v-if="skipped" class="plugin-skipped" role="status">
      上次启动时{{ PLUGIN_SKIP_REASON[skipped.reason] }}，已跳过<span v-if="skipped.detail">：{{ skipped.detail }}</span
      ><span v-else>。请检查插件文件，或取消勾选后重试。</span>
    </p>
    <Button variant="outline" @click="emit('remove')">移除</Button>
  </section>
</template>

<style scoped>
.plugin-manifest,
.plugin-config {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.plugin-manifest p,
.plugin-config p {
  margin: 0;
}
.plugin-title {
  font-size: 14px;
}
.plugin-services {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-size: 13px;
}
.plugin-service {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--warning-bg);
  border: 1px solid var(--border);
  font-size: 12px;
}
.plugin-note,
.field-help {
  font-size: 12px;
}
.plugin-boolean {
  display: grid;
  gap: 4px;
}
.secret-clear {
  justify-self: start;
}
.plugin-skipped {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  border-left: 3px solid var(--warning);
  background: var(--warning-bg);
  color: var(--foreground);
  font-size: 13px;
}
</style>
