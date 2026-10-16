<script setup lang="ts">
import { computed, ref } from 'vue'
import { useStorage } from '@vueuse/core'
import PlaySettingsDialog from './PlaySettingsDialog.vue'
import RequestInspectorDialog from './RequestInspectorDialog.vue'
import FrontendAuthorizationDialog from './FrontendAuthorizationDialog.vue'
import {
  ArrowRight,
  Play,
  GitFork,
  Cpu,
  Check,
  AlertTriangle,
  BookOpen,
  Plus,
  Square,
  SlidersHorizontal,
  Activity,
  ShieldCheck,
  ShieldAlert,
  Gauge,
  ExternalLink,
  ChevronDown,
  Download,
  Upload,
} from '@lucide/vue'
import { useLauncherStore } from '../stores/launcher.ts'

defineEmits<{ model: []; preset: []; story: []; import: []; export: []; settings: [] }>()
const store = useLauncherStore()
const playSettingsOpen = ref(false)
const frontendOpen = ref(false)
const inspectorOpen = ref(false)
/** 引擎与创作者工具默认收起；玩家展开后记住选择。 */
const advancedOpen = useStorage('perspectra.launcher.advanced-open', false)
const inspectorAvailable = computed(() => store.core.state === 'running' && 'instanceId' in store.core && store.core.instanceId === store.selectedInstanceId)
const running = computed(() => store.core.state === 'running')
const validationText = computed(() => ({
  ready: '可以运行',
  degraded: '可以运行，可能降级',
  blocked: '无法运行',
})[store.selectedPackage?.validation.status ?? 'blocked'])
const playBlockedReason = computed(() => {
  if (!store.initialized) return '本机初始化未完成'
  if (store.selectedPackage?.validation.status === 'blocked') return '世界包未通过校验'
  if (!store.currentModel) return '还没有可用模型，请先完成模型设置'
  return ''
})
const lastPlayed = computed(() => store.currentInstance?.lastPlayedAt ? new Date(store.currentInstance.lastPlayedAt).toLocaleDateString() : '')
const thinkingLabel = { off: '关闭', low: '低', medium: '中', high: '高' } as const
</script>

<template>
  <Transition name="detail-transition" mode="out-in">
    <main v-if="store.selectedPackage && store.currentInstance" :key="store.selectedPackage.id" class="game-detail">
      <!-- 首屏：世界包封面与开始游戏 -->
      <section class="hero" :class="[store.selectedPackage.artwork, { 'has-cover': store.selectedPackage.cover }]" aria-label="游戏封面">
        <img v-if="store.selectedPackage.cover" class="hero-art" :src="store.selectedPackage.cover" alt="" />
        <div v-else class="hero-art hero-fallback" aria-hidden="true">
          <span class="hero-glyph">{{ store.selectedPackage.title.slice(0, 1) }}</span>
        </div>
        <div class="hero-shade" aria-hidden="true"></div>

        <div class="hero-body">
          <div class="hero-meta">
            <span v-if="store.selectedPackage.genre">{{ store.selectedPackage.genre }}</span>
            <span>v{{ store.selectedPackage.version }}</span>
            <span class="validation" :class="store.selectedPackage.validation.status">
              <Check v-if="store.selectedPackage.validation.status === 'ready'" :size="13" />
              <AlertTriangle v-else :size="13" />
              {{ validationText }}
            </span>
          </div>
          <h1 class="hero-title">{{ store.selectedPackage.title }}</h1>
          <p v-if="store.selectedPackage.subtitle" class="hero-subtitle">{{ store.selectedPackage.subtitle }}</p>

          <div class="hero-actions">
            <button v-if="running" class="play-button running" @click="store.stopGame()">
              <Square :size="16" fill="currentColor" />{{ store.real ? '结束当前游戏' : '结束模拟会话' }}
            </button>
            <button v-else class="play-button" :disabled="store.busy || Boolean(playBlockedReason)" @click="store.startGame()">
              <Play :size="18" fill="currentColor" />
              {{ store.busy ? '正在启动…' : store.currentInstance.lastPlayedAt ? '继续游戏' : '开始游戏' }}
            </button>
            <button v-if="running && store.real" class="hero-ghost" :disabled="store.busy" @click="store.reopenGame()">
              <ExternalLink :size="15" />重新打开游戏网页
            </button>
            <button class="hero-ghost" :disabled="store.busy" @click="$emit('story')">
              <GitFork :size="15" />故事线与存档
            </button>
          </div>
          <p class="hero-hint">
            <template v-if="running"><span class="pulse-light"></span>{{ store.real ? 'Core 运行中 · 游戏在系统浏览器中打开' : '模拟会话进行中' }}</template>
            <template v-else-if="playBlockedReason">{{ playBlockedReason }}</template>
            <template v-else>{{ store.real ? '在系统浏览器中打开 · 角色记忆由 Core 保存' : '浏览器预览 · 仅模拟启动' }}</template>
          </p>
          <ul v-if="store.selectedPackage.validation.issues.length" class="hero-issues">
            <li v-for="issue in store.selectedPackage.validation.issues" :key="issue">{{ issue }}</li>
          </ul>
        </div>
      </section>

      <div class="detail-body">
        <p v-if="store.currentInstance.storyError" class="story-error" role="alert">{{ store.currentInstance.storyError }}</p>

        <!-- 当前进度 -->
        <section class="progress-card" aria-label="当前进度">
          <div class="progress-main">
            <span class="eyebrow">当前故事线</span>
            <h2>{{ store.currentStoryline?.name }}</h2>
            <p class="progress-node">{{ store.real ? '最近保存节点：' + (store.currentNode?.title ?? '尚未保存') : store.currentNode?.title }}</p>
            <div class="progress-chips">
              <span v-if="!store.real">第 <strong>{{ store.currentNode?.turn ?? 0 }}</strong> 轮</span>
              <span>{{ store.currentInstance.storylines.length }} 条故事线</span>
              <span v-if="lastPlayed">上次游玩 {{ lastPlayed }}</span>
            </div>
            <p v-if="store.currentStoryline?.source.kind !== 'original'" class="progress-source">
              来源：{{ store.currentStoryline?.source.label }} / {{ store.real ? '时刻 ' : '第 ' }}{{ store.currentStoryline?.source.turn }}{{ store.real ? '' : ' 轮' }}
            </p>
          </div>
          <div class="progress-instance">
            <label for="instance-select" class="eyebrow">游玩实例</label>
            <select id="instance-select" v-model="store.selectedInstanceId" :disabled="running || store.busy">
              <option v-for="instance in store.gameInstances" :key="instance.id" :value="instance.id">{{ instance.name }}</option>
            </select>
            <button class="link-button" :disabled="running || store.busy" @click="store.newInstance('第 ' + (store.gameInstances.length + 1) + ' 次游玩')">
              <Plus :size="14" />新建独立实例
            </button>
          </div>
        </section>

        <div class="detail-columns">
          <section v-if="store.selectedPackage.description" class="about" aria-label="关于这个世界">
            <h2 class="section-title">关于这个世界</h2>
            <p>{{ store.selectedPackage.description }}</p>
          </section>

          <section class="prep" aria-label="游玩准备">
            <h2 class="section-title">游玩准备</h2>
            <div class="prep-row">
              <Cpu :size="18" class="prep-icon" />
              <div class="prep-copy">
                <strong>模型</strong>
                <span>
                  {{ store.currentModel?.label ?? '尚未设置' }}<template v-if="store.real && store.currentRealModel.thinkingLevel"> · 思考{{ thinkingLabel[store.currentRealModel.thinkingLevel] }}</template>
                </span>
              </div>
              <button class="link-button" :disabled="running || store.busy" @click="store.currentModel ? $emit('model') : $emit('settings')">
                {{ store.currentModel ? '修改' : '去设置' }}<ArrowRight :size="14" />
              </button>
            </div>
            <div class="prep-row">
              <GitFork :size="18" class="prep-icon" />
              <div class="prep-copy">
                <strong>存档</strong>
                <span>导入朋友的故事，或导出你的进度</span>
              </div>
              <div class="prep-actions">
                <button class="link-button" :disabled="!store.real || store.busy || running" @click="$emit('import')"><Download :size="14" />导入</button>
                <button class="link-button" :disabled="!store.real || store.busy || Boolean(store.currentInstance.storyError)" @click="$emit('export')"><Upload :size="14" />导出</button>
              </div>
            </div>
          </section>
        </div>

        <!-- 引擎与创作者工具：默认收起 -->
        <details class="advanced" :open="advancedOpen" @toggle="advancedOpen = ($event.target as HTMLDetailsElement).open">
          <summary>
            <span class="advanced-title">引擎与创作者工具</span>
            <span class="advanced-caption">角色预设、请求探查、前端权限与调度预算</span>
            <ChevronDown :size="16" class="advanced-chevron" />
          </summary>
          <div class="tool-grid">
            <div v-if="store.real" class="tool-tile">
              <SlidersHorizontal :size="17" class="tool-icon" />
              <div class="tool-copy">
                <strong>角色预设与人设</strong>
                <p>附加世界观提示词、语气约束与独立生成参数，支持导入导出预设库</p>
              </div>
              <button class="link-button" :disabled="running || store.busy" @click="$emit('preset')">定制<ArrowRight :size="14" /></button>
            </div>

            <div v-if="store.real" class="tool-tile">
              <Activity :size="17" class="tool-icon" />
              <div class="tool-copy">
                <strong>模型请求探查<span v-if="inspectorAvailable" class="live-badge"><span class="pulse-light"></span>实时</span></strong>
                <p>{{ inspectorAvailable ? '查看角色上下文装配与最终发送的请求' : '游戏运行后可查看角色上下文、预设展开与完整请求' }}</p>
              </div>
              <button class="link-button" :disabled="!inspectorAvailable" @click="inspectorOpen = true">查看<ArrowRight :size="14" /></button>
            </div>

            <div v-if="store.real" class="tool-tile">
              <ShieldCheck v-if="store.currentFrontend?.mode === 'trusted'" :size="17" class="tool-icon" />
              <ShieldAlert v-else :size="17" class="tool-icon" />
              <div class="tool-copy">
                <strong>游戏前端权限<span class="plain-badge">{{ store.currentFrontend?.mode === 'trusted' ? '已信任' : store.currentFrontend?.kind === 'default' ? '官方模板' : '沙箱' }}</span></strong>
                <p>{{ store.currentFrontend?.mode === 'trusted' ? '当前自定义前端代码与完整权限已由你明确授权' : store.currentFrontend?.kind === 'default' ? '采用内置官方舞台模板，运行在沙箱中' : '自包含前端运行在默认沙箱中' }}</p>
              </div>
              <button class="link-button" :disabled="store.busy" @click="frontendOpen = true">检查<ArrowRight :size="14" /></button>
            </div>

            <div class="tool-tile">
              <Gauge :size="17" class="tool-icon" />
              <div class="tool-copy">
                <strong>引擎调度预算</strong>
                <p>{{ store.currentPlaySettings.maximumWaves }} 波循环上限 · {{ store.currentPlaySettings.maximumNpcCalls }} 次调用预算 · {{ store.currentPlaySettings.reactionDeadlineSeconds }} 秒超时</p>
              </div>
              <button class="link-button" :disabled="running || store.busy" @click="playSettingsOpen = true">调整<ArrowRight :size="14" /></button>
            </div>
          </div>
        </details>
      </div>
    </main>

    <main v-else key="empty" class="empty-state">
      <BookOpen :size="36" :stroke-width="1.4" />
      <h1>{{ store.busy ? '正在读取本机实例…' : '载入一个世界包，开始你的故事。' }}</h1>
      <p v-if="!store.initialized">本机初始化未完成。</p>
      <button v-if="store.real && !store.initialized" class="play-button compact" :disabled="store.busy" @click="store.initialize()">重试初始化</button>
      <button v-if="store.selectedPackage && !store.currentInstance" class="play-button compact" :disabled="store.busy" @click="store.newInstance('第一次游玩')">创建实例</button>
    </main>
  </Transition>

  <!-- Dialogs outside transition -->
  <RequestInspectorDialog :open="inspectorOpen && running" :instance-id="store.selectedInstanceId" :characters="store.presetCharacters" @close="inspectorOpen = false" />
  <PlaySettingsDialog :open="playSettingsOpen" @close="playSettingsOpen = false" />
  <FrontendAuthorizationDialog :open="frontendOpen" @close="frontendOpen = false" />
</template>
