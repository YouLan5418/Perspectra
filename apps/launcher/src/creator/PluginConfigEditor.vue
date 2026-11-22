<script setup lang="ts">
import type { autonomyBook } from '../../../host/src/editor/autonomy.ts'
import { computed, onMounted, ref } from 'vue'
import { editorRequest } from './editor-api.ts'
import type { trpgBook } from '../../../host/src/editor/trpg.ts'
import type { ConfigObject } from '@perspectra/world-pack/editor-config'
import ModeConfigFields from './ModeConfigFields.vue'
import CommunicationContacts from './CommunicationContacts.vue'
const props = defineProps<{
  mode: 'trpg' | 'communication' | 'autonomy'
  initialCharacter?: string | undefined
  scopedActor?: boolean
}>()
const name = { trpg: '跑团', communication: '通讯录', autonomy: '自主机会' }[props.mode]
type Book = ReturnType<typeof trpgBook> | Awaited<ReturnType<typeof autonomyBook>>
const book = ref<Book>(),
  draft = ref<ConfigObject>(),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  conflict = ref(false)
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(book.value?.config ?? undefined))
function load(b: Book) {
  book.value = b
  draft.value = b.config ? JSON.parse(JSON.stringify(b.config)) : undefined
  conflict.value = false
}
async function run(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function reload() {
  load(await editorRequest<Book>(props.mode))
}
async function save() {
  if (!dirty.value || !book.value?.enabled) return
  try {
    load(
      await editorRequest<Book>(props.mode + '-save', {
        file: book.value.file,
        base: book.value.config,
        config: draft.value,
      }),
    )
    notice.value = name + '配置已保存'
  } catch (e) {
    if ((e as { status?: number }).status === 409) conflict.value = true
    throw e
  }
}
defineExpose({
  async flush() {
    if (busy.value) throw new Error('请等' + name + '操作完成')
    await save()
  },
})
onMounted(() => run(reload))
</script>
<template>
  <section>
    <h2 v-if="!scopedActor">
      {{ mode === 'autonomy' ? '角色自主机会' : mode === 'trpg' ? '跑团玩法' : '角色通讯录' }}
    </h2>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="book && 'warning' in book && book.warning">{{ book.warning }}</p>
    <fieldset v-if="book" :disabled="busy">
      <template v-if="book.enabled && draft">
        <button :disabled="!dirty" @click="run(save)">保存{{ name }}配置</button><span v-if="dirty"> 有未保存修改</span
        ><button v-if="conflict || dirty" @click="run(reload)">
          {{ conflict ? '重新载入磁盘版本' : '放弃本节修改' }}
        </button>
        <CommunicationContacts
          v-if="mode === 'communication'"
          :initial="initialCharacter"
          :scoped-actor="!!scopedActor"
          :config="draft"
          :records="book"
          @change="v => (draft = v)"
        />
        <ModeConfigFields
          v-else
          :mode="mode"
          :schema="book.schema"
          :records="book"
          :config="draft"
          @change="v => (draft = v)"
        /> </template
      ><template v-else
        ><p>
          {{
            book.configExists
              ? '接入已有的 ' + book.file
              : mode === 'trpg'
                ? '启用后可设置角色卡、主持人、题目和预写剧本。'
                : mode === 'autonomy'
                  ? '选择在什么条件下给角色主动行动的机会。角色会自行决定行动或放弃。'
                  : '选择哪些角色能彼此发信，也可以只开通一个方向。'
          }}
        </p>
        <button
          @click="
            run(async () => {
              load(await editorRequest<Book>(mode + '-enable', {}))
              notice = mode === 'trpg' ? '跑团玩法已启用' : name + '已启用'
            })
          "
        >
          启用{{ name }}
        </button></template
      >
    </fieldset>
  </section>
</template>
<style scoped>
section {
  padding: 1rem;
  color: #292929;
}
fieldset {
  border: 0;
  padding: 0;
}
button {
  padding: 0.45rem 0.8rem;
  margin-bottom: 0.5rem;
}
</style>
