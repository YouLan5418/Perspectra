<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { StageBox, StageCharacter } from '../../../../desktop/host/pack-frontend.ts'
import type { CreatorStage } from './source.ts'
import { useCreatorStore } from './store.ts'

/**
 * 立绘标记：在底图上拖出头顶、腰部和脸部框，右侧按默认舞台的取景规则即时预览，保存后写回包里的
 * frontend/stage.json（只改这个角色的 framing 和 face，表情、拼合图、姿势原样保留）。
 */
const store = useCreatorStore()
const data = ref<CreatorStage | null>(null)
const error = ref('')
const notice = ref('')
const saving = ref(false)
const characterId = ref('')
const expression = ref('')
const marks = reactive<{ top: number; waist: number; face: [number, number, number, number] | null }>({
  top: 0.03,
  waist: 0.48,
  face: null,
})
// 默认舞台对没标过的立绘按全身图处理；脸部框只给局部贴片用。
const UNMARKED = { top: 0.03, waist: 0.48 }
const NEW_FACE: StageBox = [0.4, 0.08, 0.2, 0.12]

const url = (path: string) => '/frontend/custom/' + path.split('/').map(encodeURIComponent).join('/')
/** 与默认舞台相同：portraits/ 下以角色 ID 冒号后部分命名的 PNG 或 WebP。 */
function portraitOf(id: string) {
  const slug = id.replace(/^[^:]+:/, '')
  return ['png', 'webp']
    .map(extension => `portraits/${slug}.${extension}`)
    .find(path => data.value?.portraits?.includes(path))
}
const characters = computed(() => store.meta.characters.map(c => ({ ...c, portrait: portraitOf(c.id) })))
const own = computed<StageCharacter | undefined>(() => data.value?.stage?.characters[characterId.value])
const portrait = computed(() => portraitOf(characterId.value))
const expressions = computed(() => Object.keys(own.value?.expressions ?? {}))

function reset() {
  const saved = own.value
  marks.top = saved?.framing?.top ?? UNMARKED.top
  marks.waist = saved?.framing?.waist ?? UNMARKED.waist
  marks.face = saved?.face ? [...saved.face] : null
  expression.value = saved?.defaultExpression ?? expressions.value[0] ?? ''
}
const round = (n: number) => Math.round(n * 10000) / 10000
const dirty = computed(() => {
  const saved = own.value
  return (
    round(marks.top) !== (saved?.framing?.top ?? UNMARKED.top) ||
    round(marks.waist) !== (saved?.framing?.waist ?? UNMARKED.waist) ||
    JSON.stringify(marks.face?.map(round) ?? null) !== JSON.stringify(saved?.face ?? null) ||
    (!saved?.framing && !!portrait.value)
  )
})

onMounted(async () => {
  try {
    data.value = await store.readStage()
    characterId.value = characters.value.find(c => c.portrait)?.id ?? characters.value[0]?.id ?? ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
})
watch(characterId, () => {
  notice.value = ''
  reset()
})

/* 拖动：坐标都换成占底图宽高的比例，和 stage.json 的写法一致。 */
const canvas = ref<HTMLElement | null>(null)
const clamp = (n: number, low: number, high: number) => Math.min(Math.max(n, low), high)
function drag(kind: 'top' | 'waist' | 'move' | 'resize', event: PointerEvent) {
  const box = canvas.value?.getBoundingClientRect()
  if (!box) return
  event.preventDefault()
  const start = { x: event.clientX, y: event.clientY, face: marks.face ? ([...marks.face] as StageBox) : null }
  const move = (moveEvent: PointerEvent) => {
    const x = (moveEvent.clientX - box.left) / box.width,
      y = (moveEvent.clientY - box.top) / box.height
    const dx = (moveEvent.clientX - start.x) / box.width,
      dy = (moveEvent.clientY - start.y) / box.height
    if (kind === 'top') marks.top = round(clamp(y, 0, marks.waist - 0.02))
    else if (kind === 'waist') marks.waist = round(clamp(y, marks.top + 0.02, 1))
    else if (start.face && marks.face) {
      const [left, top, width, height] = start.face
      const face: StageBox =
        kind === 'move'
          ? [clamp(left + dx, 0, 1 - width), clamp(top + dy, 0, 1 - height), width, height]
          : [left, top, clamp(x - left, 0.02, 1 - left), clamp(y - top, 0.02, 1 - top)]
      marks.face = face.map(round) as [number, number, number, number]
    }
    notice.value = ''
  }
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
}
function setFace(index: number, value: number) {
  if (!marks.face || !Number.isFinite(value)) return
  marks.face[index] = clamp(value, 0, 1)
}

/** 当前表情画在哪里、怎么画；规则与默认舞台的 dress() 相同，脸部框用正在拖的那一个。 */
const layer = computed(() => {
  const value = expression.value ? own.value?.expressions?.[expression.value] : undefined
  if (!value) return null
  if (typeof value === 'string') return { kind: 'layer' as const, src: url(value), own: false }
  const box = value.at ?? marks.face
  if (!box) return null
  const place = {
    left: box[0] * 100 + '%',
    top: box[1] * 100 + '%',
    width: box[2] * 100 + '%',
    height: box[3] * 100 + '%',
  }
  if ('image' in value) return { kind: 'image' as const, src: url(value.image), style: place, own: !!value.at }
  const sheet = own.value?.sheets?.[value.sheet]
  if (!sheet) return null
  const column = value.cell % sheet.columns,
    row = Math.floor(value.cell / sheet.columns)
  return {
    kind: 'cell' as const,
    own: !!value.at,
    style: {
      ...place,
      backgroundImage: `url("${url(sheet.image)}")`,
      backgroundSize: `${sheet.columns * 100}% ${sheet.rows * 100}%`,
      backgroundPosition: `${sheet.columns > 1 ? (column / (sheet.columns - 1)) * 100 : 0}% ${sheet.rows > 1 ? (row / (sheet.rows - 1)) * 100 : 0}%`,
    },
  }
})

async function save() {
  saving.value = true
  error.value = ''
  try {
    data.value = await store.saveStage(characterId.value, {
      framing: { top: round(marks.top), waist: round(marks.waist) },
      ...(marks.face ? { face: marks.face.map(round) as unknown as StageBox } : {}),
    })
    notice.value = '已写入 frontend/stage.json。重新打开游戏页面后舞台按新标记显示。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="cr-scroll st-root">
    <p v-if="error" class="cr-banner danger" role="alert">{{ error }}</p>
    <p v-if="data && !data.editable" class="cr-banner warn">
      {{
        store.preview
          ? '浏览器预览没有立绘；从启动器打开创作者页面后可以标记运行中游戏的立绘。'
          : '这个包没有使用默认舞台的立绘（没有 frontend/ 目录，或使用了自己的页面），没有可标记的内容。'
      }}
    </p>
    <template v-else-if="data">
      <div class="st-toolbar">
        <label>
          角色
          <select v-model="characterId" class="cr-select">
            <option v-for="c in characters" :key="c.id" :value="c.id" :disabled="!c.portrait">
              {{ c.name }}{{ c.portrait ? '' : '（没有立绘）' }}
            </option>
          </select>
        </label>
        <label v-if="expressions.length">
          预览表情
          <select v-model="expression" class="cr-select">
            <option value="">不叠表情</option>
            <option v-for="name in expressions" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <span class="st-spacer" />
        <button class="cr-button" :disabled="!dirty || saving" @click="reset">还原</button>
        <button class="cr-button primary" :disabled="!portrait || !dirty || saving" @click="save">
          {{ saving ? '保存中…' : '保存到 stage.json' }}
        </button>
      </div>
      <p v-if="notice" class="st-notice" role="status">{{ notice }}</p>
      <p v-if="!portrait" class="cr-banner warn">
        这个角色没有立绘。把图片放在包的 frontend/portraits/ 下，用角色 ID 冒号后的部分命名（PNG 或 WebP）。
      </p>

      <div v-else class="st-panes">
        <section class="st-pane">
          <h3>在立绘上标记</h3>
          <p class="st-hint">拖动两条线标出头顶和腰部；拖动脸部框移动，拖右下角改大小。</p>
          <div ref="canvas" class="st-canvas">
            <img :src="url(portrait)" alt="" draggable="false" />
            <img v-if="layer?.kind === 'layer'" class="st-layer" :src="layer.src" alt="" />
            <img v-else-if="layer?.kind === 'image'" class="st-patch" :src="layer.src" :style="layer.style" alt="" />
            <div v-else-if="layer?.kind === 'cell'" class="st-patch" :style="layer.style" />
            <div class="st-line" :style="{ top: marks.top * 100 + '%' }" @pointerdown="drag('top', $event)">
              <span>头顶</span>
            </div>
            <div class="st-line waist" :style="{ top: marks.waist * 100 + '%' }" @pointerdown="drag('waist', $event)">
              <span>腰部</span>
            </div>
            <div
              v-if="marks.face"
              class="st-face"
              :style="{
                left: marks.face[0] * 100 + '%',
                top: marks.face[1] * 100 + '%',
                width: marks.face[2] * 100 + '%',
                height: marks.face[3] * 100 + '%',
              }"
              @pointerdown.self="drag('move', $event)"
            >
              <span>脸部</span>
              <i aria-hidden="true" @pointerdown.stop="drag('resize', $event)" />
            </div>
          </div>
        </section>

        <section class="st-pane">
          <h3>舞台上的样子</h3>
          <p class="st-hint">虚线是舞台的头顶线和腰部线；腰部以下会被对话框挡住。</p>
          <div class="st-stage">
            <div class="st-guide" style="top: 9%" />
            <div class="st-guide" style="top: 78%" />
            <div class="st-figure" :style="{ '--top': marks.top, '--waist': marks.waist }">
              <img :src="url(portrait)" alt="" />
              <img v-if="layer?.kind === 'layer'" class="st-layer" :src="layer.src" alt="" />
              <img v-else-if="layer?.kind === 'image'" class="st-patch" :src="layer.src" :style="layer.style" alt="" />
              <div v-else-if="layer?.kind === 'cell'" class="st-patch" :style="layer.style" />
            </div>
          </div>

          <div class="st-fields">
            <label
              >头顶 <input v-model.number="marks.top" class="cr-input" type="number" step="0.005" min="0" max="1"
            /></label>
            <label
              >腰部 <input v-model.number="marks.waist" class="cr-input" type="number" step="0.005" min="0" max="1"
            /></label>
          </div>
          <div v-if="marks.face" class="st-fields">
            <label v-for="(label, index) in ['左', '上', '宽', '高']" :key="label">
              {{ label }}
              <input
                class="cr-input"
                type="number"
                step="0.005"
                min="0"
                max="1"
                :value="marks.face[index]"
                @change="setFace(index, Number(($event.target as HTMLInputElement).value))"
              />
            </label>
            <button class="cr-button tiny" @click="marks.face = null">去掉脸部框</button>
          </div>
          <p v-else class="st-hint">
            没有脸部框。局部贴片和拼合图表情默认贴在脸部框里。
            <button class="cr-button tiny" @click="marks.face = [...NEW_FACE]">标出脸部</button>
          </p>
          <p v-if="layer?.own" class="st-hint">这个表情在 stage.json 里写了自己的 at，不跟脸部框走。</p>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.st-root {
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.st-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.st-toolbar label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--cr-dim);
}
.st-spacer {
  flex: 1;
}
.st-notice {
  margin: 0;
  color: var(--cr-context);
}
.st-panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  gap: 18px;
  align-items: start;
}
.st-pane h3 {
  margin: 0 0 2px;
  font-size: 13px;
}
.st-hint {
  margin: 0 0 8px;
  color: var(--cr-faint);
  font-size: 12px;
}
.st-canvas {
  position: relative;
  display: inline-block;
  max-width: 100%;
  user-select: none;
  touch-action: none;
  background: repeating-conic-gradient(var(--cr-panel-2) 0 25%, var(--cr-panel-3) 0 50%) 0 0 / 16px 16px;
}
.st-canvas > img:first-child {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: max(320px, calc(100dvh - 260px));
}
.st-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.st-patch {
  position: absolute;
  background-repeat: no-repeat;
  pointer-events: none;
}
img.st-patch {
  object-fit: fill;
}
.st-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  border-top: 2px solid var(--cr-blue);
  cursor: ns-resize;
}
.st-line::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -7px;
  height: 14px;
}
.st-line.waist {
  border-color: var(--cr-action);
}
.st-line span,
.st-face span {
  position: absolute;
  left: 4px;
  top: -20px;
  padding: 0 5px;
  font-size: 11px;
  border-radius: 3px;
  background: var(--cr-panel);
  color: var(--cr-text);
  pointer-events: none;
}
.st-face {
  position: absolute;
  border: 2px dashed var(--cr-context);
  cursor: move;
}
.st-face span {
  top: -20px;
}
.st-face i {
  position: absolute;
  right: -6px;
  bottom: -6px;
  width: 12px;
  height: 12px;
  background: var(--cr-context);
  cursor: nwse-resize;
}
/* 与默认舞台 stage-style 的取景公式相同：头顶落在 9%，腰部落在 78%。 */
.st-stage {
  --head-y: 9%;
  --waist-y: 78%;
  --span: calc(var(--waist-y) - var(--head-y));
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--cr-line-2);
  background: linear-gradient(var(--cr-panel-2), var(--cr-panel-3));
}
.st-guide {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--cr-faint);
}
.st-figure {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  height: calc(var(--span) / (var(--waist) - var(--top)));
  top: calc(var(--head-y) - var(--span) * var(--top) / (var(--waist) - var(--top)));
}
.st-figure > img:first-child {
  display: block;
  height: 100%;
  width: auto;
  max-width: none;
}
.st-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.st-fields label {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--cr-dim);
}
.st-fields .cr-input {
  width: 76px;
}
@media (max-width: 900px) {
  .st-panes {
    grid-template-columns: 1fr;
  }
}
</style>
