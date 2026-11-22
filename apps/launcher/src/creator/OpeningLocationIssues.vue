<script setup lang="ts">
import { choiceNames, type OpeningLocationIssue, type SceneBindingIssue } from '@perspectra/world-pack/editor-fields'
defineProps<{ issues: OpeningLocationIssue[]; bindings: SceneBindingIssue[] }>()
const emit = defineEmits<{ locate: [kind: 'character' | 'scene', id: string, field: string] }>()
</script>
<template>
  <section
    v-if="bindings.length"
    id="scene-binding-problems"
    tabindex="-1"
    class="location-issues"
    aria-label="地点绑定多个未关闭场景"
  >
    <strong>地点绑定多个未关闭场景</strong>
    <div v-for="issue in bindings" :key="issue.locationId">
      进入「{{ issue.locationName }}」时无法确定要加入哪个场景。请选择场景修改地点或开局状态：
      <ul>
        <li v-for="s in issue.scenes" :key="s.id">
          <button type="button" @click="emit('locate', 'scene', s.id, 'locationId')">
            {{ s.id || '当前新场景' }} · {{ choiceNames[s.lifecycle] }}
          </button>
        </li>
      </ul>
    </div>
  </section>
  <section v-if="issues.length" class="location-issues" aria-label="开局地点冲突">
    <strong>开局地点冲突</strong>
    <div v-for="issue in issues" :key="issue.characterId + '/' + issue.sceneId">
      <button type="button" @click="emit('locate', 'character', issue.characterId, 'initialLocationId')">
        {{ issue.characterName }} · 初始地点「{{ issue.initialLocation }}」
      </button>
      与开局场景
      <button type="button" @click="emit('locate', 'scene', issue.sceneId, 'locationId')">
        {{ issue.sceneName }} · 所在地点「{{ issue.sceneLocation }}」
      </button>
      不一致。<button type="button" @click="emit('locate', 'scene', issue.sceneId, 'participantIds')">
        定位参与角色
      </button>
    </div>
  </section>
</template>
<style scoped>
.location-issues {
  padding: 10px 12px;
  margin: 12px 0;
  color: #9b2020;
  background: #fff5f5;
  border-left: 3px solid #ae3030;
  font-size: 14px;
}
.location-issues div {
  margin-top: 5px;
}
.location-issues ul {
  margin: 4px 0;
  padding-inline-start: 20px;
}
.location-issues button {
  font: inherit;
  cursor: pointer;
  color: inherit;
  background: transparent;
  border: 0;
  text-decoration: underline;
  padding: 1px 2px;
}
</style>
