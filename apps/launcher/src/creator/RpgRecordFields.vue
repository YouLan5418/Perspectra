<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { editorRequest } from './editor-api.ts'
import type { rpgBook, RpgSource } from '../../../host/src/editor/rpg.ts'
import type { playRpgItem } from '../../../host/src/editor/rpg-item-play.ts'
import RpgSlots from './RpgSlots.vue'
import { newRpgCharacter } from './rpg-character.ts'
type Book = ReturnType<typeof rpgBook>
const props = defineProps<{ kind: 'item' | 'character'; id: string; saveRecord: () => Promise<void> }>()
const emit = defineEmits<{ saved: []; character: [id: string] }>()
const book = ref<Book>(),
  cfg = ref<RpgSource>(),
  busy = ref(false),
  error = ref(''),
  conflict = ref(false),
  notice = ref('')
const result = ref<Awaited<ReturnType<typeof playRpgItem>>>(),
  initial = ref<Record<string, number | ''>>({}),
  location = ref(''),
  skill = ref('')
const dirty = computed(
  () => JSON.stringify(cfg.value) !== JSON.stringify(book.value?.enabled ? book.value.config : undefined),
)
const gear = computed(() => cfg.value?.equipment?.[props.id]),
  potion = computed(() => cfg.value?.consumables?.[props.id]),
  actor = computed(() => cfg.value?.characters[props.id])
const wearers = computed(() =>
  gear.value
    ? (book.value?.characters.filter(c => cfg.value?.characters[c.id]?.slots?.includes(gear.value!.slot)) ?? [])
    : [],
)
const player = computed(() => cfg.value?.characters[book.value?.player ?? ''])
const maps = computed(() => cfg.value?.maps?.filter(m => m.enemies?.length) ?? [])
const skills = computed(
  () =>
    cfg.value?.skills?.filter(
      s => player.value?.skills?.includes(s.id) && s.target === 'opponent' && s.effects.some(e => e.kind === 'damage'),
    ) ?? [],
)
const modifiers = { attack: '攻击加成', defense: '防御加成' } as const
const restored = computed(() => Object.keys(potion.value?.restore ?? {}))
function load(value: Book) {
  book.value = value
  cfg.value = value.enabled && value.config ? JSON.parse(JSON.stringify(value.config)) : undefined
  conflict.value = false
  if (!maps.value.some(m => m.locationId === location.value)) location.value = maps.value[0]?.locationId ?? ''
  if (!skills.value.some(s => s.id === skill.value)) skill.value = skills.value[0]?.id ?? ''
}
async function reload() {
  load(await editorRequest<Book>('gameplay'))
}
async function save() {
  if (!dirty.value || !cfg.value || !book.value) return
  try {
    load(await editorRequest<Book>('rpg-save', { file: book.value.file, base: book.value.config, config: cfg.value }))
    emit('saved')
    notice.value = 'RPG 设置已保存'
  } catch (e) {
    if ((e as { status?: number }).status === 409) conflict.value = true
    throw e
  }
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
async function flush() {
  if (busy.value) throw new Error('请等待物品或角色设置处理完成')
  await save()
}
const gearToggle = ref<HTMLInputElement>(),
  potionToggle = ref<HTMLInputElement>()
function focusField(kind: string) {
  ;(kind === 'equipment' ? gearToggle : potionToggle).value?.focus()
}
defineExpose({ flush, focusField })
function enableGear(checked: boolean) {
  if (!cfg.value || !book.value) return
  if (checked && book.value.slots[0]) (cfg.value.equipment ??= {})[props.id] = { slot: book.value.slots[0] }
  else if (cfg.value.equipment) delete cfg.value.equipment[props.id]
}
function enablePotion(checked: boolean) {
  if (!cfg.value) return
  if (checked) (cfg.value.consumables ??= {})[props.id] = { restore: {} }
  else if (cfg.value.consumables) delete cfg.value.consumables[props.id]
}
function setRestore(key: string, checked: boolean) {
  if (!potion.value) return
  if (checked) potion.value.restore[key] = 1
  else {
    delete potion.value.restore[key]
    delete initial.value[key]
  }
}
function setModifier(key: keyof typeof modifiers | 'fire', raw: string) {
  if (!gear.value) return
  if (key === 'fire') {
    if (raw === '') delete gear.value.resistances
    else gear.value.resistances = { fire: Number(raw) }
  } else if (raw === '') delete gear.value[key]
  else gear.value[key] = Number(raw)
}
async function trial(kind: 'consumable' | 'equipment') {
  result.value = undefined
  await props.saveRecord()
  await save()
  const status = Object.fromEntries(
    Object.entries(initial.value).filter(([k, v]) => v !== '' && Object.hasOwn(potion.value?.restore ?? {}, k)),
  )
  result.value = await editorRequest('rpg-item-play', {
    kind,
    id: props.id,
    ...(kind === 'equipment' ? { location: location.value, skill: skill.value } : { initial: status }),
  })
}
watch(
  [cfg, location, skill, initial],
  () => {
    result.value = undefined
  },
  { deep: true },
)
onMounted(() =>
  reload().catch(e => {
    error.value = (e as Error).message
  }),
)
</script>
<template>
  <section v-if="(cfg && book) || error" class="rpg-record">
    <h3>{{ kind === 'character' ? 'RPG 角色' : 'RPG 物品效果' }}</h3>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="conflict" @click="run(reload)">重新载入磁盘设置</button>
    <fieldset v-if="cfg && book" :disabled="busy">
      <template v-if="kind === 'character'"
        ><RpgSlots v-if="actor" v-model="actor.slots" :candidates="book.slots" /><button
          v-else
          @click="cfg.characters[id] = newRpgCharacter(cfg)"
        >
          添加为 RPG 角色
        </button></template
      >
      <template v-else>
        <label
          ><input
            ref="potionToggle"
            type="checkbox"
            :checked="!!potion"
            @change="enablePotion(($event.target as HTMLInputElement).checked)"
          />作为消耗品</label
        >
        <fieldset v-if="potion">
          <legend>使用后恢复 · 选择本包属性</legend>
          <div v-for="stat in cfg.stats" :key="stat.key" class="entry">
            <label
              ><input
                type="checkbox"
                :checked="restored.includes(stat.key)"
                @change="setRestore(stat.key, ($event.target as HTMLInputElement).checked)"
              />{{ stat.label }}</label
            >
            <label v-if="restored.includes(stat.key)"
              >{{ stat.label }}恢复量 · 必填<input
                type="number"
                min="0"
                max="100000"
                v-model.number="potion.restore[stat.key]"
            /></label>
          </div>
        </fieldset>
        <label
          ><input
            ref="gearToggle"
            type="checkbox"
            :disabled="!gear && !book.slots.length"
            :checked="!!gear"
            @change="enableGear(($event.target as HTMLInputElement).checked)"
          />作为装备</label
        >
        <button v-if="!book.slots.length && book.player" @click="emit('character', book.player)">
          去玩家记录创建装备槽
        </button>
        <fieldset v-if="gear">
          <legend>装备效果</legend>
          <label
            >装备槽位 · 必填<select v-model="gear.slot">
              <option v-for="s in book.slots" :key="s" :value="s">{{ s }}</option>
            </select></label
          >
          <p>可装备角色 · {{ wearers.map(c => c.name).join('、') || '尚无角色拥有此槽位' }}</p>
          <p v-if="gear.speed">源包速度字段 · {{ gear.speed }}（当前战斗按角色基础速度排出手顺序）</p>
          <div class="numbers">
            <label v-for="(label, key) in modifiers" :key="key"
              >{{ label }} · 选填<input
                type="number"
                min="0"
                max="100000"
                :value="gear[key]"
                @input="setModifier(key, ($event.target as HTMLInputElement).value)"
            /></label>
            <label
              >火焰抗性 % · 选填<input
                type="number"
                min="0"
                max="75"
                :value="gear.resistances?.fire"
                @input="setModifier('fire', ($event.target as HTMLInputElement).value)"
            /></label>
          </div>
        </fieldset>
      </template>
      <button v-if="dirty" @click="run(save)">保存 RPG 设置</button
      ><span v-if="notice" role="status">{{ notice }}</span>
      <fieldset v-if="kind === 'item' && (potion || gear)">
        <legend>物品试玩</legend>
        <template v-if="potion"
          ><label v-for="s in cfg.stats.filter(s => restored.includes(s.key))" :key="s.key"
            >起始{{ s.label }} · 选填<input
              type="number"
              min="0"
              :max="player?.stats[s.key]"
              placeholder="自动设置"
              v-model.number="initial[s.key]" /></label
          ><button @click="run(() => trial('consumable'))">试玩拾取与使用</button></template
        >
        <template v-if="gear"
          ><label
            >对照遭遇<select v-model="location">
              <option v-for="m in maps" :key="m.locationId" :value="m.locationId">
                {{ book.locations.find(l => l.id === m.locationId)?.name ?? m.locationId }}
              </option>
            </select></label
          >
          <label
            >对照技能<select v-model="skill">
              <option v-for="s in skills" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select></label
          >
          <button :disabled="!location || !skill" @click="run(() => trial('equipment'))">对照装备前后伤害</button
          ><small v-if="!location || !skill">需要有敌人的遭遇，以及玩家已学会的伤害技能。</small></template
        >
      </fieldset>
    </fieldset>
    <p v-if="busy" role="status">正在处理…</p>
    <div v-if="result" role="status">
      <template v-if="result.kind === 'consumable'"
        ><p v-for="v in result.values" :key="v.key">{{ v.label }} {{ v.before }} → {{ v.after }}（上限 {{ v.max }}）</p>
        <p>{{ result.spent }} · 再次使用被拒绝：{{ result.reason }}</p></template
      >
      <template v-else
        ><p>{{ result.skill }} → {{ result.without.name }}</p>
        <p>未装备 · {{ result.without.before }} → {{ result.without.after }}，伤害 {{ result.without.damage }}</p>
        <p>已装备 · {{ result.withGear.before }} → {{ result.withGear.after }}，伤害 {{ result.withGear.damage }}</p>
        <b>伤害差 {{ result.difference > 0 ? '+' : '' }}{{ result.difference }}</b></template
      >
    </div>
  </section>
</template>
<style scoped>
.rpg-record {
  border-top: 1px solid #d5ddd5;
  margin-top: 1rem;
}
.rpg-record fieldset {
  display: grid;
  gap: 0.6rem;
}
.rpg-record fieldset fieldset {
  border-left: 2px solid #c8d6cc;
  padding: 0.4rem 0.8rem;
}
.rpg-record button {
  width: fit-content;
}
.rpg-record .entry,
.numbers {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  align-items: center;
}
.rpg-record input[type='checkbox'] {
  width: auto;
  margin-right: 0.4rem;
}
.rpg-record input[type='number'] {
  max-width: 9rem;
  display: block;
}
.rpg-record p {
  margin: 0.4rem 0;
}
</style>
