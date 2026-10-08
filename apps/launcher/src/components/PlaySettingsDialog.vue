<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { PLAY_SETTING_FIELDS, DEFAULT_PLAY_SETTINGS, playSettings } from '../../../../desktop/play-settings.ts'
import { useLauncherStore } from '../stores/launcher.ts'
import DialogFrame from './DialogFrame.vue'
import { Button } from './ui/button/index.ts'
const props=defineProps<{open:boolean}>(),emit=defineEmits<{close:[]}>()
const store=useLauncherStore(),draft=reactive({...DEFAULT_PLAY_SETTINGS}),error=ref('')
const groups=[...new Set(PLAY_SETTING_FIELDS.map(field=>field.group))]
const notes:Record<string,string>={
 '表达与等待':'字符上限分别限制玩家输入、角色发布。模型输出 Token 沿用角色预设。激活包含多次请求；外层更短的时限会先触发。',
 '普通反应周期':'每角色次数统计激活机会，一次激活可能多次调用模型。调用预算包含执行后的续写；总时限限制整个周期，独立于 Activity。',
 'Activity':'限制活动连续处理机会与总等待时间，活动本身的规则和轮次仍由创作者定义。',
 'Core 记忆':'Token 为本地估算。整理目标和近期保留量必须小于触发阈值；保留量是近期原文目标，召回预算只限制长期记忆交付。'
}
watch(()=>props.open,open=>{if(open){Object.assign(draft,store.currentPlaySettings);error.value=''}})
async function save(){
 try{error.value='';if(await store.savePlaySettings(playSettings(draft)))emit('close')}
 catch(e){error.value=e instanceof Error?e.message:'游玩参数无效。'}
}
</script>
<template><DialogFrame :open="open" :title="'运行参数 · '+(store.selectedPackage?.title??'当前包')" description="按游戏包保存，作用于该包所有实例的下一次启动。分叉沿用这些参数，游戏包文件与存档事实保持原样。" wide @close="emit('close')">
 <details v-for="(group,index) in groups" :key="group" class="play-settings-group" :open="index<2">
  <summary>{{ group }}<span>{{ index>=2?'高级':'' }}</span></summary>
  <p class="muted">{{ notes[group] }}</p>
  <div class="play-settings-grid"><div v-for="field in PLAY_SETTING_FIELDS.filter(field=>field.group===group)" :key="field.key" class="form-field"><label :for="'play-'+field.key">{{ field.label }}</label><input :id="'play-'+field.key" v-model.number="draft[field.key]" type="number" :min="field.min" :max="field.max" step="1" :disabled="store.busy || store.core.state==='running'" /><small class="muted">{{ field.min }}–{{ field.max }} · 默认 {{ field.default }}</small></div></div>
 </details>
 <p v-if="error" role="alert">{{ error }}</p>
 <div class="dialog-actions"><Button variant="outline" :disabled="store.busy || store.core.state==='running'" @click="Object.assign(draft,DEFAULT_PLAY_SETTINGS)">恢复默认值</Button><Button variant="outline" @click="emit('close')">取消</Button><Button :disabled="store.busy || store.core.state==='running'" @click="save">保存游玩参数</Button></div>
</DialogFrame></template>
