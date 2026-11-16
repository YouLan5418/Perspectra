<script setup lang="ts">
import { ref, watch } from 'vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { chooseTreeBackup } from '../services/desktop.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'
const props = defineProps<{ open: boolean; restore: boolean }>()
const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
const name = ref('恢复的存档'),
  error = ref(''),
  choosing = ref(false)
watch(
  () => props.open,
  open => {
    if (open) {
      error.value = ''
      store.notice = ''
    }
  },
)
async function run() {
  if (store.busy || choosing.value) return
  choosing.value = true
  error.value = ''
  try {
    const path = await chooseTreeBackup(props.restore)
    if (!path) {
      error.value = '已取消文件选择，存档未改变。'
      return
    }
    const ok = props.restore ? await store.restoreTree(path, name.value.trim()) : await store.backupTree(path)
    if (ok) emit('close')
    else error.value = store.notice || '备份操作失败；原存档保留，请重试。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '文件选择或备份失败，请重试。'
  } finally {
    choosing.value = false
  }
}
</script>
<template>
  <DialogFrame
    :open="open"
    :title="restore ? '恢复备份' : '备份整个存档实例'"
    description="整棵已保存存档树；与单节点分享独立。"
    @close="!choosing && !store.busy && emit('close')"
  >
    <p>
      请先在游戏内保存要带走的进度。仅包含已保存节点、线路与叉点，不包含运行中或未保存的尾部；没有独立保存头的线路将从其已保存叉点继续。
    </p>
    <p class="inline-info">备份含私密剧情、玩家已知内容和各角色记忆，不宜当分享包。请妥善保管。</p>
    <p>
      不包含游戏包、模型配置或凭证、请求／Context
      诊断记录。恢复需要内容完全相同的游戏包和兼容玩法／记忆契约，不调用模型；建立新实例，不覆盖已有数据。
    </p>
    <p>
      第一版上限：64 条线路、256 个节点、单对象 64 MiB、去重后 192 MiB、节点展开合计 512
      MiB。请选择新文件名，不覆盖现有备份。
    </p>
    <div v-if="restore" class="form-field">
      <label for="backup-name">新实例名称</label
      ><input id="backup-name" v-model="name" maxlength="80" :disabled="choosing || store.busy" />
    </div>
    <p v-if="!store.real">浏览器仅作预览；真实文件选择需要桌面版。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="store.busy" role="status">
      正在校验和写入，请勿关闭启动器。若中断，未公布实例不会出现在列表；原实例保留，可重新恢复。
    </p>
    <div class="dialog-actions">
      <Button variant="outline" :disabled="choosing || store.busy" @click="emit('close')">取消</Button
      ><Button
        :disabled="!store.real || choosing || store.busy || (restore && (!name.trim() || store.running))"
        @click="run"
        >{{ store.busy ? '正在处理…' : restore ? '选择备份并恢复' : '选择路径并备份' }}</Button
      >
    </div>
  </DialogFrame>
</template>
