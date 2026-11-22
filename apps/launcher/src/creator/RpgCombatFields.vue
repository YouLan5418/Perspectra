<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ConfigFieldEditor from './ConfigFieldEditor.vue'
import { configObject, type ConfigField } from '@perspectra/world-pack/editor-config'
import RpgSlots from './RpgSlots.vue'
import { newRpgCharacter } from './rpg-character.ts'
import type { RpgSource, rpgBook } from '../../../host/src/editor/rpg.ts'
const config = defineModel<RpgSource>({ required: true })
const props = defineProps<{
  kind: '技能' | '敌人' | '角色'
  characters: ReturnType<typeof rpgBook>['characters']
  book: ReturnType<typeof rpgBook>
  slots: string[]
}>()
const selected = ref(''),
  newId = ref(''),
  error = ref('')
const names = computed(() =>
  props.kind === '技能'
    ? (config.value.skills ?? []).map(s => ({ id: s.id, name: s.name }))
    : props.kind === '敌人'
      ? Object.entries(config.value.enemies ?? {}).map(([id, s]) => ({ id, name: s.name }))
      : props.characters.filter(c => Object.hasOwn(config.value.characters, c.id)),
)
watch(
  () => props.kind,
  () => {
    selected.value = names.value[0]?.id ?? ''
    newId.value = ''
    error.value = ''
  },
  { immediate: true },
)
const skill = computed(() => config.value.skills?.find(s => s.id === selected.value))
const effectsField = computed(() => (props.book.schema as ConfigField)?.properties?.skills?.items?.properties?.effects)
const effectsPath = computed(() => [
  'skills',
  String(config.value.skills?.findIndex(s => s.id === selected.value)),
  'effects',
])
const enemy = computed(() => config.value.enemies?.[selected.value])
const actor = computed(() => config.value.characters[selected.value])
const fighter = computed(() => (props.kind === '敌人' ? enemy.value : actor.value))
const stats = { attack: '攻击', defense: '防御', speed: '速度' } as const
const availableSkills = computed(() =>
  (config.value.skills ?? []).filter(s => props.kind !== '敌人' || !Object.keys(s.cost ?? {}).length),
)
const shownSkills = computed(() =>
  (config.value.skills ?? []).filter(s => availableSkills.value.includes(s) || fighter.value?.skills?.includes(s.id)),
)
function add() {
  error.value = ''
  const id = newId.value.trim()
  if (!id || names.value.some(n => n.id === id) || ['__proto__', 'constructor', 'prototype'].includes(id)) {
    error.value = '请选择或输入未使用的标识'
    return
  }
  if (props.kind === '技能')
    (config.value.skills ??= []).push({
      id,
      name: '新技能',
      scope: 'one',
      target: 'opponent',
      effects: [{ kind: 'damage', amount: 6 }],
      cost: {},
    })
  else if (props.kind === '敌人')
    (config.value.enemies ??= {})[id] = {
      name: '新敌人',
      hp: 15,
      attack: 1,
      defense: 0,
      speed: 10,
      skills: availableSkills.value.slice(0, 1).map(s => s.id),
      strategy: 'lowest-hp',
      lines: {},
    }
  else config.value.characters[id] = newRpgCharacter(config.value)
  selected.value = id
  newId.value = ''
}
function setCost(key: string, event: Event) {
  if (!skill.value) return
  const raw = (event.target as HTMLInputElement).value
  if (!raw || Number(raw) === 0) {
    if (skill.value.cost) delete skill.value.cost[key]
  } else (skill.value.cost ??= {})[key] = Number(raw)
}
</script>
<template>
  <div class="combat-fields">
    <label
      >{{ kind }}记录<select v-model="selected">
        <option v-for="n in names" :value="n.id" :key="n.id">{{ n.name }} · {{ n.id }}</option>
      </select></label
    >
    <div class="new">
      <label
        >新增{{ kind
        }}<select v-if="kind === '角色'" v-model="newId">
          <option value="">选择世界角色</option>
          <option
            v-for="c in characters.filter(c => !Object.hasOwn(config.characters, c.id))"
            :key="c.id"
            :value="c.id"
          >
            {{ c.name }}
          </option></select
        ><input v-else v-model="newId" placeholder="新记录标识" /></label
      ><button :disabled="!newId" @click="add">添加{{ kind }}</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="kind === '技能' && skill">
      <label>技能名称 · 必填<input v-model="skill.name" required /></label>
      <label
        >作用目标 · 必填<select v-model="skill.target">
          <option value="opponent">敌方</option>
          <option value="ally">我方</option>
          <option value="self">自己</option>
        </select></label
      >
      <label
        >作用范围 · 选填<select
          :value="skill.scope ?? 'one'"
          @change="skill.scope = ($event.target as HTMLSelectElement).value as 'one' | 'all'"
        >
          <option value="one">单体</option>
          <option value="all">全体</option>
        </select></label
      >
      <fieldset>
        <legend>属性消耗 · 选填</legend>
        <label v-for="s in config.stats.filter(s => s.key !== 'hp')" :key="s.key"
          >{{ s.label }}消耗<input
            type="number"
            min="0"
            :value="skill.cost?.[s.key] ?? 0"
            @input="setCost(s.key, $event)"
        /></label>
      </fieldset>
      <fieldset>
        <legend>技能效果 · 至少一项</legend>
        <ConfigFieldEditor
          v-if="effectsField"
          :key="skill.id"
          mode="rpg"
          :records="book"
          :schema="effectsField"
          :path="effectsPath"
          :config="configObject(config)"
          :value="configObject(skill).effects"
          label="技能效果"
          @change="
            v => {
              if (skill) skill.effects = v as unknown as typeof skill.effects
            }
          "
        />
      </fieldset>
    </template>
    <template v-if="kind !== '技能' && fighter">
      <template v-if="kind === '敌人' && enemy"
        ><label>敌人名称 · 必填<input required v-model="enemy.name" /></label
        ><label>生命 · 必填<input type="number" min="0" v-model.number="enemy.hp" /></label
      ></template>
      <template v-if="kind === '角色' && actor"
        ><RpgSlots
          v-model="actor.slots"
          :candidates="[
            ...new Set([...slots, ...Object.values(config.characters).flatMap(c => c.slots ?? [])]),
          ]" /><label v-for="s in config.stats" :key="s.key"
          >{{ s.label }} · 必填<input type="number" min="0" v-model.number="actor.stats[s.key]" /></label
      ></template>
      <label v-for="(label, key) in stats" :key="key"
        >{{ label }} · 必填<input type="number" min="0" v-model.number="fighter[key]"
      /></label>
      <fieldset>
        <legend>掌握技能 · {{ kind === '敌人' ? '必填字段，可留空列表' : '选填' }}</legend>
        <label v-for="s in shownSkills" :key="s.id" class="check"
          ><input
            type="checkbox"
            :checked="fighter.skills?.includes(s.id)"
            @change="
              fighter.skills = ($event.target as HTMLInputElement).checked
                ? [...(fighter.skills ?? []), s.id]
                : (fighter.skills ?? []).filter(id => id !== s.id)
            "
          />{{ s.name }}</label
        >
      </fieldset>
    </template>
  </div>
</template>
<style scoped>
.combat-fields {
  display: grid;
  gap: 0.8rem;
  max-width: 44rem;
}
.new {
  display: flex;
  align-items: end;
  gap: 0.6rem;
}
label {
  display: grid;
  gap: 0.25rem;
}
.check {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
fieldset {
  min-width: 0;
  border: 1px solid #b8c9c3;
  display: grid;
  gap: 0.45rem;
}
</style>
