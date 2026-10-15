<script setup lang="ts">
import { computed, ref } from 'vue'
import PlaySettingsDialog from './PlaySettingsDialog.vue'
import RequestInspectorDialog from './RequestInspectorDialog.vue'
import FrontendAuthorizationDialog from './FrontendAuthorizationDialog.vue'
import {
  ArrowRight,
  GitFork,
  Cpu,
  Check,
  AlertTriangle,
  BookOpen,
  Plus,
  Square,
  Sparkles,
  SlidersHorizontal,
  Activity,
  Compass,
  ShieldCheck,
  ShieldAlert,
  Gauge,
  Layers,
  ExternalLink,
} from '@lucide/vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { Button } from './ui/button/index.ts'

defineEmits<{ model: []; preset: []; story: []; import: []; export: []; settings: [] }>()
const store = useLauncherStore()
const playSettingsOpen = ref(false)
const frontendOpen = ref(false)
const inspectorOpen = ref(false)
const inspectorAvailable = computed(() => store.core.state === 'running' && 'instanceId' in store.core && store.core.instanceId === store.selectedInstanceId)
const running = computed(() => store.core.state === 'running')
const validationText = computed(() => ({
  ready: '可以运行',
  degraded: '可以运行，可能降级',
  blocked: '无法运行',
})[store.selectedPackage?.validation.status ?? 'blocked'])
</script>

<template>
  <Transition name="detail-transition" mode="out-in">
    <main v-if="store.selectedPackage && store.currentInstance" :key="store.selectedPackage.id" class="game-detail">
    <!-- Game Header Identity -->
    <section class="game-identity">
      <div class="detail-cover" :class="store.selectedPackage.artwork" aria-hidden="true">
        <BookOpen :size="32" :stroke-width="1.6" />
      </div>
      <div class="identity-copy">
        <div class="identity-meta">
          <span class="package-badge">本地世界包</span>
          <span>v{{ store.selectedPackage.version }}</span>
          <span>{{ store.selectedPackage.genre }}</span>
        </div>
        <h1>{{ store.selectedPackage.title }}</h1>
        <p class="game-subtitle">{{ store.selectedPackage.subtitle }}</p>
      </div>
    </section>

    <p class="game-description">{{ store.selectedPackage.description }}</p>

    <!-- Instance Selector -->
    <div class="instance-row">
      <span class="instance-label"><Layers :size="14" />当前游玩实例</span>
      <select id="instance-select" v-model="store.selectedInstanceId" :disabled="running || store.busy" aria-label="选择游玩实例">
        <option v-for="instance in store.gameInstances" :key="instance.id" :value="instance.id">{{ instance.name }}</option>
      </select>
      <button class="text-button" :disabled="running || store.busy" @click="store.newInstance('第 ' + (store.gameInstances.length + 1) + ' 次游玩')">
        <Plus :size="14" />新建独立实例
      </button>
    </div>

    <!-- Play & Story Hero Card -->
    <section class="continue-section" aria-label="当前故事线">
      <div class="story-summary">
        <div v-if="running" class="running-pill">
          <span class="pulse-light"></span>
          <span>Core 运行中 · 端口 {{ store.real ? '8046' : '模拟' }}</span>
        </div>
        <div class="section-label">
          <GitFork :size="13" />
          <span>当前激活故事线</span>
        </div>
        <h2>{{ store.currentStoryline?.name }}</h2>
        <p>{{ store.real ? '最近保存节点：' + (store.currentNode?.title ?? '尚未保存') : store.currentNode?.title }}</p>
        <div class="progress-meta">
          <span v-if="!store.real" class="progress-badge">第 <strong>{{ store.currentNode?.turn ?? 0 }}</strong> 轮</span>
          <span class="progress-badge">{{ store.currentInstance.storylines.length }} 条分支故事线</span>
          <span v-if="store.currentInstance.lastPlayedAt" class="progress-badge">上次游玩: {{ new Date(store.currentInstance.lastPlayedAt).toLocaleDateString() }}</span>
        </div>
        <p v-if="store.currentStoryline?.source.kind !== 'original'" class="source-note">
          来源：{{ store.currentStoryline?.source.label }} / {{ store.real ? '时刻 ' : '第 ' }}{{ store.currentStoryline?.source.turn }}{{ store.real ? '' : ' 轮' }}
        </p>
      </div>
      <div class="continue-action">
        <Button v-if="running" variant="outline" class="continue-button running" @click="store.stopGame()">
          <Square :size="15" />{{ store.real ? '结束当前游戏' : '结束模拟会话' }}
        </Button>
        <Button v-else class="continue-button" :disabled="store.busy || !store.initialized || store.selectedPackage.validation.status === 'blocked' || !store.currentModel" @click="store.startGame()">
          {{ store.busy ? '正在启动…' : store.currentInstance.lastPlayedAt ? '继续游戏' : '开始游戏' }}
          <ArrowRight :size="16" />
        </Button>
        <button v-if="running && store.real" class="text-button" :disabled="store.busy" @click="store.reopenGame()">
          <ExternalLink :size="13" />重新打开游戏网页
        </button>
        <small>{{ store.real ? '系统浏览器 · Core 权威记忆' : '仅模拟启动预览' }}</small>
      </div>
    </section>

    <p v-if="store.currentInstance?.storyError" role="alert">{{ store.currentInstance.storyError }}</p>

    <!-- Grouped Configurations -->
    <div class="settings-groups">
      <!-- Group 1: AI & Characters -->
      <section class="settings-group" aria-label="AI 与角色生态">
        <div class="group-header">
          <div class="group-title"><Sparkles :size="16" /><span>AI 与角色生态</span></div>
          <span class="group-caption">大模型推理接口、提示词预设与请求探查</span>
        </div>
        <div class="configuration-rows">
          <!-- Model Row -->
          <div class="configuration-row">
            <div class="row-icon-box"><Cpu :size="19" /></div>
            <div class="configuration-content">
              <strong>
                模型设置
                <span v-if="store.real && store.currentRealModel.thinkingLevel" class="card-badge">
                  思考: {{ ({ off: '关闭', low: '低', medium: '中', high: '高' } as const)[store.currentRealModel.thinkingLevel] }}
                </span>
              </strong>
              <p>
                {{ store.currentModel?.label ?? '当前没有可用模型' }}
                <span v-if="store.currentModel">
                  {{ store.currentInstance.model.overridesEnabled ? ' · 已开启多角色独立映射' : ' · 所有角色继承此默认模型' }}
                </span>
              </p>
            </div>
            <button class="text-button" :disabled="running || store.busy" @click="store.currentModel ? $emit('model') : $emit('settings')">
              {{ store.currentModel ? '修改' : '前往模型设置' }}<ArrowRight :size="14" />
            </button>
          </div>

          <!-- Character Preset Row -->
          <div v-if="store.real" class="configuration-row">
            <div class="row-icon-box"><SlidersHorizontal :size="19" /></div>
            <div class="configuration-content">
              <strong>角色预设与人设</strong>
              <p>附加世界观提示词、语气约束与独立生成参数，支持导入导出预设库</p>
            </div>
            <button class="text-button" :disabled="running || store.busy" @click="$emit('preset')">
              定制预设<ArrowRight :size="14" />
            </button>
          </div>

          <!-- Request Inspector Row -->
          <div v-if="store.real" class="configuration-row">
            <div class="row-icon-box"><Activity :size="19" /></div>
            <div class="configuration-content">
              <strong>
                实际模型请求探查
                <span v-if="inspectorAvailable" class="card-badge active-pulse">
                  <span class="pulse-light"></span>实时可用
                </span>
              </strong>
              <p>{{ inspectorAvailable ? '游戏进行中，可实时查看角色上下文装配与最终 Prompt' : '游戏运行后可实时探查角色上下文、预设展开与发送至大模型的完整请求' }}</p>
            </div>
            <button class="text-button" :disabled="!inspectorAvailable" @click="inspectorOpen = true">
              查看探查器<ArrowRight :size="14" />
            </button>
          </div>
        </div>
      </section>

      <!-- Group 2: World & System Environment -->
      <section class="settings-group" aria-label="世界与系统环境">
        <div class="group-header">
          <div class="group-title"><Compass :size="16" /><span>世界与系统环境</span></div>
          <span class="group-caption">故事线分支、安全沙箱与引擎调度预算</span>
        </div>
        <div class="configuration-rows">
          <!-- Storyline Row -->
          <div class="configuration-row">
            <div class="row-icon-box"><GitFork :size="19" /></div>
            <div class="configuration-content">
              <strong>故事线分支管理</strong>
              <p>保存完整世界节点，保留过往记忆，随时开启另一种未来的探索</p>
            </div>
            <div class="story-actions">
              <button class="text-button" :disabled="!store.real || store.busy || running" @click="$emit('import')">导入存档</button>
              <button class="text-button" :disabled="!store.real || store.busy || Boolean(store.currentInstance?.storyError)" @click="$emit('export')">导出存档</button>
              <button class="text-button" :disabled="store.busy" @click="$emit('story')">管理分支<ArrowRight :size="14" /></button>
            </div>
          </div>

          <!-- Frontend Security Row -->
          <div v-if="store.real" class="configuration-row">
            <div class="row-icon-box">
              <ShieldCheck v-if="store.currentFrontend?.mode === 'trusted'" :size="19" />
              <ShieldAlert v-else :size="19" />
            </div>
            <div class="configuration-content">
              <strong>
                游戏前端与安全沙箱
                <span class="card-badge">
                  {{ store.currentFrontend?.mode === 'trusted' ? '已信任授权' : store.currentFrontend?.kind === 'default' ? '官方默认模板' : '受限沙箱运行' }}
                </span>
              </strong>
              <p>{{ store.currentFrontend?.mode === 'trusted' ? '当前自定义前端代码与完整权限已由你明确授权' : store.currentFrontend?.kind === 'default' ? '采用系统内置官方默认舞台模板，保障沙箱隔离' : '自包含前端运行在默认沙箱中' }}</p>
            </div>
            <button class="text-button" :disabled="store.busy" @click="frontendOpen = true">
              检查权限<ArrowRight :size="14" />
            </button>
          </div>

          <!-- Play Settings / Budget Row -->
          <div class="configuration-row">
            <div class="row-icon-box"><Gauge :size="19" /></div>
            <div class="configuration-content">
              <strong>引擎调度预算</strong>
              <p>{{ store.currentPlaySettings.maximumWaves }} 波循环上限 · {{ store.currentPlaySettings.maximumNpcCalls }} 次调用预算 · {{ store.currentPlaySettings.reactionDeadlineSeconds }} 秒超时限制</p>
            </div>
            <button class="text-button" :disabled="running || store.busy" @click="playSettingsOpen = true">
              调整预算<ArrowRight :size="14" />
            </button>
          </div>
        </div>
      </section>
    </div>

    <!-- Bottom Actions -->
    <div class="detail-bottom">
      <div class="validation" :class="store.selectedPackage.validation.status">
        <Check v-if="store.selectedPackage.validation.status === 'ready'" :size="15" />
        <AlertTriangle v-else :size="15" />
        <span>{{ validationText }}<small>{{ store.real ? ' · 本机环境已校验' : ' · 模拟校验' }}</small></span>
      </div>
    </div>

      <p v-for="issue in store.selectedPackage.validation.issues" :key="issue" class="validation-issue">{{ issue }}</p>
    </main>

    <main v-else key="empty" class="empty-state">
      <BookOpen :size="36" />
      <h1>{{ store.busy ? '正在读取本机实例…' : '载入一个世界包，开始你的故事。' }}</h1>
      <p v-if="!store.initialized">本机初始化未完成。</p>
      <Button v-if="store.real && !store.initialized" :disabled="store.busy" @click="store.initialize()">重试初始化</Button>
      <Button v-if="store.selectedPackage && !store.currentInstance" :disabled="store.busy" @click="store.newInstance('第一次游玩')">创建实例</Button>
    </main>
  </Transition>

  <!-- Dialogs outside transition -->
  <RequestInspectorDialog :open="inspectorOpen && running" :instance-id="store.selectedInstanceId" :characters="store.presetCharacters" @close="inspectorOpen = false" />
  <PlaySettingsDialog :open="playSettingsOpen" @close="playSettingsOpen = false" />
  <FrontendAuthorizationDialog :open="frontendOpen" @close="frontendOpen = false" />
</template>

<style scoped>
.story-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 12px; }
</style>
