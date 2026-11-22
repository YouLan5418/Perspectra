<script setup lang="ts">
import { computed, ref, watch, watchEffect } from 'vue'
import type { rpgBook, RpgSource } from '../../../host/src/editor/rpg.ts'
import type { playRpgJourney } from '../../../host/src/editor/rpg-journey-play.ts'
const cfg = defineModel<RpgSource>({ required: true })
const props = defineProps<{
  book: ReturnType<typeof rpgBook>
  kind: '休息与返回' | '队伍'
  result?: Awaited<ReturnType<typeof playRpgJourney>> | undefined
}>()
const emit = defineEmits<{ trial: [body: Record<string, unknown>]; clear: []; characters: [] }>()
const leaders = computed(() => props.book.characters.filter(c => Object.hasOwn(cfg.value.characters, c.id)))
const members = computed(() => leaders.value.filter(c => c.id !== cfg.value.party?.leader))
const places = computed(() =>
  props.book.locations.filter(l => l.id !== cfg.value.vault && props.book.scenes.some(s => s.location === l.id)),
)
const maps = computed(() =>
  places.value.filter(l => cfg.value.maps?.some(m => m.locationId === l.id && m.enemies?.length)),
)
const restPlace = ref(''),
  battlefield = ref(''),
  member = ref(''),
  from = ref(''),
  to = ref('')
const destinations = computed(() => places.value.filter(l => l.id !== from.value))
const placeName = (id: string) => props.book.locations.find(l => l.id === id)?.name ?? id
const actorName = (id: string) => props.book.characters.find(c => c.id === id)?.name ?? id
const fallback = (id: string, options: { id: string }[], preferred?: string) =>
  options.some(o => o.id === id) ? id : (options.find(o => o.id === preferred)?.id ?? options[0]?.id ?? '')
watchEffect(() => {
  restPlace.value = fallback(restPlace.value, places.value, cfg.value.rest?.locations[0])
  battlefield.value = fallback(battlefield.value, maps.value)
  member.value = fallback(member.value, members.value)
  from.value = fallback(from.value, places.value)
  to.value = fallback(to.value, destinations.value)
})
watch([restPlace, battlefield, member, from, to], () => emit('clear'))
function toggleRest(on: boolean) {
  if (on) cfg.value.rest = { label: '休息', locations: restPlace.value ? [restPlace.value] : [], restore: 'full' }
  else delete cfg.value.rest
}
function toggleDefeat(on: boolean) {
  if (on) cfg.value.defeat = { to: from.value || props.book.locations[0]?.id || '' }
  else delete cfg.value.defeat
}
function toggleStat(key: string, on: boolean) {
  const defeat = cfg.value.defeat!
  const restore = { ...defeat.restore }
  if (on) restore[key] = key === 'hp' ? 1 : 0
  else delete restore[key]
  defeat.restore = restore
}
function toggleParty(on: boolean) {
  if (on) cfg.value.party = { leader: fallback('', leaders.value, props.book.player) }
  else delete cfg.value.party
}
</script>
<template>
  <div class="journey">
    <template v-if="kind === '休息与返回'">
      <fieldset>
        <legend>休息点</legend>
        <label
          ><input
            type="checkbox"
            :checked="!!cfg.rest"
            @change="toggleRest(($event.target as HTMLInputElement).checked)"
          />启用休息 · 选填</label
        >
        <template v-if="cfg.rest">
          <label>操作名称 · 必填<input v-model="cfg.rest.label" required maxlength="36" /></label>
          <fieldset>
            <legend>允许休息的地点 · 至少选一处</legend>
            <label v-for="l in book.locations" :key="l.id"
              ><input v-model="cfg.rest.locations" type="checkbox" :value="l.id" />{{ l.name }}</label
            >
          </fieldset>
          <p>恢复方式 · 执行休息的角色将低于上限的属性回满。</p>
        </template>
        <div class="trial">
          <label
            >试玩地点<select v-model="restPlace">
              <option v-for="l in places" :value="l.id" :key="l.id">{{ l.name }}</option>
            </select></label
          >
          <button :disabled="!restPlace" @click="emit('trial', { kind: 'rest', location: restPlace })">试玩休息</button>
        </div>
        <div v-if="result?.kind === 'rest'" role="status">
          <b>{{ placeName(result.location) }} · {{ result.available ? '可以休息' : '没有休息操作' }}</b>
          <ul v-if="result.available">
            <li v-for="v in result.values" :key="v.key">
              {{ v.label }} {{ v.before }} → {{ v.after }}（上限 {{ v.max }}）
            </li>
          </ul>
        </div>
      </fieldset>
      <fieldset>
        <legend>战败与撤退</legend>
        <label
          ><input
            type="checkbox"
            :checked="!!cfg.defeat"
            :disabled="cfg.retreat === 'back'"
            @change="toggleDefeat(($event.target as HTMLInputElement).checked)"
          />启用战败返回 · 选填</label
        >
        <template v-if="cfg.defeat">
          <label
            >战败返回地点 · 必填<select v-model="cfg.defeat.to">
              <option v-for="l in book.locations" :key="l.id" :value="l.id">{{ l.name }}</option>
            </select></label
          >
          <fieldset>
            <legend>战败后的属性值 · 选填</legend>
            <p>在场参战者返回后，将勾选的属性设为指定值。生命最多恢复到各自的上限。</p>
            <div v-for="s in cfg.stats" :key="s.key" class="value-row">
              <label
                ><input
                  type="checkbox"
                  :checked="Object.hasOwn(cfg.defeat.restore ?? {}, s.key)"
                  @change="toggleStat(s.key, ($event.target as HTMLInputElement).checked)"
                />{{ s.label }}</label
              >
              <input
                v-if="cfg.defeat.restore && Object.hasOwn(cfg.defeat.restore, s.key)"
                v-model.number="cfg.defeat.restore[s.key]"
                :aria-label="s.label + '返回后的数值'"
                type="number"
                min="0"
                max="100000"
                step="1"
                required
              />
            </div>
          </fieldset>
        </template>
        <label
          >撤退去向 · 选填<select
            :value="cfg.retreat ?? 'stay'"
            @change="cfg.retreat = ($event.target as HTMLSelectElement).value as 'stay' | 'back'"
          >
            <option value="stay">留在战场（默认）</option>
            <option value="back" :disabled="!cfg.defeat">前往战败返回地点</option>
          </select></label
        >
        <p v-if="cfg.retreat === 'back'">撤退只移动参战者。要关闭战败返回，请先将撤退去向改为留在战场。</p>
        <div class="trial">
          <label
            >试玩遭遇<select v-model="battlefield">
              <option v-for="l in maps" :key="l.id" :value="l.id">{{ l.name }}</option>
            </select></label
          >
          <button :disabled="!battlefield" @click="emit('trial', { kind: 'defeat', location: battlefield })">
            试玩战败返回
          </button>
          <button :disabled="!battlefield" @click="emit('trial', { kind: 'retreat', location: battlefield })">
            试玩撤退
          </button>
        </div>
        <small v-if="battlefield">战败试玩让参战角色以低生命开局并防御，直到战斗结算。</small
        ><small v-else>请先为一个有场景的地点配置遭遇敌人。</small>
        <div v-if="result?.kind === 'defeat' || result?.kind === 'retreat'" role="status">
          <b>{{ result.kind === 'defeat' ? '战败' : '撤退' }}后 · {{ placeName(result.destination) }}</b>
          <ul>
            <li v-for="p in result.participants" :key="p.id">
              {{ actorName(p.id) }} · {{ placeName(p.location) }} ·
              {{ p.values.map(v => v.label + ' ' + v.after).join('，') }}
            </li>
          </ul>
        </div>
      </fieldset>
    </template>
    <fieldset v-else>
      <legend>队伍与随行</legend>
      <label
        ><input
          type="checkbox"
          :disabled="!leaders.length && !cfg.party"
          :checked="!!cfg.party"
          @change="toggleParty(($event.target as HTMLInputElement).checked)"
        />启用队伍 · 选填</label
      >
      <p v-if="!leaders.length">请先在「角色」中配置一名 RPG 角色。</p>
      <template v-if="cfg.party">
        <label
          >队长 · 必填<select v-model="cfg.party.leader">
            <option v-for="c in leaders" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select></label
        >
        <label
          ><input
            type="checkbox"
            :checked="cfg.party.lockDuringBattle ?? true"
            @change="cfg.party.lockDuringBattle = ($event.target as HTMLInputElement).checked"
          />禁止参战成员在战斗中离队 · 选填，默认开启</label
        >
        <p>同伴在自己的回合加入或离队。队长移动时，同地点的队员会随行。</p>
        <div class="trial">
          <label
            >试玩成员<select v-model="member">
              <option v-for="c in members" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select></label
          >
          <label
            >出发地点<select v-model="from">
              <option v-for="l in places" :key="l.id" :value="l.id">{{ l.name }}</option>
            </select></label
          >
          <label
            >抵达地点<select v-model="to">
              <option v-for="l in destinations" :key="l.id" :value="l.id">{{ l.name }}</option>
            </select></label
          >
        </div>
        <button :disabled="!member || !from || !to" @click="emit('trial', { kind: 'party', member, from, to })">
          试玩入队、随行与离队
        </button>
        <small v-if="!member || !to">队伍试玩需要队长之外的一名 RPG 角色，以及两个有场景的地点。</small>
        <ol v-if="result?.kind === 'party'" role="status">
          <li>{{ actorName(result.member) }}已加入{{ actorName(result.leader) }}的队伍</li>
          <li>跟随队长到达{{ placeName(result.followed) }}</li>
          <li>离队后，队长返回{{ placeName(result.from) }}，成员留在{{ placeName(result.stayed) }}</li>
        </ol>
      </template>
      <button v-if="!leaders.length || (cfg.party && !members.length)" @click="emit('characters')">
        配置 RPG 角色
      </button>
    </fieldset>
  </div>
</template>
<style scoped>
.journey,
.journey fieldset {
  display: grid;
  gap: 0.65rem;
  min-width: 0;
}
.journey {
  gap: 1rem;
}
.journey fieldset {
  border: 1px solid #b8c9c3;
  padding: 0.8rem 1rem;
}
.journey label {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  flex-wrap: wrap;
}
.trial,
.value-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
  align-items: center;
}
.value-row input[type='number'] {
  width: 7rem;
}
.journey p,
.journey ul,
.journey ol {
  margin: 0.2rem 0;
}
</style>
