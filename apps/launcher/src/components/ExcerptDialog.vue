<script setup lang="ts">
import { ref } from 'vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { chooseExcerptDestination } from '../services/desktop.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'

const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
const mode = ref<'rounds' | 'node'>('rounds'),
  rounds = ref(20),
  node = ref(store.currentNode?.id ?? '')
const perspective = ref<'player' | 'world'>('player'),
  format = ref<'md' | 'json'>('md'),
  saving = ref(false),
  error = ref('')
async function save() {
  const instance = store.currentInstance,
    line = store.currentStoryline
  if (!instance || !line || saving.value) return
  saving.value = true
  try {
    const path = await chooseExcerptDestination(format.value)
    if (!path) return
    if (
      await store.exportExcerpt(
        path,
        mode.value === 'rounds' ? { rounds: rounds.value } : { nodeId: node.value },
        perspective.value,
        instance.id,
        line.id,
      )
    )
      emit('close')
    else error.value = store.notice
  } catch {
    error.value = '无法导出，请选择数据目录外的新文件。'
  } finally {
    saving.value = false
  }
}
</script>
<template>
  <DialogFrame
    open
    title="导出最近游玩片段"
    description="把这条故事线上已发生的内容保存为本地写作素材。"
    @close="emit('close')"
  >
    <p>{{ store.currentInstance?.name }} · {{ store.currentStoryline?.name }}</p>
    <label class="form-field"
      >范围<select v-model="mode">
        <option value="rounds">最近的游戏回合</option>
        <option value="node" :disabled="!store.currentHistory.length">从保存节点之后开始</option>
      </select></label
    >
    <label v-if="mode === 'rounds'" class="form-field"
      >回合数<input type="number" min="1" step="1" v-model.number="rounds"
    /></label>
    <label v-else class="form-field"
      >起始节点<select v-model="node">
        <option v-for="n in store.currentHistory" :key="n.id" :value="n.id">{{ n.title }} · 时刻 {{ n.turn }}</option>
      </select></label
    >
    <label class="form-field"
      >视角<select v-model="perspective">
        <option value="player">玩家所见所闻</option>
        <option value="world">有限全知（另含世界事件发生记录）</option>
      </select></label
    >
    <label class="form-field"
      >格式<select v-model="format">
        <option value="md">Markdown · 阅读与改写</option>
        <option value="json">JSON · 程序读取</option>
      </select></label
    >
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="dialog-actions">
      <Button variant="outline" @click="emit('close')">取消</Button
      ><Button
        :disabled="saving || store.busy || (mode === 'rounds' ? !Number.isSafeInteger(rounds) || rounds < 1 : !node)"
        @click="save"
        >保存片段</Button
      >
    </div>
  </DialogFrame>
</template>
