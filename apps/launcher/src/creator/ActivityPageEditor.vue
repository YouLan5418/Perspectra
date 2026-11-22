<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { editorRequest } from './editor-api.ts'
import type { activityPages } from '../../../host/src/editor/activity-pages.ts'
import ActivityPageRules from './ActivityPageRules.vue'
import type { PageElement } from '../../../host/src/runtime/activity-page-rules.ts'
const props = defineProps<{ initial?: string | undefined; initialElement?: string | undefined }>()
const elements = ref<PageElement[]>([])
type Book = Awaited<ReturnType<typeof activityPages>>
type Binding = Book['bindings'][string]
const book = ref<Book>(),
  key = ref(''),
  html = ref(''),
  css = ref(''),
  base = ref<Binding | null>(null)
const search = ref(''),
  folder = ref(''),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  scenes = ref<Record<string, string>>({})
const preview = ref<{ url: string; started: boolean }>(),
  conflict = ref<{ current: Binding | null }>()
const value = computed(() =>
  html.value
    ? {
        html: html.value,
        ...(css.value ? { css: css.value } : {}),
        ...(elements.value.length ? { elements: elements.value } : {}),
      }
    : null,
)
const dirty = computed(() => JSON.stringify(base.value) !== JSON.stringify(value.value))
const activities = computed(() => {
  const rows = book.value?.activities ?? []
  const stale = Object.keys(book.value?.bindings ?? {})
    .filter(id => !rows.some(a => a.key === id))
    .map(key => ({ key, title: '失效引用' }))
  return [...rows, ...stale].filter(a => (a.title + ' ' + a.key).toLowerCase().includes(search.value.toLowerCase()))
})
const files = (extension: string) => book.value?.files.filter(f => f.toLowerCase().endsWith(extension)) ?? []
watch(
  [key, html, css, scenes, elements],
  () => {
    preview.value = undefined
  },
  { deep: true },
)
function pick(id: string) {
  key.value = id
  base.value = book.value && Object.hasOwn(book.value.bindings, id) ? book.value.bindings[id]! : null
  html.value = base.value?.html ?? ''
  css.value = base.value?.css ?? ''
  elements.value = JSON.parse(JSON.stringify(base.value?.elements ?? []))
  conflict.value = undefined
  preview.value = undefined
}
async function refresh() {
  book.value = await editorRequest<Book>('activity-pages')
}
async function run(work: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await work()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function save() {
  if (conflict.value) throw Error('请先处理页面绑定冲突')
  if (!dirty.value) return
  try {
    await editorRequest('activity-page-save', { key: key.value, base: base.value, page: value.value })
  } catch (e) {
    const err = e as { status?: number; details?: { current: Binding | null } }
    if (err.status === 409 && err.details) conflict.value = { current: err.details.current }
    throw e
  }
  await refresh()
  pick(key.value)
  notice.value = '页面绑定已保存'
}
async function flush() {
  if (busy.value) throw Error('活动页面正在处理')
  busy.value = true
  try {
    await save()
  } finally {
    busy.value = false
  }
}
defineExpose({ flush })
async function choose(id: string) {
  await save()
  pick(id)
}
async function resolve(useMine: boolean) {
  if (!conflict.value) return
  if (useMine) {
    base.value = conflict.value.current
    conflict.value = undefined
    await save()
  } else {
    await refresh()
    pick(key.value)
  }
}
async function upload(e: Event) {
  const input = e.target as HTMLInputElement,
    list = Array.from(input.files ?? [])
  input.value = ''
  await run(async () => {
    const prefix = folder.value.trim().replace(/^\/+|\/+$/g, '')
    for (const f of list) {
      const path = ['activities', prefix, f.name].filter(Boolean).join('/')
      if (f.size > 4 * 1024 * 1024) throw Error('每次可导入最多 4 MiB 的文件')
      if (/\.(html|css)$/i.test(f.name)) await editorRequest('activity-page-import', { path, text: await f.text() })
      else {
        const reader = new FileReader()
        const base64 = await new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
          reader.onerror = () => reject(Error('无法读取图片：' + f.name))
          reader.readAsDataURL(f)
        })
        await editorRequest('activity-page-import', { path, base64 })
      }
      await refresh()
      if (path.toLowerCase().endsWith('.html')) html.value = path
      else if (path.toLowerCase().endsWith('.css')) css.value = path
    }
    notice.value = '文件已导入，可保存当前活动的绑定'
  })
}
async function play() {
  await save()
  preview.value = await editorRequest('activity-page-preview', {
    key: key.value,
    scenes: Object.fromEntries(Object.entries(scenes.value).filter(([, id]) => id)),
  })
}
onMounted(
  () =>
    void run(async () => {
      await refresh()
      pick(activities.value.find(a => a.key === props.initial)?.key ?? activities.value[0]?.key ?? '')
    }),
)
</script>
<template>
  <section class="page-desk">
    <h2>活动专属页面</h2>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="busy || notice" role="status">{{ busy ? '正在处理…' : notice }}</p>
    <fieldset :disabled="busy">
      <aside>
        <label>查找活动<input type="search" v-model="search" placeholder="活动名称或键" /></label>
        <button v-for="a in activities" :key="a.key" :aria-pressed="key === a.key" @click="run(() => choose(a.key))">
          <b>{{ a.title }}</b
          ><small>{{ a.key }}</small>
        </button>
        <p v-if="!activities.length">没有匹配的活动。</p>
      </aside>
      <article v-if="key">
        <h3>{{ book?.activities.find(a => a.key === key)?.title ?? key }}</h3>
        <label
          >舞台 HTML<select v-model="html" @change="!html && (css = '')">
            <option value="">使用原舞台</option>
            <option v-if="html && !files('.html').includes(html)" :value="html">文件缺失 · {{ html }}</option>
            <option v-for="f in files('.html')" :key="f">{{ f }}</option>
          </select></label
        >
        <label
          >附加 CSS · 选填<select v-model="css" :disabled="!html">
            <option value="">沿用 HTML 内的样式和样式表</option>
            <option v-if="css && !files('.css').includes(css)" :value="css">文件缺失 · {{ css }}</option>
            <option v-for="f in files('.css')" :key="f">{{ f }}</option>
          </select></label
        >
        <details>
          <summary>导入 HTML、CSS 和图片</summary>
          <label>存入 frontend/activities/ 下的子目录 · 选填<input v-model="folder" placeholder="例如 porch" /></label
          ><label
            >选择文件<input type="file" multiple accept=".html,.css,.png,.jpg,.jpeg,.webp,.gif,.svg" @change="upload"
          /></label>
        </details>
        <ActivityPageRules
          v-if="html && book"
          :key="key"
          v-model="elements"
          :activity="key"
          :initial-element="key === props.initial ? props.initialElement : undefined"
          :html="html"
          :scenes="scenes"
          :files="book.files"
        />
        <div v-if="conflict" role="alert">
          当前保存的绑定：{{ conflict.current?.html ?? '原舞台' }} {{ conflict.current?.css }}
          <button @click="run(() => resolve(false))">读取已保存绑定</button
          ><button @click="run(() => resolve(true))">保留我的绑定</button>
        </div>
        <div class="actions">
          <button :disabled="!dirty || !!conflict" @click="run(save)">保存页面绑定</button
          ><button
            @click="
              run(async () => {
                await refresh()
                pick(key)
              })
            "
          >
            重新读取
          </button>
        </div>
        <details>
          <summary>试玩起点</summary>
          <label v-for="c in book?.characters" :key="c.id"
            >{{ c.name
            }}<select v-model="scenes[c.id]">
              <option value="">使用包内开局</option>
              <option v-for="s in book?.scenes" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select></label
          >
        </details>
        <div class="actions">
          <button :disabled="!html || !!conflict" @click="run(play)">预览活动页面</button
          ><a v-if="preview" :href="preview.url" target="_blank" rel="noreferrer">打开试玩窗口 ↗</a>
        </div>
        <p v-if="preview && !preview.started">试玩已从所选起点开始，请在游戏中满足活动的进入条件。</p>
      </article>
    </fieldset>
  </section>
</template>
<style scoped>
.page-desk {
  padding: 22px 26px;
  color: #243e35;
}
h2,
h3 {
  margin: 0 0 14px;
}
fieldset {
  display: grid;
  grid-template-columns: minmax(160px, 30%) minmax(0, 1fr);
  padding: 0;
  border: 0;
  border-top: 1px solid #bbc9be;
  min-width: 0;
}
aside,
article {
  padding: 16px 0;
  min-width: 0;
}
aside {
  padding-right: 14px;
  border-right: 1px solid #bbc9be;
}
article {
  padding-left: 18px;
  max-width: 720px;
}
label {
  display: grid;
  gap: 5px;
  margin: 10px 0;
}
input,
select {
  padding: 7px;
  border: 1px solid #a7b9ac;
  border-radius: 4px;
  background: white;
  width: 100%;
  color: inherit;
  box-sizing: border-box;
}
button {
  cursor: pointer;
  background: white;
  color: inherit;
  border: 1px solid #a7b9ac;
  border-radius: 4px;
  padding: 6px 10px;
}
button:disabled {
  cursor: default;
  opacity: 0.55;
}
aside button {
  width: 100%;
  text-align: left;
  margin: 4px 0;
}
small {
  display: block;
  overflow-wrap: anywhere;
}
button[aria-pressed='true'] {
  background: #285344;
  color: white;
}
summary {
  cursor: pointer;
}
details,
.actions {
  margin: 16px 0;
}
.actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
a {
  color: #285344;
}
[role='alert'] {
  color: #953528;
}
@media (max-width: 760px) {
  fieldset {
    grid-template-columns: 1fr;
  }
  aside {
    border-right: 0;
  }
  article {
    padding-left: 0;
  }
}
</style>
