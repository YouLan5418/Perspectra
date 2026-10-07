<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue'
import { characterPreset, rolePreset, type RolePreset } from '../../../../packages/provider-chat/src/preset.ts'
import type { PresetChoice } from '../core-types.ts'
import { useLauncherStore } from '../stores/launcher.ts'
import DialogFrame from './DialogFrame.vue'
import PresetLibraryPanel from './PresetLibraryPanel.vue'
import PresetContentEditor from './PresetContentEditor.vue'
import { Button } from './ui/button/index.ts'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
const loading = ref(true), globalDraft = ref<RolePreset>({}), initial = ref(''), editorRevision = ref(0), discard = ref(false)
const scope = ref('instance'), characterId = ref(''), groupId = ref('')
const choice = ref<PresetChoice>({ mode: 'auto', override: {} })
const draft = ref<RolePreset>({}), stops = ref(''), error = ref(''), characterCustom = ref(false)
const numeric = ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'maxOutputTokens'] as const
const labels = { temperature: 'Temperature（0–2）', topP: 'Top P（0–1）', frequencyPenalty: '频率惩罚（-2–2）', presencePenalty: '存在惩罚（-2–2）', maxOutputTokens: '最大输出 Token（1–32768）' }
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const groups = computed(() => Object.entries(choice.value.groups ?? {}))
const selectedGroup = computed(() => choice.value.groups?.[groupId.value])
const base = computed(() => choice.value.mode === 'custom' ? choice.value.override
  : choice.value.mode === 'global' ? globalDraft.value
    : { ...globalDraft.value, ...store.presets.recommended[store.selectedPackageId] })
const inherited = computed(() => characterPreset(base.value,
  { groups: choice.value.groups ?? {}, memberships: choice.value.memberships ?? {} }, characterId.value))
const membership = computed({
  get: () => choice.value.memberships?.[characterId.value] ?? '',
  set: value => {
    const members = { ...choice.value.memberships }
    if (value) members[characterId.value] = value
    else delete members[characterId.value]
    choice.value.memberships = members
  },
})
const editable = computed(() => scope.value === 'global' || scope.value === 'instance' && choice.value.mode === 'custom'
  || scope.value === 'character' && characterCustom.value || scope.value === 'group' && !!selectedGroup.value)
const preview = computed(() => scope.value === 'character' ? inherited.value : base.value)
function setDraft(value: RolePreset) {
  draft.value = clone(value); stops.value = value.stop?.join('\n') ?? ''; error.value = ''
}
function resetDraft() {
  if (scope.value === 'global') setDraft(globalDraft.value)
  else if (scope.value === 'character') {
    characterCustom.value = Object.hasOwn(choice.value.characters ?? {}, characterId.value)
    setDraft(choice.value.characters?.[characterId.value] ?? inherited.value)
  } else if (scope.value === 'group') setDraft(selectedGroup.value?.preset ?? base.value)
  else setDraft(base.value)
}
let ready = false
function stage(target: string, actor: string, group: string) {
  const value = { ...draft.value }; delete value.stop
  const preset = { ...value, ...(stops.value ? { stop: stops.value.split('\n') } : {}) }
  if (target === 'global') globalDraft.value = preset
  if (target === 'instance' && choice.value.mode === 'custom') choice.value.override = preset
  if (target === 'group' && choice.value.groups?.[group]) choice.value.groups[group]!.preset = preset
  if (target === 'character' && actor) {
    const updated = { ...choice.value.characters }
    if (characterCustom.value) updated[actor] = preset
    else delete updated[actor]
    if(Object.keys(updated).length)choice.value.characters=updated
    else delete choice.value.characters
  }
}
watch([scope, characterId, groupId], (_current, previous) => {
  if (ready) stage(previous[0]!, previous[1]!, previous[2]!)
  resetDraft()
})
watch(characterCustom, enabled => { if (enabled) setDraft(choice.value.characters?.[characterId.value] ?? inherited.value) })
watch(() => choice.value.mode, (_mode, previous) => {
  if (ready && scope.value === 'instance' && previous === 'custom') {
    choice.value.override = currentDraft()
  }
  resetDraft()
})
watch(() => props.open, async open => {
  ready = false; loading.value = true; error.value = ''
  if (!open) return
  if (!await store.inspectPreset()) { error.value = store.notice; return }
  if (!props.open) return
  globalDraft.value = clone(store.presets.global); discard.value=false
  choice.value = clone(store.presets.instances[store.selectedInstanceId] ?? { mode: 'auto', override: {} })
  scope.value = 'instance'
  characterId.value = store.presetCharacters[0]?.id ?? ''
  groupId.value = Object.keys(choice.value.groups ?? {})[0] ?? ''
  resetDraft()
  await nextTick(); ready = true; loading.value = false
  initial.value = JSON.stringify({global:globalDraft.value,choice:choice.value})
})
function number(key: typeof numeric[number], event: Event) {
  const value = (event.target as HTMLInputElement).value
  if (value === '') delete draft.value[key]
  else draft.value[key] = Number(value)
}
function addGroup() {
  const id = crypto.randomUUID()
  choice.value.groups = { ...choice.value.groups, [id]: { name: '新角色组', preset: clone(base.value) } }
  groupId.value = id
  scope.value = 'group'
}
function removeGroup() {
  const updated = { ...choice.value.groups }; delete updated[groupId.value]
  choice.value.groups = updated
  choice.value.memberships = Object.fromEntries(Object.entries(choice.value.memberships ?? {}).filter(([, id]) => id !== groupId.value))
  groupId.value = Object.keys(updated)[0] ?? ''
  resetDraft()
}
function currentDraft(): RolePreset {
 const value={...draft.value};delete value.stop
 return {...value,...(stops.value?{stop:stops.value.split('\n')}:{})}
}
function collected() {
 const next=clone(choice.value),global=scope.value==='global'?currentDraft():clone(globalDraft.value)
 if(editable.value){
  if(scope.value==='instance')next.override=currentDraft()
  if(scope.value==='group'&&next.groups?.[groupId.value])next.groups[groupId.value]!.preset=currentDraft()
  if(scope.value==='character'&&characterCustom.value)next.characters={...next.characters,[characterId.value]:currentDraft()}
 }
 if(scope.value==='character'&&!characterCustom.value){const characters={...next.characters};delete characters[characterId.value];if(Object.keys(characters).length)next.characters=characters;else delete next.characters}
 return {global,choice:next}
}
const dirty=computed(()=>ready&&initial.value!==JSON.stringify(collected()))
const libraryDraft=computed(()=>editable.value?currentDraft():scope.value==='group'?selectedGroup.value?.preset??base.value:preview.value)
function applyLibrary(preset:RolePreset){
 editorRevision.value++
 if(scope.value==='instance'){choice.value.mode='custom';choice.value.override=clone(preset)}
 if(scope.value==='character'){characterCustom.value=true;choice.value.characters={...choice.value.characters,[characterId.value]:clone(preset)}}
 if(scope.value==='global')globalDraft.value=clone(preset)
 if(scope.value==='group'&&selectedGroup.value)selectedGroup.value.preset=clone(preset)
 setDraft(preset)
}
function requestClose(){if(dirty.value)discard.value=true;else emit('close')}
async function save() {
 try {
  const values=collected()
  if(await store.savePresetDrafts(rolePreset(values.global),values.choice))emit('close')
  else error.value=store.notice
 }catch(e){error.value=e instanceof Error?e.message:'预设无效。'}
}
</script>
<template>
  <DialogFrame wide :open="open" title="角色预设" description="调整角色的表达风格与生成参数。保存后在下次启动时生效。" @close="requestClose">
    <template v-if="!loading">
    <div class="preset-workspace"><PresetLibraryPanel :preset="libraryDraft" :can-apply="scope!=='group'||!!selectedGroup" @apply="applyLibrary" /><section class="preset-fields">
    <label class="field-label">编辑范围<select v-model="scope"><option value="instance">实例默认</option><option value="global">全局默认</option><option value="character" :disabled="!store.presetCharacters.length">角色专属</option><option value="group">角色组</option></select></label>
    <label v-if="scope === 'instance'" class="field-label">使用方式<select v-model="choice.mode"><option value="auto">采用包推荐，并继承全局默认</option><option value="global">仅用全局默认，忽略包推荐</option><option value="custom">实例自定义</option></select></label>
    <template v-if="scope === 'character'">
      <label class="field-label">当前角色<select v-model="characterId"><option v-for="character in store.presetCharacters" :key="character.id" :value="character.id">{{ character.name }}</option></select></label>
      <label class="field-label">所属角色组<select v-model="membership"><option value="">不分组，继承实例默认</option><option v-for="[id, group] in groups" :key="id" :value="id">{{ group.name }}</option></select></label>
      <label class="toggle-label"><input v-model="characterCustom" type="checkbox"> 启用此角色专属预设</label>
      <p>角色专属优先于角色组；关闭后继承所属组或实例默认。这里显示包定义的角色，不包含运行时私有记忆或认知。</p>
    </template>
    <template v-if="scope === 'group'">
      <div class="group-actions"><label class="field-label">当前角色组<select v-model="groupId"><option v-if="!groups.length" value="">尚无角色组</option><option v-for="[id, group] in groups" :key="id" :value="id">{{ group.name }}</option></select></label><Button variant="outline" @click="addGroup">新建组</Button></div>
      <template v-if="selectedGroup"><label class="field-label">组名称<input v-model="selectedGroup.name" maxlength="80"></label><button class="text-button" @click="removeGroup">删除此组并解除分组</button></template>
      <p>在“角色专属”页面为角色选择组。每个角色最多属于一个组；组不改变角色权限或世界关系。删除组后解除成员分组，角色专属预设继续保留。</p>
    </template>
    <p v-if="scope === 'global'">影响继承默认的实例；包推荐中明确填写的字段优先。</p>
    <p v-if="editable && scope !== 'global'">当前配置完整替代下层预设；留空生成参数使用 Core 默认值。</p>
    <template v-if="editable">
      <label class="field-label">附加角色提示<textarea v-model="draft.prompt" rows="3" maxlength="16000" placeholder="例如：对白简短，保留角色自己的语气和判断。"></textarea></label>
      <PresetContentEditor :key="scope+characterId+groupId+editorRevision" v-model="draft" />
      <div class="preset-grid"><label v-for="key in numeric" :key="key" class="field-label">{{ labels[key] }}<input type="number" :value="draft[key] ?? ''" :step="key === 'maxOutputTokens' ? 1 : 0.1" placeholder="Core 默认" @input="number(key, $event)"></label></div>
      <label class="field-label">停止词（每行一条，最多 4 条）<textarea v-model="stops" rows="2" placeholder="通常留空；停止词可能截断角色输出。"></textarea></label>
    </template>
    <template v-else-if="scope !== 'group'"><p>当前继承内容：</p><p class="prompt-preview">{{ preview.prompt || '无附加角色提示' }} · {{ preview.nodes?.length ?? 0 }} 个节点 · {{ preview.textRules?.length ?? 0 }} 条文本规则</p><dl><template v-for="key in numeric" :key="key"><dt>{{ labels[key] }}</dt><dd>{{ preview[key] ?? 'Core 默认' }}</dd></template><dt>停止词</dt><dd>{{ preview.stop?.join('、') || '无' }}</dd></dl></template>
    </section></div>
    <p>仅用于角色模型请求。模型接口、工具协议、玩家意图解释、记忆整理和世界裁定沿用 Core 配置。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="dialog-actions preset-savebar"><span>{{ dirty ? '有未保存修改' : '配置已保存' }}</span><Button variant="outline" @click="requestClose">取消</Button><Button :disabled="store.busy || store.core.state === 'running'" @click="save">保存全部配置</Button></div>
    <div v-if="discard" class="dialog-actions"><span>还有未保存的配置。</span><Button variant="outline" @click="discard=false">继续编辑</Button><Button variant="outline" @click="emit('close')">放弃修改</Button></div>
    </template><template v-else><p>{{ error || '正在读取包角色与预设…' }}</p><Button variant="outline" @click="emit('close')">取消</Button></template>
  </DialogFrame>
</template>
<style scoped>
.preset-savebar{position:sticky;bottom:-24px;background:#faf9f6;padding:14px 0;z-index:2}
.preset-workspace{display:grid;grid-template-columns:280px minmax(0,1fr);gap:20px}.preset-fields{display:grid;gap:14px;min-width:0}@media(max-width:760px){.preset-workspace{grid-template-columns:1fr}}
.field-label{display:grid;gap:6px;margin:0;font-size:12px}
.preset-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px}
.field-label input,select,textarea{width:100%;padding:8px 10px;border:1px solid #dce1d5;border-radius:6px;background:#fff;font:inherit}
p,dl,.toggle-label{font-size:12px;line-height:1.7}dl{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px}dd{margin:0}
textarea{resize:vertical}.prompt-preview{white-space:pre-wrap}.group-actions{display:flex;gap:12px;align-items:end}.group-actions label{flex:1}
</style>
