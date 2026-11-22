<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { editorRequest } from './editor-api.ts'
import type { stageBook } from '../../../host/src/editor/stage.ts'
import type { stageArtPreview } from '../../../host/src/editor/stage-art.ts'
import type { ConfigObject } from '@perspectra/world-pack/editor-config'
import ModeConfigFields from './ModeConfigFields.vue'

type Book = Awaited<ReturnType<typeof stageBook>>
const props = defineProps<{ asset?: { kind: 'portrait' | 'background'; id: string } }>()
const book = ref<Book>(),
  draft = ref<ConfigObject>(),
  busy = ref(false),
  error = ref(''),
  notice = ref('')
const tab = ref<'art' | 'stage' | 'components'>('art')
const kind = ref<'portrait' | 'background' | 'layer' | 'cover'>(props.asset?.kind ?? 'portrait'),
  owner = ref(props.asset?.id ?? ''),
  layer = ref('')
const file = ref<File>(),
  picker = ref<HTMLInputElement>(),
  preview = ref<ReturnType<typeof stageArtPreview>>()
const owners = computed(() => (kind.value === 'background' ? book.value?.locations : book.value?.characters))
const path = computed(() => {
  const b = book.value
  if (!b) return
  if (kind.value === 'cover') return b.cover
  if (kind.value === 'layer') return b.files.find(p => p === 'frontend/portraits/' + layer.value)
  return (kind.value === 'portrait' ? b.portraits : b.backgrounds)[owner.value]
})
watch([kind, owners], () => {
  if (props.asset) return
  if (!owners.value?.some(o => o.id === owner.value)) owner.value = owners.value?.[0]?.id ?? ''
})
function clearFile() {
  file.value = undefined
  if (picker.value) picker.value.value = ''
}
watch([kind, owner], clearFile)
async function show(selected: string | null | undefined) {
  preview.value = undefined
  if (!selected) return
  try {
    const seen = await editorRequest<ReturnType<typeof stageArtPreview>>('stage-art-preview', { path: selected })
    if (selected === path.value) preview.value = seen
  } catch (e) {
    if (selected === path.value) error.value = (e as Error).message
  }
}
watch(path, show)
const dirty = computed(() => !!book.value && JSON.stringify(book.value.config) !== JSON.stringify(draft.value))
function load(b: Book) {
  book.value = b
  draft.value = JSON.parse(JSON.stringify(b.config))
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
async function reload(next = tab.value) {
  load(await editorRequest<Book>('stage', { kind: next === 'components' ? 'components' : 'stage' }))
}
async function save() {
  if (!book.value || !dirty.value) return
  load(await editorRequest<Book>('stage-save', { kind: book.value.kind, base: book.value.config, config: draft.value }))
  notice.value = '舞台配置已保存'
}
async function choose(next: typeof tab.value) {
  if (next === tab.value) return
  await save()
  await reload(next)
  tab.value = next
}
function select(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0]
  if (kind.value === 'layer' && !layer.value && file.value) layer.value = file.value.name
}
async function upload() {
  const selected = file.value
  if (!selected || !book.value) return
  if (selected.size > 4 * 1024 * 1024) throw new Error('每次可导入最多 4 MiB 的图片')
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1]!)
    reader.onerror = () => reject(new Error('无法读取所选图片'))
    reader.readAsDataURL(selected)
  })
  if (path.value && preview.value?.path !== path.value) throw new Error('请等待当前图片预览载入')
  const result = await editorRequest<{ path: string }>('stage-art-import', {
    kind: kind.value,
    id: owner.value,
    name: layer.value,
    base: preview.value?.base ?? null,
    base64: data,
  })
  await reload()
  await show(result.path)
  clearFile()
  notice.value = '图片已保存到 ' + result.path
}
defineExpose({
  async flush() {
    if (busy.value) throw new Error('请等舞台操作完成')
    if (props.asset && file.value) await upload()
    await save()
  },
})
onMounted(() => run(() => reload()))
</script>
<template>
  <section class="stage-editor">
    <h2 v-if="!asset">舞台与美术</h2>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <fieldset :disabled="busy">
      <nav v-if="!asset" aria-label="舞台设置">
        <button
          v-for="(caption, id) in { art: '图片素材', stage: '立绘与开场', components: '组件布局' }"
          :key="id"
          :aria-current="id === tab ? 'page' : undefined"
          @click="run(() => choose(id))"
        >
          {{ caption }}
        </button>
      </nav>
      <p v-if="!asset && book?.customPage">此包有自定义首页。立绘取景和组件布局用于官方默认舞台。</p>
      <template v-if="book && tab === 'art'">
        <label v-if="!asset"
          >素材用途<select v-model="kind" aria-label="素材用途">
            <option value="portrait">角色底图</option>
            <option value="background">地点背景</option>
            <option value="layer">表情、拼合图与姿势</option>
            <option value="cover">作品封面</option>
          </select></label
        >
        <label v-if="!asset && (kind === 'portrait' || kind === 'background')"
          >{{ kind === 'portrait' ? '角色' : '地点'
          }}<select v-model="owner" :aria-label="kind === 'portrait' ? '角色' : '地点'">
            <option v-for="o in owners" :key="o.id" :value="o.id">{{ o.name }} · {{ o.id }}</option>
          </select></label
        >
        <template v-if="kind === 'layer'">
          <label
            >已有图层<select :value="layer" @change="layer = ($event.target as HTMLSelectElement).value">
              <option value="">新增图层</option>
              <option v-for="im in book.images" :key="im" :value="im.slice(10)">{{ im.slice(10) }}</option>
            </select></label
          >
          <label>图层文件名<input v-model="layer" placeholder="例如 alin/smile.png" /></label>
        </template>
        <figure v-if="preview && path === preview.path">
          <img :src="preview.data" alt="当前舞台素材预览" />
          <figcaption>{{ preview.path }}</figcaption>
        </figure>
        <label
          >选择图片（最多 4 MiB）<input
            ref="picker"
            type="file"
            :accept="
              kind === 'portrait' || kind === 'layer' ? 'image/png,image/webp' : 'image/png,image/webp,image/jpeg'
            "
            @change="select"
        /></label>
        <button :disabled="!file || (!!path && !preview)" @click="run(upload)">
          {{ path ? '替换当前图片' : '导入图片' }}
        </button>
        <button v-if="asset && file" @click="clearFile">取消选图</button>
      </template>
      <template v-else-if="book && draft">
        <p v-for="w in book.warnings" :key="w">{{ w }}</p>
        <button v-if="book.usableLayout" @click="draft = JSON.parse(JSON.stringify(book.usableLayout))">
          载入运行时采用的布局到草稿
        </button>
        <ModeConfigFields
          :key="book.kind"
          :mode="book.kind"
          :schema="book.schema"
          :config="draft"
          :records="book"
          :initial="book.kind === 'components' ? 'components' : 'characters'"
          @change="v => (draft = v)"
        />
        <div>
          <button :disabled="!dirty" @click="run(save)">保存舞台配置</button
          ><button v-if="dirty" @click="run(() => reload())">放弃本节修改并重新载入</button>
        </div>
      </template>
    </fieldset>
  </section>
</template>
<style scoped>
.stage-editor {
  padding: 1rem;
  color: #292929;
}
fieldset {
  border: 0;
  padding: 0;
  display: grid;
  gap: 0.7rem;
  justify-items: start;
  min-width: 0;
}
nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}
button,
select,
input {
  padding: 0.35rem 0.55rem;
}
label {
  display: grid;
  gap: 0.25rem;
}
figure {
  margin: 0;
}
img {
  display: block;
  max-width: min(25rem, 100%);
  max-height: 16rem;
  object-fit: contain;
}
figcaption {
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
</style>
