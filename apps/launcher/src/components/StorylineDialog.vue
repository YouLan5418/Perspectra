<script setup lang="ts">
import { ref, watch } from 'vue'
import { Check, CornerDownRight } from '@lucide/vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
const selectedNodeId = ref('')
const name = ref('我的新故事')
watch(() => props.open, open => { if (open) { selectedNodeId.value = store.currentNode?.id ?? ''; name.value = '我的新故事' } })
async function chooseLine(id: string) { if(await store.selectStoryline(id))selectedNodeId.value = store.currentNode?.id ?? '' }
async function fork() { if(await store.forkStory(selectedNodeId.value, name.value.trim()))emit('close') }
const nodeTitle = ref('我的节点')
async function saveNode() { if(await store.saveStoryNode(nodeTitle.value.trim()))selectedNodeId.value=store.currentNode?.id??'' }
</script>
<template><DialogFrame :open="open" title="故事线" description="过去的选择会一直保留。保存完整节点，结束游戏后从这里开启自己的故事。首次分叉需等待角色记忆重新整理。" @close="emit('close')">
  <p v-if="store.currentInstance?.storyError" role="alert">{{ store.currentInstance.storyError }}</p>
  <div class="storyline-list"><button v-for="line in store.currentInstance?.storylines" :key="line.id" class="line-choice" :class="{ active: line.id === store.currentStoryline?.id }" :disabled="store.busy || store.core.state === 'running'" @click="chooseLine(line.id)"><CornerDownRight v-if="line.parentStorylineId" :size="16" /><div><strong>{{ line.name }}</strong><small>{{ line.source.kind === 'original' ? '我的故事' : '来源：' + line.source.label + (store.real ? ' / 时刻 ' + line.source.turn : ' / 第 ' + line.source.turn + ' 轮') }}</small></div><Check v-if="line.id === store.currentStoryline?.id" :size="16" /></button></div>
  <div v-if="store.real && store.core.state === 'running'" class="form-field"><label for="node-title">保存当前静止时刻</label><input id="node-title" v-model="nodeTitle" maxlength="80" /><Button :disabled="store.busy || !nodeTitle.trim()" @click="saveNode">保存完整节点</Button><p class="muted">请等待当前行动结束；保存会取消未完成的后台记忆整理。结束游戏后可切换或分叉。</p></div>
  <p v-if="store.real && !store.currentInstance?.storyError && !store.currentHistory.length" class="muted">暂无完整节点。开始游戏后可保存当前节点；旧历史不会自动补成节点。</p>
  <div class="form-field"><label for="history-node">从历史节点开始</label><select id="history-node" v-model="selectedNodeId"><option v-for="node in store.currentHistory" :key="node.id" :value="node.id">{{ store.real ? '时刻 ' : '第 ' }}{{ node.turn }}{{ store.real ? '' : ' 轮' }} · {{ node.title }}</option></select></div>
  <ol class="history-list"><li v-for="node in store.currentHistory" :key="node.id"><span>{{ store.real ? '时刻 ' : '第 ' }}{{ node.turn }}{{ store.real ? '' : ' 轮' }}</span><strong>{{ node.title }}</strong></li></ol>
  <div class="form-field"><label for="story-name">新故事线名称</label><input id="story-name" v-model="name" maxlength="60" /></div>
  <p v-if="store.notice" class="inline-info" role="status">{{ store.notice }}</p>
  <div class="dialog-actions"><Button variant="outline" @click="emit('close')">完成</Button><Button :disabled="store.busy || store.core.state === 'running' || !name.trim() || !selectedNodeId" @click="fork">从这里开始我的故事</Button></div>
</DialogFrame></template>
