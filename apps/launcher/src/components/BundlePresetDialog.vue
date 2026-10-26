<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLauncherStore } from '../stores/launcher.ts'
import DialogFrame from './DialogFrame.vue'
import { Button } from './ui/button/index.ts'
const store = useLauncherStore(),
  library = ref(true)
const bundle = computed(() => store.bundledPreset)
const name = (id: string) => store.presetCharacters.find(c => c.id === id)?.name ?? id
const characters = computed(() => Object.keys(bundle.value?.characters ?? {}).map(name))
watch(
  () => store.bundlePrompt,
  open => {
    if (open) library.value = true
  },
)
</script>
<template>
  <DialogFrame
    :open="store.bundlePrompt && !!bundle"
    title="随包角色预设"
    description="这个游戏包带有作者推荐的角色预设，可以一键分配到当前实例。"
    @close="store.bundlePrompt = false"
  >
    <p v-if="characters.length">
      角色专属 {{ characters.length }} 个：<strong>{{ characters.join('、') }}</strong>
    </p>
    <p v-if="bundle?.groups.length">
      角色组 {{ bundle.groups.length }} 个：
      <span v-for="(group, index) in bundle.groups" :key="group.name"
        >{{ index ? '；' : '' }}<strong>{{ group.name }}</strong
        >（{{ group.members.map(name).join('、') }}）</span
      >
    </p>
    <p>分配到：{{ store.currentInstance?.name }}。实例默认仍使用包推荐；保存后下次启动游戏时生效。</p>
    <p v-if="store.bundleOverwrites.length" role="alert">
      会覆盖这些现有设置：{{ store.bundleOverwrites.join('、') }}。
    </p>
    <label
      ><input v-model="library" type="checkbox" :disabled="store.busy" /> 同时存入预设库，方便以后用于其他实例</label
    >
    <div class="dialog-actions">
      <Button variant="outline" @click="store.bundlePrompt = false">暂不</Button>
      <Button :disabled="store.busy || !store.currentInstance" @click="store.applyBundledPreset(library)"
        >一键分配到「{{ store.currentInstance?.name }}」</Button
      >
    </div>
  </DialogFrame>
</template>
