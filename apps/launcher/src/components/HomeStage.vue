<script setup lang="ts">
import { computed } from 'vue'
import {
  Ellipsis,
  ExternalLink,
  LayoutList,
  Play,
  ShieldAlert,
  ShieldCheck,
  Square,
  Cpu,
  GitFork,
  ScanEye,
} from '@lucide/vue'
import { useLauncherStore } from '../stores/launcher.ts'

/** 主屏：封面铺满，底部渐变托住包名、状态标签和启动按钮。 */
defineEmits<{ openDrawer: [section?: 'model' | 'frontend' | 'story']; load: []; lens: [packageId: string] }>()
const store = useLauncherStore()
const pack = computed(() => store.selectedPackage)
const summary = computed(() => store.stageSummary)
const frontendLabel = computed(
  () =>
    ({ sandbox: '沙箱', trusted: '已信任前端', default: '官方模板', unknown: '检查前端中' })[summary.value.frontend],
)
/** 透视只读包源，不需要实例；包校验失败时不可用，并在提示里写出错误。 */
const lensBlocked = computed(() => pack.value?.validation.status === 'blocked')
const lensTitle = computed(() =>
  lensBlocked.value
    ? '包校验失败，不能透视：' + (pack.value?.validation.issues.join('；') || '未知错误')
    : '不开游戏，查看这个包的全部设置',
)
const playLabel = computed(() =>
  store.busy ? '正在启动…' : store.currentInstance?.lastPlayedAt ? '继续游戏' : '开始游戏',
)
</script>

<template>
  <main class="home-stage" :class="pack?.artwork">
    <img v-if="pack?.cover" class="stage-art" :src="pack.cover" alt="" />
    <div v-else class="stage-art stage-fallback" aria-hidden="true">
      <span v-if="pack">{{ pack.title.slice(0, 1) }}</span>
    </div>
    <div class="stage-shade" aria-hidden="true"></div>

    <section v-if="pack && store.currentInstance" class="stage-info" aria-label="当前游戏">
      <h1 class="stage-title">{{ pack.title }}</h1>
      <p v-if="pack.subtitle" class="stage-subtitle">{{ pack.subtitle }}</p>
      <div class="stage-chips">
        <button class="stage-chip" title="故事线与存档" @click="$emit('openDrawer', 'story')">
          <GitFork :size="13" />{{ summary.storyline }}
        </button>
        <button class="stage-chip" title="模型设置" @click="$emit('openDrawer', 'model')">
          <Cpu :size="13" />{{ summary.model }}
        </button>
        <button
          class="stage-chip"
          :class="{ warn: summary.frontend === 'sandbox', trusted: summary.frontend === 'trusted' }"
          title="前端权限"
          @click="$emit('openDrawer', 'frontend')"
        >
          <ShieldCheck v-if="summary.frontend === 'trusted' || summary.frontend === 'default'" :size="13" /><ShieldAlert
            v-else
            :size="13"
          />{{ frontendLabel }}
        </button>
      </div>
      <p v-if="!store.running && summary.blockedReason" class="stage-blocked" role="status">
        {{ summary.blockedReason }}
      </p>
      <ul v-if="pack.validation.issues.length" class="stage-issues">
        <li v-for="issue in pack.validation.issues" :key="issue">{{ issue }}</li>
      </ul>
    </section>

    <section v-else class="stage-empty">
      <h1 class="stage-title">{{ store.busy ? '正在读取本机实例…' : '载入一个世界包，开始你的故事' }}</h1>
      <p v-if="!store.initialized" class="stage-blocked">本机初始化未完成。</p>
      <div class="stage-actions">
        <button
          v-if="store.real && !store.initialized"
          class="stage-play"
          :disabled="store.busy"
          @click="store.initialize()"
        >
          重试初始化
        </button>
        <button
          v-else-if="pack && !store.currentInstance"
          class="stage-play"
          :disabled="store.busy"
          @click="store.newInstance('第一次游玩')"
        >
          创建实例
        </button>
        <button
          v-else-if="!pack"
          class="stage-play"
          :disabled="store.busy || !store.initialized"
          @click="$emit('load')"
        >
          载入世界包
        </button>
        <span v-if="pack" class="stage-lens" :title="lensTitle">
          <button class="stage-ghost" :disabled="lensBlocked" @click="$emit('lens', pack.id)">
            <ScanEye :size="15" />透视
          </button>
        </span>
      </div>
    </section>

    <div v-if="pack && store.currentInstance" class="stage-actions stage-corner">
      <template v-if="store.running">
        <span class="stage-live" role="status"><span class="pulse-light"></span>游戏运行中</span>
        <button v-if="store.real" class="stage-ghost" :disabled="store.busy" @click="store.reopenGame()">
          <ExternalLink :size="15" />回到游戏页面
        </button>
        <button class="stage-ghost" :disabled="store.busy" @click="store.openCreator()">
          <LayoutList :size="15" />打开创作者页面
        </button>
      </template>
      <span class="stage-lens" :title="lensTitle">
        <button class="stage-ghost" :disabled="lensBlocked" @click="$emit('lens', pack.id)">
          <ScanEye :size="15" />透视
        </button>
      </span>
      <button class="stage-more" aria-label="本局设置" title="本局设置" @click="$emit('openDrawer')">
        <Ellipsis :size="18" />
      </button>
      <button v-if="store.running" class="stage-play stop" :disabled="store.busy" @click="store.stopGame()">
        <Square :size="15" fill="currentColor" />结束游戏
      </button>
      <button
        v-else
        class="stage-play"
        :disabled="store.busy || Boolean(summary.blockedReason)"
        @click="store.startGame()"
      >
        <Play :size="17" fill="currentColor" />{{ playLabel }}
      </button>
    </div>
  </main>
</template>

<style scoped>
.home-stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: var(--stage);
  color: var(--stage-text);
}
.stage-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.stage-fallback {
  background: var(--tone, var(--stage));
  display: grid;
  place-items: center;
}
.stage-fallback span {
  font-family: var(--font-display);
  font-size: min(38vw, 360px);
  font-weight: 700;
  color: rgba(255, 255, 255, 0.07);
}
.stage-shade {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(0deg, rgba(12, 8, 10, 0.78) 0%, rgba(12, 8, 10, 0.32) 26%, transparent 46%);
}
.stage-info,
.stage-empty {
  position: absolute;
  left: 92px;
  bottom: 30px;
  right: 420px;
  z-index: 5;
  display: grid;
  gap: 10px;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.55);
}
.stage-empty {
  right: 92px;
}
.stage-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(26px, 3.4vw, 40px);
  line-height: 1.15;
  letter-spacing: 0.02em;
}
.stage-subtitle {
  margin: -4px 0 0;
  color: var(--stage-muted);
  font-size: 14px;
}
.stage-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.stage-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 11px;
  border-radius: 999px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--stage-text);
  text-shadow: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.22);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.stage-chip:hover {
  background: rgba(255, 255, 255, 0.26);
}
.stage-chip.warn {
  background: rgba(240, 160, 90, 0.3);
  border-color: rgba(255, 190, 130, 0.55);
}
.stage-chip.trusted {
  background: rgba(240, 191, 114, 0.22);
}
.stage-blocked {
  margin: 0;
  font-size: 13px;
  color: #ffd2a8;
}
.stage-issues {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: #ffd2a8;
}
.stage-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.stage-corner {
  position: absolute;
  right: 28px;
  bottom: 30px;
  z-index: 6;
  flex-wrap: wrap;
  justify-content: flex-end;
  max-width: 400px;
}
.stage-play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 168px;
  height: 52px;
  padding: 0 26px;
  border: 0;
  border-radius: 12px;
  cursor: pointer;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.04em;
  background: var(--lamp);
  color: var(--lamp-ink);
  box-shadow: 0 10px 28px color-mix(in srgb, var(--lamp-deep) 45%, transparent);
  transition:
    transform 0.15s,
    filter 0.15s;
}
.stage-play:hover:not(:disabled) {
  transform: translateY(-1px);
  filter: brightness(1.06);
}
.stage-play:disabled {
  cursor: not-allowed;
  filter: grayscale(0.6) brightness(0.8);
  box-shadow: none;
}
.stage-play.stop {
  background: rgba(255, 255, 255, 0.9);
  color: #2a1a1f;
}
.stage-more,
.stage-ghost {
  height: 52px;
  border-radius: 12px;
  cursor: pointer;
  color: var(--stage-text);
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.24);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.stage-more {
  width: 52px;
  display: grid;
  place-items: center;
}
.stage-ghost {
  height: 40px;
  padding: 0 14px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.stage-more:hover,
.stage-ghost:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.26);
}
.stage-ghost:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
/* 禁用按钮收不到指针事件；提示挂在外层，校验错误照样能悬停看到。 */
.stage-lens {
  display: inline-flex;
}
.stage-live {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #b9f0cf;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
  flex-basis: 100%;
  justify-content: flex-end;
}
@media (max-width: 980px) {
  .stage-info {
    right: 28px;
    bottom: 112px;
  }
  .stage-corner {
    max-width: none;
    left: 92px;
  }
}
</style>
