<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { draftModels, geminiRequired, modelsDraft, type LayerDraft, type ModelsDraft } from '../model-choices.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'
import ModelPicker from './ModelPicker.vue'
import ThinkingOptions from './ThinkingOptions.vue'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
const draft = ref<ModelsDraft>(modelsDraft(undefined, []))
const models = computed(() => draftModels(draft.value))
watch(() => props.open, open => {
  if (!open) return
  draft.value = modelsDraft(store.currentRealInstance?.brokenConnection ? undefined : store.currentModels, store.presetCharacters.map(c => c.id))
}, { immediate: true })
// Choosing a Gemini model that cannot turn thinking off moves the choice to the lowest allowed level.
function keepThinkingValid(layer: LayerDraft) { if (layer.thinkingLevel === 'off' && geminiRequired(layer.decision?.model ?? '')) layer.thinkingLevel = 'low' }
watch(draft, value => { keepThinkingValid(value); for (const role of Object.values(value.characters)) keepThinkingValid(role) }, { deep: true })
const overrides = computed(() => Object.values(draft.value.characters).filter(role => role.override).length)
async function save() {
  if (!models.value) return
  if (!await store.configureModels(models.value)) return
  emit('close')
}
</script>
<template><DialogFrame :open="open" title="模型配置" description="为这个实例选择角色使用的模型。连接与 API Key 在右上角 ⚙ 的“模型接口”里管理。" @close="emit('close')">
  <p v-if="store.currentRealInstance?.brokenConnection" class="inline-info">此实例原先使用的连接已删除，请重新选择。</p>
  <p v-if="!store.connections.length" class="inline-info">还没有模型连接。请先在右上角 ⚙ 的“模型接口”添加连接。</p>
  <template v-else>
    <ModelPicker v-model="draft.decision" label="所有角色" id-prefix="instance-default" />
    <ThinkingOptions v-model="draft.thinkingLevel" :model="draft.decision?.model ?? ''" label="角色思考强度" />
    <p class="muted">仅影响角色决策。更强的思考可能增加等待与消耗；DeepSeek 的中、高分别对应原生 high、max。Gemini 部分型号不能完全关闭。</p>
    <label class="check-row"><input v-model="draft.memoryFollows" type="checkbox" /> 记忆整理跟随上面的决策模型</label>
    <ModelPicker v-if="!draft.memoryFollows" v-model="draft.memory" label="记忆整理" id-prefix="instance-memory" />
    <section v-if="store.presetCharacters.length" class="role-section">
      <h3>按角色单独设置<span v-if="overrides" class="muted"> · {{ overrides }} 个角色单独配置</span></h3>
      <p class="muted">适合给重要角色换推理更强、文笔更好的模型，次要角色继续用默认模型。</p>
      <div v-for="character in store.presetCharacters" :key="character.id" class="role-row">
        <template v-if="draft.characters[character.id]">
          <label class="check-row"><input :checked="!draft.characters[character.id]!.override" type="checkbox"
            @change="draft.characters[character.id]!.override = !($event.target as HTMLInputElement).checked" /> <strong>{{ character.name }}</strong> 跟随默认</label>
          <div v-if="draft.characters[character.id]!.override" class="role-body">
            <ModelPicker v-model="draft.characters[character.id]!.decision" :label="character.name" :id-prefix="'role-' + character.id" />
            <ThinkingOptions v-model="draft.characters[character.id]!.thinkingLevel" :model="draft.characters[character.id]!.decision?.model ?? ''" :label="character.name + ' · 思考强度'" />
            <label class="check-row"><input v-model="draft.characters[character.id]!.memoryFollows" type="checkbox" /> 记忆整理跟随该角色的决策模型</label>
            <ModelPicker v-if="!draft.characters[character.id]!.memoryFollows" v-model="draft.characters[character.id]!.memory" :label="character.name + ' · 记忆整理'" :id-prefix="'role-memory-' + character.id" />
          </div>
        </template>
      </div>
    </section>
  </template>
  <p v-if="store.connections.length && !models" class="muted">每个已选择的模型位置都需要填写模型标识。</p>
  <div class="dialog-actions"><Button variant="outline" @click="emit('close')">取消</Button><Button :disabled="store.busy || !models" @click="save">保存配置</Button></div>
</DialogFrame></template>

<style scoped>
.check-row{display:flex;align-items:center;gap:8px;cursor:pointer}
.role-section{display:grid;gap:10px;border-top:1px solid var(--border);padding-top:14px}
.role-section h3{margin:0;font-size:15px}
.role-row{display:grid;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:12px}
.role-body{display:grid;gap:12px}
</style>
