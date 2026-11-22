<script setup lang="ts">
import { computed, ref } from 'vue'
import type { rpgBook, RpgSource } from '../../../host/src/editor/rpg.ts'
const config = defineModel<RpgSource>({ required: true })
const props = defineProps<{ book: ReturnType<typeof rpgBook>; index: number }>()
const emit = defineEmits<{ item: [id: string]; trial: [to: string] }>()
const map = computed(() => config.value.maps![props.index]!)
const root = ref<HTMLElement>()
const drops = (current?: string) =>
  props.book.items.filter(
    i =>
      i.id === current || (i.location === config.value.vault && !config.value.maps?.some(m => m.drops?.includes(i.id))),
  )
const destinations = (current?: string) =>
  props.book.locations.filter(
    l =>
      l.id === current ||
      (l.id !== map.value.locationId && l.id !== config.value.vault && !map.value.exits?.some(e => e.to === l.id)),
  )
const itemName = (id: string) => props.book.items.find(i => i.id === id)?.name ?? id
const placeName = (id: string) => props.book.locations.find(l => l.id === id)?.name ?? id
const value = (e: Event) => (e.target as HTMLSelectElement).value
function setVault(id: string) {
  if (id) config.value.vault = id
  else delete config.value.vault
}
function setChest(id: string) {
  if (id) map.value.chest = id
  else delete map.value.chest
}
type Exit = NonNullable<typeof map.value.exits>[number]
function setKey(exit: Exit, id: string) {
  if (id) exit.requires = { holds: id }
  else delete exit.requires
}
function setReason(exit: Exit, s: string) {
  if (s.trim()) exit.lockedReason = s
  else delete exit.lockedReason
}
function addDrop() {
  const i = drops()[0]
  if (i) (map.value.drops ??= []).push(i.id)
}
function addExit() {
  const l = destinations()[0]
  if (l) (map.value.exits ??= []).push({ to: l.id })
}
function focusField(field: string) {
  Array.from(root.value?.querySelectorAll<HTMLElement>('[data-field]') ?? [])
    .find(e => e.dataset.field === field)
    ?.focus()
}
defineExpose({ focusField })
</script>
<template>
  <section ref="root" class="map-items">
    <fieldset>
      <legend>物品与掉落</legend>
      <label
        >掉落仓库 · 配置掉落时必填（全包共用）<select
          aria-label="掉落仓库"
          :value="config.vault ?? ''"
          @change="setVault(value($event))"
        >
          <option value="">未指定</option>
          <option v-for="l in book.locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select></label
      >
      <div v-for="(id, i) in map.drops" :key="i" class="line">
        <label
          >胜利掉落 {{ i + 1
          }}<select :data-field="'drops/' + id" :aria-label="'胜利掉落 ' + (i + 1)" v-model="map.drops![i]">
            <option v-for="o in drops(id)" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select></label
        ><button @click="emit('item', id)">查看物品</button><button @click="map.drops!.splice(i, 1)">移除掉落</button>
      </div>
      <button :disabled="!drops().length" @click="addDrop">添加胜利掉落</button>
      <small v-if="!drops().length">可添加的物品须放在掉落仓库，且尚未被其他掉落项使用。</small>
      <label
        >宝箱物品 · 选填<select data-field="chest" :value="map.chest ?? ''" @change="setChest(value($event))">
          <option value="">无</option>
          <option
            v-for="i in book.items.filter(i => i.location === map.locationId || i.id === map.chest)"
            :key="i.id"
            :value="i.id"
          >
            {{ i.name }}
          </option>
        </select></label
      >
    </fieldset>
    <fieldset>
      <legend>地图出口 · 选填</legend>
      <div v-for="(exit, i) in map.exits" :key="i" class="exit">
        <label
          >目标地点 · 必填<select v-model="exit.to" :aria-label="'出口目标 ' + (i + 1)">
            <option v-for="l in destinations(exit.to)" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select></label
        >
        <label
          >开锁物品 · 选填<select
            :data-field="'exit/' + exit.to"
            :aria-label="'开锁物品 ' + (i + 1)"
            :value="exit.requires?.holds ?? ''"
            @change="setKey(exit, value($event))"
          >
            <option value="">无需钥匙</option>
            <option v-for="o in book.items" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select></label
        >
        <template v-if="exit.requires"
          ><label
            >锁门提示 · 选填<input :value="exit.lockedReason ?? ''" @input="setReason(exit, value($event))"
          /></label>
          <p>
            {{ map.drops?.includes(exit.requires.holds) ? '本图胜利掉落' : '取得物品' }} →
            <button @click="emit('item', exit.requires.holds)">{{ itemName(exit.requires.holds) }}</button> → 拾取并开锁
            → {{ placeName(exit.to) }}
          </p>
          <button v-if="map.drops?.includes(exit.requires.holds)" @click="emit('trial', exit.to)">试玩掉落与通行</button
          ><small v-else>此出口使用其他来源的钥匙。</small></template
        >
        <button @click="map.exits!.splice(i, 1)">移除出口</button>
      </div>
      <button :disabled="!destinations().length" @click="addExit">添加出口</button>
    </fieldset>
  </section>
</template>
<style scoped>
.map-items,
.map-items fieldset,
.exit {
  display: grid;
  gap: 0.65rem;
}
.map-items fieldset {
  min-width: 0;
  border: 1px solid #b8c9c3;
  padding: 0.8rem;
}
.line {
  display: flex;
  align-items: end;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.map-items label {
  display: grid;
  gap: 0.25rem;
}
.exit + .exit {
  border-top: 1px solid #b8c9c3;
  padding-top: 0.75rem;
}
</style>
