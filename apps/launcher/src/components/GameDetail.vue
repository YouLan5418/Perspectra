<script setup lang="ts">
import { computed, ref } from 'vue'
import PlaySettingsDialog from './PlaySettingsDialog.vue'
import RequestInspectorDialog from './RequestInspectorDialog.vue'
import FrontendAuthorizationDialog from './FrontendAuthorizationDialog.vue'
import { ArrowRight, GitFork, Cpu, Download, Upload, Check, AlertTriangle, BookOpen, Plus, Square } from '@lucide/vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { Button } from './ui/button/index.ts'
defineEmits<{ model: []; preset: []; story: []; import: []; export: []; settings: [] }>()
const store = useLauncherStore()
const playSettingsOpen=ref(false)
const frontendOpen=ref(false),inspectorOpen=ref(false)
const inspectorAvailable = computed(() => store.core.state === 'running' && 'instanceId' in store.core && store.core.instanceId === store.selectedInstanceId)
const running = computed(() => store.core.state === 'running')
const validationText = computed(() => ({ ready: '可以运行', degraded: '可以运行，可能降级', blocked: '无法运行' })[store.selectedPackage?.validation.status ?? 'blocked'])
</script>
<template>
  <main v-if="store.selectedPackage && store.currentInstance" class="game-detail">
    <section class="game-identity">
      <div class="detail-cover" :class="store.selectedPackage.artwork" aria-hidden="true"><BookOpen :size="30" :stroke-width="1.5" /></div>
      <div class="identity-copy"><div class="identity-meta"><span class="package-badge">本地游戏包</span><span>v{{ store.selectedPackage.version }}</span><span>{{ store.selectedPackage.genre }}</span></div><h1>{{ store.selectedPackage.title }}</h1><p class="game-subtitle">{{ store.selectedPackage.subtitle }}</p></div>
    </section>
    <p class="game-description">{{ store.selectedPackage.description }}</p>
    <div class="instance-row"><label for="instance-select">当前实例</label><select id="instance-select" v-model="store.selectedInstanceId" :disabled="running || store.busy"><option v-for="instance in store.gameInstances" :key="instance.id" :value="instance.id">{{ instance.name }}</option></select><button class="text-button" :disabled="running || store.busy" @click="store.newInstance('第 ' + (store.gameInstances.length + 1) + ' 次游玩')"><Plus :size="14" />新建实例</button></div>
    <section class="continue-section" aria-label="当前故事线">
      <div class="story-summary"><div class="section-label">当前故事线</div><h2>{{ store.currentStoryline?.name }}</h2><p>{{ store.real ? '最近保存节点：' + (store.currentNode?.title ?? '尚未保存') : store.currentNode?.title }}</p><div class="progress-meta"><span v-if="!store.real">第 <strong>{{ store.currentNode?.turn ?? 0 }}</strong> 轮</span><span v-if="!store.real" class="divider"></span><span>{{ store.currentInstance.storylines.length }} 条故事线</span></div><p v-if="store.currentStoryline?.source.kind !== 'original'" class="source-note">来源：{{ store.currentStoryline?.source.label }} / {{ store.real ? '时刻 ' : '第 ' }}{{ store.currentStoryline?.source.turn }}{{ store.real ? '' : ' 轮' }}</p></div>
      <div class="continue-action"><Button v-if="running" variant="outline" class="continue-button" @click="store.stopGame()"><Square :size="15" />{{ store.real ? '结束游戏' : '结束模拟会话' }}</Button><Button v-else class="continue-button" :disabled="store.busy || !store.initialized || store.selectedPackage.validation.status === 'blocked' || !store.currentModel" @click="store.startGame()">{{ store.busy ? '正在处理…' : store.currentInstance.lastPlayedAt ? '继续游戏' : '开始游戏' }}<ArrowRight :size="17" /></Button><button v-if="running && store.real" class="text-button" :disabled="store.busy" @click="store.reopenGame()">重新打开游戏</button><small>{{ store.real ? '系统浏览器 · Core 记忆' : '仅模拟启动' }}</small></div>
    </section>
    <p v-if="store.currentInstance?.storyError" role="alert">{{ store.currentInstance.storyError }}</p>
    <div class="section-heading"><h2>游玩配置</h2><span>实例配置与包级运行参数</span></div>
    <div class="configuration-rows">
      <div class="configuration-row"><Cpu :size="19" /><div><strong>运行参数</strong><p>{{ store.currentPlaySettings.maximumWaves }} 波 · {{ store.currentPlaySettings.maximumNpcCalls }} 次调用预算 · {{ store.currentPlaySettings.reactionDeadlineSeconds }} 秒反应周期 · 此包所有实例</p></div><button class="text-button" :disabled="running || store.busy" @click="playSettingsOpen=true">配置<ArrowRight :size="14" /></button></div>
      <div class="configuration-row"><Cpu :size="19" /><div><strong>模型</strong><p>{{ store.currentModel?.label ?? '当前没有可用模型' }}<span v-if="store.real"> · 思考：{{ store.currentRealModel.thinkingLevel ? ({off:'关闭',low:'低',medium:'中',high:'高'} as const)[store.currentRealModel.thinkingLevel] : '默认' }}</span><span v-if="store.currentModel">{{ store.currentInstance.model.overridesEnabled ? ' · 启用角色映射' : ' · 所有角色继承默认' }}</span></p></div><button class="text-button" :disabled="running || store.busy" @click="store.currentModel ? $emit('model') : $emit('settings')">{{ store.currentModel ? '修改' : '前往模型设置' }}<ArrowRight :size="14" /></button></div>
      <div v-if="store.real" class="configuration-row"><Cpu :size="19" /><div><strong>角色预设</strong><p>附加提示与生成参数</p></div><button class="text-button" :disabled="running || store.busy" @click="$emit('preset')">修改<ArrowRight :size="14" /></button></div>
      <div v-if="store.real" class="configuration-row"><AlertTriangle :size="19" /><div><strong>游戏前端</strong><p>{{ store.currentFrontend?.mode==='trusted'?'当前内容已授权':store.currentFrontend?.kind==='default'?'官方默认模板':'默认沙箱运行' }}</p></div><button class="text-button" :disabled="store.busy" @click="frontendOpen=true">权限<ArrowRight :size="14" /></button></div>

      <div class="configuration-row"><GitFork :size="19" /><div><strong>故事线</strong><p>保存完整节点，保留过去，开启另一种未来。</p></div><button class="text-button" :disabled="store.busy" @click="$emit('story')">管理<ArrowRight :size="14" /></button></div>
      <div v-if="store.real" class="configuration-row"><Cpu :size="19" /><div><strong>实际模型请求</strong><p>角色上下文、预设展开与最终请求</p></div><button class="text-button" :disabled="!inspectorAvailable" @click="inspectorOpen=true">查看<ArrowRight :size="14" /></button></div>
    </div>
    <div class="detail-bottom"><div class="validation" :class="store.selectedPackage.validation.status"><Check v-if="store.selectedPackage.validation.status === 'ready'" :size="14" /><AlertTriangle v-else :size="14" /><span>{{ validationText }}<small>{{ store.real ? ' · 已校验' : ' · 模拟校验' }}</small></span></div><div class="share-actions"><button class="text-button" :disabled="!store.real || running || store.busy" @click="$emit('import')"><Upload :size="15" />导入故事线</button><button class="text-button" :disabled="!store.real || running || store.busy || !store.currentHistory.length || !!store.currentInstance.storyError" @click="$emit('export')"><Download :size="15" />导出故事线</button></div></div>
    <RequestInspectorDialog :open="inspectorOpen && running" :instance-id="store.selectedInstanceId" :characters="store.presetCharacters" @close="inspectorOpen=false" />
    <PlaySettingsDialog :open="playSettingsOpen" @close="playSettingsOpen=false" />
    <FrontendAuthorizationDialog :open="frontendOpen" @close="frontendOpen=false" />
    <p v-for="issue in store.selectedPackage.validation.issues" :key="issue" class="validation-issue">{{ issue }}</p>
  </main>
  <main v-else class="empty-state"><BookOpen :size="32" /><h1>{{ store.busy ? '正在读取本机实例…' : '载入一个世界包，开始你的故事。' }}</h1><p v-if="!store.initialized">本机初始化未完成。</p><Button v-if="store.real && !store.initialized" :disabled="store.busy" @click="store.initialize()">重试初始化</Button><Button v-if="store.selectedPackage && !store.currentInstance" :disabled="store.busy" @click="store.newInstance('第一次游玩')">创建实例</Button></main>
</template>
