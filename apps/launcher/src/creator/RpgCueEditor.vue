<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import type { rpgBook, RpgSource } from '../../../host/src/editor/rpg.ts'
import { cueCandidates, cueFlow, cueOptionLabel, cueTriggers, type RpgCue } from '@perspectra/host/editor/rpg-cues'
import type { playRpgCue } from '../../../host/src/editor/rpg-cue-play.ts'
import RpgCueFlow from './RpgCueFlow.vue'
const config = defineModel<RpgSource>({ required: true })
const props = defineProps<{
  book: ReturnType<typeof rpgBook>
  mapIndex: number
  result?: Awaited<ReturnType<typeof playRpgCue>> | undefined
}>()
const emit = defineEmits<{ trial: [index: number]; clear: []; characters: [] }>()
const map = computed(() => config.value.maps![props.mapIndex]!)
const selected = ref(0),
  firstField = ref<HTMLSelectElement>()
const cue = computed(() => map.value.scripted?.[selected.value])
const choices = computed(() =>
  cueCandidates(config.value, map.value, props.book.characters, props.book.player, cue.value ?? {}),
)
const flow = computed(() => cueFlow(config.value, map.value, props.book.characters, props.book.player))
const warning = computed(() => flow.value.find(r => r.index === selected.value)?.warning)
const outcome = computed(() => props.result?.history.find(r => r.index === selected.value))
const value = (e: Event) => (e.target as HTMLSelectElement).value
function select(index: number) {
  selected.value = index
  emit('clear')
}
async function focus(index: number) {
  select(index)
  await nextTick()
  firstField.value?.focus()
}
defineExpose({ focus })
function add() {
  const actor = choices.value.actors[0]
  if (!actor) return
  const rows = (map.value.scripted ??= [])
  rows.push({ when: 'enter', characterId: actor.id })
  void focus(rows.length - 1)
}
function remove() {
  const rows = map.value.scripted!
  rows.splice(selected.value, 1)
  select(Math.max(0, Math.min(selected.value, rows.length - 1)))
}
function neighbor(offset: number) {
  const c = cue.value
  const rows = flow.value.filter(
    r =>
      r.when === c?.when &&
      (r.when !== 'turn' || (r.round === c.round && map.value.scripted?.[r.index]?.characterId === c.characterId)),
  )
  return rows[rows.findIndex(r => r.index === selected.value) + offset]?.index
}
function move(offset: number) {
  const rows = map.value.scripted!,
    i = selected.value,
    j = neighbor(offset)
  if (j === undefined) return
  const current = rows[i]!
  rows[i] = rows[j]!
  rows[j] = current
  select(j)
}
function changeTrigger(when: RpgCue['when']) {
  const c = cue.value!
  c.when = when
  if (when === 'turn') c.round ??= 1
  else delete c.round
  if (when === 'enter' || when === 'enemy-defeated') {
    delete c.skill
    delete c.target
  }
}
function changeActor(id: string) {
  const c = cue.value!
  c.characterId = id
  if (c.skill && !config.value.characters[id]?.skills?.includes(c.skill)) {
    delete c.skill
    delete c.target
  }
}
function changeSkill(id: string) {
  const c = cue.value!
  if (id) c.skill = id
  else delete c.skill
  if (!choices.value.enemies.some(e => e.id === c.target)) delete c.target
}
watch(
  () => props.mapIndex,
  () => select(0),
)
</script>
<template>
  <fieldset class="cue-editor">
    <legend>遭遇演出</legend>
    <RpgCueFlow :rows="flow" :selected="selected" @select="select" />
    <div class="buttons">
      <button type="button" :disabled="!choices.actors.length" @click="add">添加演出</button>
      <template v-if="!choices.actors.length"
        ><span>需要一名已配置 RPG 数值的非玩家角色。</span
        ><button type="button" @click="emit('characters')">配置演出角色</button></template
      >
    </div>
    <template v-if="cue">
      <div class="fields">
        <label
          >触发时机 · 必填<select
            ref="firstField"
            :value="cue.when"
            @change="changeTrigger(value($event) as RpgCue['when'])"
          >
            <option v-if="!choices.triggers.includes(cue.when)" :value="cue.when" disabled>
              {{ cueTriggers[cue.when] }}（当前地图无敌人）
            </option>
            <option v-for="w in choices.triggers" :key="w" :value="w">{{ cueTriggers[w] }}</option>
          </select></label
        >
        <label v-if="cue.when === 'turn'"
          >演出回合 · 必填<input v-model.number="cue.round" type="number" min="1" step="1" required
        /></label>
        <label
          >演出角色 · 必填<select :value="cue.characterId" @change="changeActor(value($event))">
            <option v-if="!choices.actors.some(a => a.id === cue!.characterId)" :value="cue.characterId" disabled>
              {{ cue.characterId }}（不可自动出演）
            </option>
            <option v-for="c in choices.actors" :value="c.id" :key="c.id">
              {{ cueOptionLabel(c, choices.actors) }}
            </option>
          </select></label
        >
        <template v-if="cue.when === 'turn' || cue.when === 'encounter'">
          <label
            >演出技能 · 选填<select :value="cue.skill ?? ''" @change="changeSkill(value($event))">
              <option value="">不使用技能</option>
              <option v-if="cue.skill && !choices.skills.some(s => s.id === cue!.skill)" :value="cue.skill" disabled>
                {{ cue.skill }}（当前不可选）
              </option>
              <option v-for="s in choices.skills" :value="s.id" :key="s.id">
                {{ cueOptionLabel(s, choices.skills) }}
              </option>
            </select></label
          >
          <label v-if="cue.skill"
            >技能目标 · 选填<select
              :value="cue.target ?? ''"
              @change="value($event) ? (cue.target = value($event)) : delete cue.target"
            >
              <option value="">按技能自动选择</option>
              <option
                v-if="cue.target && !choices.enemies.some(e => e.id === cue!.target)"
                :value="cue.target"
                disabled
              >
                {{ cue.target }}（当前不可选）
              </option>
              <option v-for="e in choices.enemies" :value="e.id" :key="e.id">
                {{ cueOptionLabel(e, choices.enemies) }}
              </option>
            </select></label
          >
        </template>
      </div>
      <label
        >演出台词 · {{ cue.skill ? '选填' : '必填'
        }}<textarea
          :value="cue.say ?? ''"
          rows="2"
          @input="value($event) ? (cue.say = value($event)) : delete cue.say"
        />
      </label>
      <p v-if="warning" role="status">{{ warning }}</p>
      <div class="buttons">
        <button
          type="button"
          :disabled="(!cue.say?.trim() && !cue.skill) || !!warning"
          @click="emit('trial', selected)"
        >
          试玩到这条演出
        </button>
        <button v-if="neighbor(-1) !== undefined" type="button" @click="move(-1)">在同一时机上移</button>
        <button v-if="neighbor(1) !== undefined" type="button" @click="move(1)">在同一时机下移</button>
        <button type="button" @click="remove">移除这条演出</button>
      </div>
      <div v-if="result" role="status">
        <b>{{ result.played ? '已触发所选演出' : '未完整触发这条演出' }}</b>
        <p v-if="result.reason">{{ result.reason }}</p>
        <p v-if="outcome">
          {{ outcome.phase === 'fighting' ? '第 ' + outcome.round + ' 轮' : cueTriggers[cue.when] }} ·
          {{ outcome.description }} {{ outcome.speech }}
        </p>
      </div>
    </template>
  </fieldset>
</template>
<style scoped>
.cue-editor {
  min-width: 0;
}
.fields,
.buttons {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 0.65rem;
}
.fields label,
.cue-editor > label {
  display: grid;
  gap: 0.25rem;
}
.cue-editor textarea {
  width: 100%;
  box-sizing: border-box;
}
</style>
