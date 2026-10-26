<script setup lang="ts">
import { onMounted, provide, ref } from 'vue'
import { X } from '@lucide/vue'
import { PLUGIN_SKIP_REASON, useLauncherStore } from '../stores/launcher.ts'
import { chooseDataDirectory, dataLocation, type DataLocation } from '../services/desktop.ts'
import { Button } from './ui/button/index.ts'
import ModelSettingsDialog from './ModelSettingsDialog.vue'
/** 全局设置窗口：浮在启动器上方。外观与阅读声音走草稿，“应用 / 保存”提交；模型接口沿用即时保存。 */
const emit = defineEmits<{ close: [] }>()
provide('launcher-embedded', true)
const store = useLauncherStore()
type Category = 'connections' | 'appearance' | 'reading' | 'plugins' | 'data' | 'about'
const categories: { id: Category; label: string }[] = [
  { id: 'connections', label: '模型接口' },
  { id: 'appearance', label: '外观' },
  { id: 'reading', label: '阅读与声音' },
  { id: 'plugins', label: '插件' },
  { id: 'data', label: '数据位置' },
  { id: 'about', label: '关于' },
]
const category = ref<Category>('connections')
const location = ref<DataLocation | null>(null)
const error = ref(''),
  saving = ref(false)
onMounted(async () => {
  store.resetPreferencesDraft()
  if (store.real) {
    try {
      location.value = await dataLocation()
    } catch (e) {
      error.value = typeof e === 'string' ? e : '读取数据位置失败。'
    }
  }
})
async function chooseDirectory() {
  try {
    const path = await chooseDataDirectory()
    if (!path) return
    saving.value = true
    error.value = ''
    location.value = await dataLocation('data-location-save', { directory: path })
  } catch (e) {
    error.value = typeof e === 'string' ? e : '更改数据位置失败。'
  } finally {
    saving.value = false
  }
}
async function openFolder(folder: 'root' | 'instances') {
  try {
    await dataLocation('data-folder-open', { folder })
    error.value = ''
  } catch (e) {
    error.value = typeof e === 'string' ? e : '打开文件夹失败。'
  }
}
async function apply(close: boolean) {
  error.value = ''
  try {
    if ((await store.applyPreferences()) && close) emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '设置无效。'
  }
}
function cancel() {
  if (store.preferencesDirty && !confirm('设置有未应用的修改，确定放弃？')) return
  store.resetPreferencesDraft()
  emit('close')
}
function addPlugin() {
  store.preferencesDraft.hostPlugins.push({ id: `plugin-${crypto.randomUUID()}`, path: '', enabled: false })
}
function skippedReason(id: string) {
  const skipped = store.skippedPlugins.find(plugin => plugin.id === id)
  return skipped ? PLUGIN_SKIP_REASON[skipped.reason] : ''
}
</script>
<template>
  <div class="settings-scrim" @click.self="cancel">
    <section class="settings-window" role="dialog" aria-modal="true" aria-label="设置">
      <header class="settings-head">
        <strong>设置</strong
        ><button class="settings-close" aria-label="关闭设置" @click="cancel"><X :size="16" /></button>
      </header>
      <div class="settings-main">
        <nav class="settings-nav" aria-label="设置分类">
          <button
            v-for="item in categories"
            :key="item.id"
            :class="{ active: category === item.id }"
            @click="category = item.id"
          >
            {{ item.label }}
          </button>
        </nav>
        <div class="settings-pane">
          <p v-if="store.running" class="settings-running" role="status">
            游戏运行中：模型接口、阅读、声音与插件的修改将在下次启动游戏时生效；外观立即作用于启动器。
          </p>
          <template v-if="category === 'connections'">
            <p class="inline-info">连接修改立即保存，不受下方“取消 / 应用 / 保存”影响。</p>
            <ModelSettingsDialog :open="true" @close="cancel" />
          </template>
          <template v-else-if="category === 'appearance'">
            <div class="form-field">
              <label for="launcher-theme">主题</label
              ><select id="launcher-theme" v-model="store.preferencesDraft.theme">
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </div>
            <label class="checkbox-row"
              ><input v-model="store.preferencesDraft.largeText" type="checkbox" />使用较大文字</label
            >
          </template>
          <template v-else-if="category === 'reading'">
            <section class="settings-block">
              <h4>默认前端阅读偏好</h4>
              <p class="muted">作用于下次启动的官方游戏前端。社区前端可自行选择是否采用。</p>
              <div class="settings-grid">
                <div class="form-field">
                  <label for="reading-font">对话字号（14–28）</label
                  ><input
                    id="reading-font"
                    v-model.number="store.preferencesDraft.reading.fontSize"
                    type="number"
                    min="14"
                    max="28"
                    step="1"
                  />
                </div>
                <div class="form-field">
                  <label for="reading-line-height">对话行距（1.4–2.4）</label
                  ><input
                    id="reading-line-height"
                    v-model.number="store.preferencesDraft.reading.lineHeight"
                    type="number"
                    min="1.4"
                    max="2.4"
                    step="0.1"
                  />
                </div>
              </div>
              <label class="checkbox-row"
                ><input
                  v-model="store.preferencesDraft.reading.autoFollow"
                  type="checkbox"
                />靠近底部时自动跟随最新对话</label
              >
            </section>
            <section class="settings-block">
              <h4>声音偏好</h4>
              <p class="muted">
                下次启动游戏时生效。官方舞台安装对应插件后支持角色语音与背景音乐，首次点击页面后开始播放。
              </p>
              <div class="form-field">
                <label for="audio-volume">音量（0–100）</label
                ><input
                  id="audio-volume"
                  v-model.number="store.preferencesDraft.audio.volume"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                />
              </div>
              <label class="checkbox-row"
                ><input v-model="store.preferencesDraft.audio.muted" type="checkbox" />静音</label
              >
              <label class="checkbox-row"
                ><input v-model="store.preferencesDraft.audio.voiceEnabled" type="checkbox" />启用语音朗读</label
              >
            </section>
          </template>
          <template v-else-if="category === 'plugins'">
            <p class="muted">
              插件在下次启动游戏时加载。只添加你信任的本地插件；它们与游戏宿主拥有相同的本机访问权限。
            </p>
            <p class="muted">
              语音插件提供合成服务，背景音乐插件提供曲库与选曲规则。安装后可在游戏的声音设置中控制播放；当前未附带语音合成器。
            </p>
            <section v-for="(plugin, index) in store.preferencesDraft.hostPlugins" :key="index" class="settings-block">
              <div class="form-field">
                <label :for="`plugin-id-${index}`">插件 ID</label
                ><input :id="`plugin-id-${index}`" v-model="plugin.id" maxlength="64" />
              </div>
              <div class="form-field">
                <label :for="`plugin-path-${index}`">插件文件（.mjs / .js 绝对路径）</label
                ><input :id="`plugin-path-${index}`" v-model="plugin.path" />
              </div>
              <label class="checkbox-row"><input v-model="plugin.enabled" type="checkbox" />启动游戏时加载此插件</label>
              <p v-if="skippedReason(plugin.id)" class="plugin-skipped" role="status">
                上次启动时{{ skippedReason(plugin.id) }}，已跳过。请检查插件文件，或取消勾选后重试。
              </p>
              <Button variant="outline" @click="store.preferencesDraft.hostPlugins.splice(index, 1)">移除</Button>
            </section>
            <Button variant="outline" :disabled="store.preferencesDraft.hostPlugins.length >= 16" @click="addPlugin"
              >添加本地插件</Button
            >
          </template>
          <template v-else-if="category === 'data'">
            <div class="settings-section">
              <div class="form-field">
                <label for="data-directory">当前数据根目录</label
                ><input id="data-directory" :value="store.dataDirectory || '浏览器预览不保存实际实例数据'" readonly />
              </div>
              <div class="settings-folder-actions">
                <Button variant="outline" :disabled="!store.real" @click="openFolder('root')">打开文件夹</Button
                ><Button
                  variant="outline"
                  :disabled="
                    !store.real ||
                    !location ||
                    location.locked ||
                    store.busy ||
                    saving ||
                    store.core.state === 'running'
                  "
                  @click="chooseDirectory"
                  >更改数据目录</Button
                >
              </div>
              <p v-if="location && location.next !== location.current" class="inline-info" role="status">
                重启后切换到：{{ location.next
                }}<br />目录选择已保存；旧目录保留，不自动迁移存档。当前游戏仍使用上方目录。重新选择当前目录可取消切换。
              </p>
              <p v-if="location?.locked" class="muted">
                数据目录由 PERSPECTRA_LAUNCHER_DATA_DIR 指定，请修改环境变量后重启。
              </p>
              <p class="muted">
                选择空目录将建立新的游戏库；选择已有 Perspectra
                数据目录可继续使用其中的实例。切换需重启，旧目录中的实例、故事线和记忆不会自动搬迁。
              </p>
            </div>
            <div class="settings-section">
              <div class="form-field">
                <label for="instance-directory">实例、存档与角色记忆</label
                ><input
                  id="instance-directory"
                  :value="store.dataDirectory ? store.dataDirectory + '/instances' : '桌面运行时可用'"
                  readonly
                />
              </div>
              <Button variant="outline" :disabled="!store.real" @click="openFolder('instances')">打开实例文件夹</Button>
              <p class="muted">
                启动器配置：根目录中的 launcher.json。预设：preset-settings.json 与
                preset-library.json。游戏包保留在载入时的原始位置。
              </p>
            </div>
          </template>
          <template v-else>
            <h3 class="settings-title">Perspectra 0.1.0</h3>
            <p class="muted">
              以 AI 角色为核心的半开放式游戏运行平台原型。{{ store.real ? '本机 · 独立实例' : '浏览器预览' }}
            </p>
          </template>
          <p v-if="error" role="alert">{{ error }}</p>
        </div>
      </div>
      <footer class="settings-foot">
        <span class="muted">{{ store.preferencesDirty ? '设置有未应用的修改' : '' }}</span>
        <Button variant="outline" @click="cancel">取消</Button>
        <Button variant="outline" :disabled="store.busy || !store.preferencesDirty" @click="apply(false)">应用</Button>
        <Button :disabled="store.busy" @click="apply(true)">保存</Button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.plugin-skipped {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  border-left: 3px solid var(--warning);
  background: var(--warning-bg);
  color: var(--foreground);
  font-size: 13px;
}
.settings-scrim {
  position: absolute;
  inset: 0;
  z-index: 50;
  background: rgba(10, 6, 8, 0.4);
  display: grid;
  place-items: center;
  padding: 56px 24px 24px;
}
.settings-window {
  width: min(860px, 100%);
  height: min(620px, 100%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--background);
  color: var(--foreground);
  border-radius: 14px;
  box-shadow: var(--shadow);
  border: 1px solid var(--border-strong);
}
.settings-head {
  display: flex;
  align-items: center;
  height: 44px;
  padding: 0 10px 0 18px;
  border-bottom: 1px solid var(--border);
  font-family: var(--font-display);
  font-size: 15px;
}
.settings-close {
  margin-left: auto;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.settings-close:hover {
  background: var(--secondary);
}
.settings-main {
  flex: 1;
  min-height: 0;
  display: flex;
}
.settings-nav {
  width: 150px;
  flex: none;
  padding: 12px 8px;
  border-right: 1px solid var(--border);
  display: grid;
  align-content: start;
  gap: 2px;
  background: var(--sidebar);
}
.settings-nav button {
  text-align: left;
  padding: 9px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  font-size: 13.5px;
}
.settings-nav button:hover {
  background: var(--secondary);
  color: var(--foreground);
}
.settings-nav button.active {
  background: var(--selected);
  color: var(--primary);
  font-weight: 650;
  box-shadow: inset 3px 0 0 var(--primary);
}
.settings-pane {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 18px 22px;
  display: grid;
  gap: 16px;
  align-content: start;
}
.settings-block {
  display: grid;
  gap: 10px;
}
.settings-block h4,
.settings-title {
  margin: 0;
  font-size: 14px;
}
.settings-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}
.settings-foot .muted {
  margin-right: auto;
}
.settings-running {
  margin: 0;
  padding: 7px 12px;
  border-radius: 8px;
  font-size: 12.5px;
  background: color-mix(in srgb, var(--warning) 16%, transparent);
}
</style>
