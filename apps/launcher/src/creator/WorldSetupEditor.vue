<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { editorRequest } from './editor-api.ts'
import type { worldSetup } from '../../../host/src/editor/world-setup.ts'
import type { ConfigObject, SetupKind } from '@perspectra/world-pack/editor-config'
import ModeConfigFields from './ModeConfigFields.vue'
import { formNames } from './config-form.ts'
type Book = ReturnType<typeof worldSetup>
const props = defineProps<{
  initialCharacter?: string | undefined
  initialKind?: string | undefined
  scopedActor?: boolean
}>()
const kinds: SetupKind[] = ['world', 'portrayal', 'cognition', 'memory']
const book = ref<Book>(),
  draft = ref<ConfigObject>({}),
  character = ref(''),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  conflict = ref(false)
const dirty = computed(() => book.value && JSON.stringify(draft.value) !== JSON.stringify(book.value.config))
function load(b: Book) {
  book.value = b
  draft.value = JSON.parse(JSON.stringify(b.config))
  conflict.value = false
}
async function read(kind: SetupKind, actor: string) {
  const next = await editorRequest<Book>('world-setup', { kind, character: actor })
  character.value =
    actor || next.records.characters.find(c => c.id !== next.records.player)?.id || next.records.characters[0]?.id || ''
  load(next)
}
async function save() {
  if (!dirty.value || !book.value) return
  const { kind, file, config } = book.value
  try {
    load(
      await editorRequest<Book>('world-setup-save', {
        kind,
        character: character.value,
        file,
        base: config,
        config: draft.value,
      }),
    )
    notice.value = formNames[kind] + '已保存'
  } catch (e) {
    if ((e as { status?: number }).status === 409) conflict.value = true
    throw e
  }
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
async function switchTo(kind: SetupKind, actor: string, event?: Event) {
  if (event) (event.target as HTMLSelectElement).value = character.value
  await run(async () => {
    await save()
    await read(kind, actor)
  })
}
defineExpose({
  async flush() {
    if (busy.value) throw new Error('请等开局设置操作完成')
    await save()
  },
})
onMounted(() => run(() => read(kinds.find(k => k === props.initialKind) ?? 'world', props.initialCharacter ?? '')))
</script>
<template>
  <section class="setup">
    <h2 v-if="!scopedActor">世界与角色开局</h2>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <fieldset v-if="book" :disabled="busy">
      <div class="choices">
        <button
          v-for="k in scopedActor ? kinds.filter(k => k !== 'world') : kinds"
          :key="k"
          :aria-pressed="book.kind === k"
          @click="switchTo(k, character)"
        >
          {{ formNames[k] }}
        </button>
      </div>
      <label v-if="!scopedActor && book.kind !== 'world'"
        >角色
        <select
          aria-label="开局设置角色"
          :value="character"
          @change="switchTo(book.kind, ($event.target as HTMLSelectElement).value, $event)"
        >
          <option v-for="r in book.records.characters" :key="r.id" :value="r.id">{{ r.name }} · {{ r.id }}</option>
        </select>
      </label>
      <div class="choices">
        <button :disabled="!dirty" @click="run(save)">保存{{ formNames[book.kind] }}</button>
        <span v-if="dirty">有未保存修改</span>
        <button v-if="dirty || conflict" @click="run(() => read(book!.kind, character))">
          {{ conflict ? '重新载入磁盘版本' : '放弃本节修改' }}
        </button>
      </div>
      <ModeConfigFields
        :key="book.kind + '|' + character"
        :mode="book.kind"
        :schema="book.schema"
        :config="draft"
        :records="book.records"
        @change="v => (draft = v)"
      />
    </fieldset>
  </section>
</template>
<style scoped>
.setup {
  padding: 1rem;
  color: #292929;
}
fieldset {
  display: grid;
  gap: 0.9rem;
  border: 0;
  padding: 0;
}
.choices {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
button,
select {
  padding: 0.4rem 0.65rem;
}
button[aria-pressed='true'] {
  background: #333;
  color: white;
}
</style>
