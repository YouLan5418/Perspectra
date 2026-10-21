<script setup lang="ts">
import { isTauri } from '@tauri-apps/api/core'
import { Minus, Settings, Square, X } from '@lucide/vue'

/** 自绘标题栏：整条可拖动，压在封面上；浏览器预览里窗口按钮不做事。 */
defineEmits<{ openSettings: [] }>()
const desktop = isTauri()
async function windowAction(action: 'minimize' | 'toggleMaximize' | 'close') {
  if (!desktop) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow()[action]()
}
</script>

<template>
  <header class="title-bar" data-tauri-drag-region>
    <span class="title-mark" data-tauri-drag-region
      ><span class="title-icon" aria-hidden="true">P</span>Perspectra</span
    >
    <div class="title-actions">
      <button class="title-button" aria-label="全局设置" title="全局设置" @click="$emit('openSettings')">
        <Settings :size="16" />
      </button>
      <span class="title-divider" aria-hidden="true"></span>
      <button class="title-button" aria-label="最小化" @click="windowAction('minimize')"><Minus :size="16" /></button>
      <button class="title-button" aria-label="最大化或还原" @click="windowAction('toggleMaximize')">
        <Square :size="12" />
      </button>
      <button class="title-button close" aria-label="关闭" @click="windowAction('close')"><X :size="16" /></button>
    </div>
  </header>
</template>

<style scoped>
.title-bar {
  position: absolute;
  inset: 0 0 auto 0;
  height: 40px;
  z-index: 30;
  display: flex;
  align-items: center;
  padding: 0 6px 0 16px;
  color: var(--stage-text);
  background: linear-gradient(180deg, rgba(10, 8, 9, 0.55), transparent);
  user-select: none;
}
.title-mark {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-weight: 700;
  letter-spacing: 0.04em;
  font-size: 14px;
}
.title-icon {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  font-size: 12px;
  background: var(--lamp);
  color: var(--lamp-ink);
}
.title-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
}
.title-button {
  width: 38px;
  height: 30px;
  border: 0;
  border-radius: 6px;
  display: grid;
  place-items: center;
  background: transparent;
  color: inherit;
  opacity: 0.85;
  cursor: pointer;
}
.title-button:hover {
  background: rgba(255, 255, 255, 0.14);
  opacity: 1;
}
.title-button.close:hover {
  background: #c42b1c;
}
.title-divider {
  width: 1px;
  height: 16px;
  margin: 0 6px;
  background: rgba(255, 255, 255, 0.25);
}
</style>
