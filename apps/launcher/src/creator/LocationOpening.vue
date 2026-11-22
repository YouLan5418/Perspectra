<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { openScenesByLocation, type WorldRecord } from '@perspectra/world-pack/editor-fields'
import { editorRequest } from './editor-api.ts'

const props = defineProps<{ locationId: string; records: WorldRecord[]; refresh: () => Promise<void> }>()
const emit = defineEmits<{ save: []; scene: [id: string]; actor: [id: string] }>()
const scenes = computed(() => openScenesByLocation(props.records).get(props.locationId) ?? [])
const scene = computed(() => scenes.value[0])
const actors = computed(() => props.records.filter(r => r.kind === 'character'))
const otherScenes = computed(() => {
  const members = new Map<string, WorldRecord>()
  for (const s of props.records) {
    if (s.kind === 'scene' && s.values.lifecycle === 'active' && s.id !== scene.value?.id)
      for (const id of s.values.participantIds as string[]) members.set(id, s)
  }
  return members
})
const draft = ref<{ scene: WorldRecord | null; ids: string[] }>()
const atOpening = (s: WorldRecord | null | undefined) =>
  s?.values.lifecycle === 'active' ? (s.values.participantIds as string[]) : []
const selected = computed(() => draft.value?.ids ?? atOpening(scene.value))
const search = ref('')
const visibleActors = computed(() =>
  actors.value.filter(a => (a.name + ' ' + a.id).toLowerCase().includes(search.value.trim().toLowerCase())),
)
function toggle(id: string, checked: boolean) {
  const base = draft.value ? draft.value.scene : (scene.value ?? null)
  const ids = checked ? [...selected.value, id] : selected.value.filter(member => member !== id)
  const original = atOpening(base)
  draft.value =
    ids.length === original.length && ids.every(member => original.includes(member)) ? undefined : { scene: base, ids }
}
async function flush() {
  if (!draft.value) return
  const { scene: base, ids } = draft.value
  try {
    await editorRequest('location-opening-save', {
      locationId: props.locationId,
      sceneId: base?.id ?? null,
      base: base?.values ?? null,
      participantIds: ids,
    })
  } catch (error) {
    await props.refresh()
    await nextTick()
    if ((error as { status?: number }).status === 409) {
      draft.value = undefined
      throw new Error('地点的场景配置已被其他编辑更新，已重新载入开局名单。')
    }
    if (scenes.value.length > 1) draft.value = undefined
    throw error
  }
  draft.value = undefined
  await props.refresh()
}
defineExpose({ flush })
</script>
<template>
  <section v-if="scenes.length <= 1" class="opening-members" aria-label="开局参与互动的角色">
    <header class="scene-heading">
      <h2>开局参与互动的角色</h2>
      <div class="scene-status">
        <span>{{ scene?.values.lifecycle === 'active' ? '开局启用' : scene ? '尚未启用' : '尚无互动场景' }}</span>
        <button v-if="scene" type="button" @click="emit('scene', scene.id)">查看场景配置</button>
      </div>
    </header>
    <p v-if="!scene">选好角色并保存后，将在此地点创建开局场景。</p>
    <p v-else-if="scene.values.lifecycle === 'created'">
      选好角色并保存后，将使用所选名单启用此场景。<template v-if="(scene.values.participantIds as string[]).length"
        >原预设成员：{{
          actors
            .filter(a => (scene!.values.participantIds as string[]).includes(a.id))
            .map(a => a.name)
            .join('、')
        }}。</template
      >
    </p>
    <p v-else-if="draft && !selected.length">保存后，此场景将设为「尚未启用」，角色仍可在游戏中进入。</p>
    <input
      v-if="actors.length > 8"
      type="search"
      v-model="search"
      aria-label="搜索开局参与角色"
      placeholder="按角色名或 ID 查找"
    />
    <div class="member-list">
      <div v-for="actor in visibleActors" :key="actor.id">
        <label>
          <input
            type="checkbox"
            :checked="selected.includes(actor.id)"
            :disabled="otherScenes.has(actor.id) && !selected.includes(actor.id)"
            @change="toggle(actor.id, ($event.target as HTMLInputElement).checked)"
          />
          {{ actor.name }}
        </label>
        <button v-if="otherScenes.has(actor.id)" type="button" @click="emit('scene', otherScenes.get(actor.id)!.id)">
          已参与 {{ otherScenes.get(actor.id)!.name }}
        </button>
        <button
          v-else-if="selected.includes(actor.id) && actor.values.initialLocationId !== locationId"
          type="button"
          class="warning"
          @click="emit('actor', actor.id)"
        >
          初始地点不一致
        </button>
      </div>
    </div>
    <p v-if="!visibleActors.length">没有匹配的角色。</p>
    <div v-if="draft" class="actions">
      <button type="button" @click="emit('save')">保存开局参与角色</button>
      <button type="button" @click="draft = undefined">放弃名单修改</button>
    </div>
  </section>
</template>
<style scoped>
.opening-members {
  border-top: 1px solid var(--work-line);
  margin-top: 24px;
  padding-top: 18px;
}
.scene-heading,
.scene-status,
.actions,
.member-list > div {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
}
.scene-heading {
  justify-content: space-between;
  margin-bottom: 10px;
}
h2 {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.4;
  margin: 0;
}
.scene-status,
p {
  color: var(--work-muted);
  font-size: 13px;
}
.scene-status button,
.member-list button {
  color: var(--work-ink);
  cursor: pointer;
  background: none;
  border: 0;
  text-decoration: underline;
  text-underline-offset: 3px;
  padding: 3px 0;
  font-size: 13px;
}
.member-list {
  margin-block: 8px;
}
.opening-members input[type='search'] {
  width: 100%;
  margin-top: 6px;
  padding: 7px 10px;
  border: 1px solid #bdbdbd;
  border-radius: 4px;
  background: white;
  color: var(--work-ink);
}
.member-list > div {
  justify-content: space-between;
  border-bottom: 1px solid var(--work-line);
}
.member-list label {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  min-height: 36px;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.member-list input[type='checkbox'] {
  width: 16px;
  height: 16px;
  flex: none;
  accent-color: var(--work-ink);
}
.member-list label:has(:checked) {
  font-weight: 650;
}
.member-list label:has(:disabled) {
  color: var(--work-muted);
}
.member-list .warning {
  color: #a02020;
}
.actions button {
  border: 1px solid #bdbdbd;
  border-radius: 3px;
  cursor: pointer;
  padding: 6px 10px;
}
.actions button:first-child {
  color: white;
  background: var(--work-ink);
  border-color: var(--work-ink);
}
</style>
