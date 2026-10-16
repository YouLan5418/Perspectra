<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { DEFAULT_READING, readingPreferences, DEFAULT_AUDIO, audioPreferences, DEFAULT_PALETTE, palettePreference, type Palette } from '../../../../desktop/play-settings.ts'
import { useLauncherStore } from '../stores/launcher.ts'
import { chooseDataDirectory, dataLocation, type DataLocation } from '../services/desktop.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
const draft = reactive({ theme: 'system' as 'system' | 'light' | 'dark', palette: DEFAULT_PALETTE as Palette, largeText: false, reading:{...DEFAULT_READING}, audio:{...DEFAULT_AUDIO} })
const paletteChoices: { value: Palette; name: string; hint: string }[] = [
 { value: 'sakura', name: '樱色', hint: '恋爱 · 日常' },
 { value: 'lamp', name: '灯火', hint: '温暖 · 悬疑' },
 { value: 'moon', name: '月夜', hint: '科幻 · 冷峻' },
 { value: 'forest', name: '森林', hint: '奇幻 · 冒险' },
]
const location = ref<DataLocation | null>(null)
const error = ref(''), saving = ref(false)
watch(() => props.open, async open => {
 if (!open) return
 Object.assign(draft, { theme: store.theme, palette: store.palette, largeText: store.largeText, reading:{...store.reading}, audio:{...store.audio} })
 error.value = ''; location.value = null
 if (store.real) {
  try { location.value = await dataLocation() }
  catch (e) { error.value = typeof e === 'string' ? e : '读取数据位置失败。' }
 }
})
async function chooseDirectory() {
 try {
  const path = await chooseDataDirectory()
  if (!path) return
  saving.value = true; error.value = ''
  location.value = await dataLocation('data-location-save', { directory: path })
 } catch (e) { error.value = typeof e === 'string' ? e : '更改数据位置失败。' }
 finally { saving.value = false }
}
async function openFolder(folder: 'root' | 'instances') {
 try { await dataLocation('data-folder-open', { folder }); error.value = '' }
 catch (e) { error.value = typeof e === 'string' ? e : '打开文件夹失败。' }
}
async function save() {
 try{if (await store.savePreferences(draft.theme, draft.largeText,readingPreferences(draft.reading),audioPreferences(draft.audio),palettePreference(draft.palette))) emit('close')}catch(e){error.value=e instanceof Error?e.message:'设置无效。'}
}
</script>
<template><DialogFrame :open="open" title="全局设置" description="调整外观、阅读与声音偏好，以及本机数据保存位置。" @close="emit('close')">
 <div class="form-field"><label for="launcher-theme">主题</label><select id="launcher-theme" v-model="draft.theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div>
 <fieldset class="palette-picker"><legend>主题色</legend>
  <label v-for="choice in paletteChoices" :key="choice.value" class="palette-choice" :class="{ active: draft.palette === choice.value }" :data-swatch="choice.value">
   <input v-model="draft.palette" type="radio" name="palette" :value="choice.value" /><span class="swatch" aria-hidden="true"></span><strong>{{ choice.name }}</strong><small>{{ choice.hint }}</small>
  </label>
  <p class="muted">作用于启动器、官方游戏舞台与创作者控制台；游戏舞台在下次启动时生效。</p>
 </fieldset>
 <label class="checkbox-row"><input v-model="draft.largeText" type="checkbox" />使用较大文字</label>
 <details class="play-settings-group"><summary>默认前端阅读偏好</summary><p class="muted">作用于下次启动的官方游戏前端。社区前端可自行选择是否采用。</p><div class="settings-grid"><div class="form-field"><label for="reading-font">对话字号（14–28）</label><input id="reading-font" v-model.number="draft.reading.fontSize" type="number" min="14" max="28" step="1" /></div><div class="form-field"><label for="reading-line-height">对话行距（1.4–2.4）</label><input id="reading-line-height" v-model.number="draft.reading.lineHeight" type="number" min="1.4" max="2.4" step="0.1" /></div></div><label class="checkbox-row"><input v-model="draft.reading.autoFollow" type="checkbox" />靠近底部时自动跟随最新对话</label></details>
 <details class="play-settings-group"><summary>声音偏好</summary>
  <p class="muted">下次启动游戏时生效，供支持音频的游戏界面采用。官方舞台暂未提供音乐与语音播放。</p>
  <div class="form-field"><label for="audio-volume">音量（0–100）</label><input id="audio-volume" v-model.number="draft.audio.volume" type="number" min="0" max="100" step="1" /></div>
  <label class="checkbox-row"><input v-model="draft.audio.muted" type="checkbox" />静音</label>
  <label class="checkbox-row"><input v-model="draft.audio.voiceEnabled" type="checkbox" />启用语音朗读</label>
 </details>
 <div class="settings-section">
  <div class="form-field"><label for="data-directory">当前数据根目录</label><input id="data-directory" :value="store.dataDirectory || '浏览器预览不保存实际实例数据'" readonly /></div>
  <div class="settings-folder-actions"><Button variant="outline" :disabled="!store.real" @click="openFolder('root')">打开文件夹</Button><Button variant="outline" :disabled="!store.real || !location || location.locked || store.busy || saving || store.core.state === 'running'" @click="chooseDirectory">更改数据目录</Button></div>
  <p v-if="location && location.next !== location.current" class="inline-info" role="status">重启后切换到：{{ location.next }}<br />目录选择已保存；旧目录保留，不自动迁移存档。当前游戏仍使用上方目录。重新选择当前目录可取消切换。</p>
  <p v-if="location?.locked" class="muted">数据目录由 PERSPECTRA_LAUNCHER_DATA_DIR 指定，请修改环境变量后重启。</p>
  <p class="muted">选择空目录将建立新的游戏库；选择已有 Perspectra 数据目录可继续使用其中的实例。切换需重启，旧目录中的实例、故事线和记忆不会自动搬迁。</p>
 </div>
 <div class="settings-section">
  <div class="form-field"><label for="instance-directory">实例、存档与角色记忆</label><input id="instance-directory" :value="store.dataDirectory ? store.dataDirectory + '/instances' : '桌面运行时可用'" readonly /></div>
  <Button variant="outline" :disabled="!store.real" @click="openFolder('instances')">打开实例文件夹</Button>
  <p class="muted">启动器配置：根目录中的 launcher.json。预设：preset-settings.json 与 preset-library.json。游戏包保留在载入时的原始位置。</p>
 </div>
 <p v-if="error" role="alert">{{ error }}</p>
 <div class="dialog-actions"><Button variant="outline" :disabled="saving" @click="emit('close')">关闭</Button><Button :disabled="store.busy || saving" @click="save">保存设置</Button></div>
</DialogFrame></template>
