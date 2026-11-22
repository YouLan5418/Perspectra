<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PackTimeThreshold, Witness } from '@perspectra/sdk'
import type { RuleRow } from '../../../host/src/editor/rule-source.ts'
import type { eventOptions } from '../../../host/src/editor/event-options.ts'
const props = defineProps<{ row: RuleRow; options: Awaited<ReturnType<typeof eventOptions>> }>()
const emit = defineEmits<{ change: [row: RuleRow] }>()
const clock = computed(() => props.row.when?.crossesPackTime),
  notices = computed(() => props.row.sceneNotices ?? [])
const audience = computed(() => props.row.audience ?? 'scene')
const recipients = computed<Witness[]>(() => {
  const a = audience.value
  return typeof a === 'object' && 'anyOf' in a ? a.anyOf : [a]
})
const period = computed(() => props.options.periods.find(v => v.key === clock.value?.slotKey))
const choices = computed(() => [
  ...new Set([
    ...(period.value?.options ?? []),
    ...props.options.clocks.filter(c => c.slotKey === clock.value?.slotKey).flatMap(c => c.slots),
  ]),
])
const extra = ref('')
function patch(fields: Partial<RuleRow>) {
  emit('change', { ...props.row, ...fields })
}
function setClock(c: PackTimeThreshold) {
  patch({ when: { crossesPackTime: c } })
}
function trigger(kind: string) {
  const next = { ...props.row }
  if (kind === 'calendar') {
    delete next.round
    delete next.trigger
    delete next.duringActivity
    const source = props.options.clocks[0],
      v = props.options.periods[0]
    const slots = v?.options ?? []
    next.when = {
      crossesPackTime: source
        ? { ...source, slots: [...source.slots], at: { ...source.at } }
        : {
            dayKey: props.options.days[0]?.key ?? '',
            slotKey: v?.key ?? '',
            slots: [...slots],
            at: { day: 1, slot: slots[0] ?? '' },
          },
    }
  } else {
    delete next.when
    next.trigger = kind === 'paced' ? 'paced' : 'hard'
    next.round ??= 1
    if (kind !== 'paced') delete next.duringActivity
    if (!notices.value.length) delete next.sceneNotices
  }
  emit('change', next)
}
function selectPeriod(key: string) {
  extra.value = ''
  const slots =
    props.options.periods.find(v => v.key === key)?.options ??
    props.options.clocks.find(c => c.slotKey === key)?.slots ??
    []
  setClock({ ...clock.value!, slotKey: key, slots: [...slots], at: { day: clock.value!.at.day, slot: slots[0] ?? '' } })
}
function slots(next: string[]) {
  const c = clock.value!
  setClock({ ...c, slots: next, at: { ...c.at, slot: next.includes(c.at.slot) ? c.at.slot : (next[0] ?? '') } })
}
function move(i: number, delta: number) {
  const list = [...clock.value!.slots]
  list.splice(i + delta, 0, list.splice(i, 1)[0]!)
  slots(list)
}
function addPeriod() {
  const v = extra.value.trim()
  if (!v || clock.value!.slots.includes(v) || (period.value?.options && !period.value.options.includes(v))) return
  slots([...clock.value!.slots, v])
  extra.value = ''
}
function witnesses(list: Witness[]) {
  patch({ audience: list.length === 1 ? list[0]! : { anyOf: list } })
}
function witnessKey(w: Witness) {
  return typeof w === 'string' ? w : w.holds
}
function member(i: number, value: string) {
  const list = [...recipients.value]
  list[i] = value === 'scene' || value === 'global' ? value : { holds: value }
  witnesses(list)
}
const witnessChoices = computed(() => [
  { id: 'scene', name: '事件现场' },
  { id: 'global', name: '全世界' },
  ...props.options.items.map(v => ({ id: v.id, name: '持有「' + v.name + '」的角色' })),
])
const additional = ref('')
const unusedWitnesses = computed(() =>
  witnessChoices.value.filter(o => !recipients.value.some(w => witnessKey(w) === o.id)),
)
function addWitness() {
  if (!unusedWitnesses.value.some(o => o.id === additional.value)) return
  member(recipients.value.length, additional.value)
  additional.value = ''
}
function setNotices(list: NonNullable<RuleRow['sceneNotices']>) {
  if (list.length) patch({ sceneNotices: list })
  else {
    const r = { ...props.row }
    delete r.sceneNotices
    emit('change', r)
  }
}
function setNotice(i: number, fields: Partial<NonNullable<RuleRow['sceneNotices']>[number]>) {
  const list = [...notices.value],
    n = { ...list[i]!, ...fields }
  if (!n.text) delete n.text
  if (!n.fromOperation) delete n.fromOperation
  list[i] = n
  setNotices(list)
}
function places(i: number) {
  return props.options.locations.filter(
    l => l.id !== props.row.location && !notices.value.some((n, j) => i !== j && n.locations.includes(l.id)),
  )
}
</script>
<template>
  <fieldset class="event-conditions">
    <legend>触发与观察</legend>
    <label
      >触发方式<select
        aria-label="触发方式"
        :value="clock ? 'calendar' : (row.trigger ?? 'hard')"
        @change="trigger(($event.target as HTMLSelectElement).value)"
      >
        <option value="hard" :disabled="!!notices.length">固定回合</option>
        <option value="paced" :disabled="!!notices.length">由节奏选择</option>
        <option value="calendar">包内日历达到门槛</option>
      </select></label
    >
    <template v-if="clock">
      <label
        >天数变量 · 必填<select
          aria-label="天数变量"
          :value="clock.dayKey"
          @change="setClock({ ...clock, dayKey: ($event.target as HTMLSelectElement).value })"
        >
          <option disabled value="">先创建包级数字变量</option>
          <option v-for="v in options.days" :value="v.key" :key="v.key">{{ v.label }} · {{ v.key }}</option>
        </select></label
      >
      <label
        >时段变量 · 必填<select
          aria-label="时段变量"
          :value="clock.slotKey"
          @change="selectPeriod(($event.target as HTMLSelectElement).value)"
        >
          <option disabled value="">先创建包级文字变量</option>
          <option v-for="v in options.periods" :value="v.key" :key="v.key">{{ v.label }} · {{ v.key }}</option>
        </select></label
      >
      <details>
        <summary>时段顺序 · {{ clock.slots.join(' → ') || '待添加' }}</summary>
        <div v-for="(slot, i) in clock.slots" :key="slot">
          {{ slot }} <button type="button" :disabled="i === 0" @click="move(i, -1)">上移</button
          ><button type="button" :disabled="i === clock.slots.length - 1" @click="move(i, 1)">下移</button>
          <button type="button" @click="slots(clock.slots.filter(s => s !== slot))">移除</button>
        </div>
        <label
          >添加时段<select v-if="period?.options" v-model="extra" aria-label="添加时段">
            <option value="">选择已有时段</option>
            <option v-for="s in choices.filter(v => !clock!.slots.includes(v))" :key="s">{{ s }}</option>
          </select>
          <input v-else v-model="extra" list="event-period-names" maxlength="64" aria-label="添加时段"
        /></label>
        <datalist id="event-period-names"><option v-for="s in choices" :key="s" :value="s" /></datalist>
        <button
          type="button"
          :disabled="!extra.trim() || clock.slots.includes(extra.trim()) || clock.slots.length >= 32"
          @click="addPeriod"
        >
          加入顺序
        </button>
      </details>
      <label
        >触发日 · 必填<input
          aria-label="触发日"
          type="number"
          min="0"
          :value="clock.at.day"
          @input="setClock({ ...clock, at: { ...clock.at, day: ($event.target as HTMLInputElement).valueAsNumber } })"
      /></label>
      <label
        >触发时段 · 必填<select
          aria-label="触发时段"
          :value="clock.at.slot"
          @change="setClock({ ...clock, at: { ...clock.at, slot: ($event.target as HTMLSelectElement).value } })"
        >
          <option v-for="s in clock.slots" :key="s">{{ s }}</option>
        </select></label
      >
    </template>
    <template v-else
      ><label
        >{{ row.trigger === 'paced' ? '最早回合' : '发生回合' }}（必填）<input
          type="number"
          min="1"
          :value="row.round"
          @input="patch({ round: ($event.target as HTMLInputElement).valueAsNumber })"
      /></label>
      <label v-if="row.trigger === 'paced'"
        ><input
          type="checkbox"
          :checked="row.duringActivity"
          @change="patch({ duringActivity: ($event.target as HTMLInputElement).checked })"
        />活动进行中也可发生</label
      ></template
    >
    <div v-for="(w, i) in recipients" :key="i">
      <label
        >观察范围{{ recipients.length > 1 ? '（满足任一项）' : '' }}
        <select
          :aria-label="'观察范围 ' + (i + 1)"
          :value="witnessKey(w)"
          @change="member(i, ($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="o in witnessChoices"
            :key="o.id"
            :value="o.id"
            :disabled="
              (!!notices.length && o.id !== 'scene') || recipients.some((x, j) => i !== j && witnessKey(x) === o.id)
            "
          >
            {{ o.name }}
          </option>
        </select></label
      ><button v-if="recipients.length > 1" type="button" @click="witnesses(recipients.filter((_, j) => j !== i))">
        移除此观察范围
      </button>
    </div>
    <label v-if="!notices.length && recipients.length < 4 && unusedWitnesses.length"
      >新增观察范围<select v-model="additional" aria-label="新增观察范围">
        <option value="">选择并列范围</option>
        <option v-for="o in unusedWitnesses" :key="o.id" :value="o.id">{{ o.name }}</option>
      </select></label
    >
    <button
      type="button"
      :disabled="!!notices.length || recipients.length >= 4 || !unusedWitnesses.some(o => o.id === additional)"
      @click="addWitness"
    >
      添加并列观察范围
    </button>
    <template v-if="clock && (audience === 'scene' || notices.length)">
      <div v-for="(n, i) in notices" :key="i">
        <label
          >通知地点 · 必填<select
            multiple
            :aria-label="'通知地点 ' + (i + 1)"
            :value="n.locations"
            @change="
              setNotice(i, {
                locations: Array.from(($event.target as HTMLSelectElement).selectedOptions, o => o.value),
              })
            "
          >
            <option v-for="l in places(i)" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select></label
        >
        <label
          >通知文字 · 选填<textarea
            :value="n.text"
            placeholder="沿用事件观察文字"
            @input="setNotice(i, { text: ($event.target as HTMLTextAreaElement).value })"
          />
        </label>
        <label
          >来源操作 · 选填<select
            :aria-label="'通知来源操作 ' + (i + 1)"
            :value="n.fromOperation ?? ''"
            @change="setNotice(i, { fromOperation: ($event.target as HTMLSelectElement).value })"
          >
            <option value="">所有来源</option>
            <option
              v-if="n.fromOperation && !options.operations.some(op => op.id === n.fromOperation)"
              :value="n.fromOperation"
              disabled
            >
              {{ n.fromOperation }} · 待核对
            </option>
            <option v-for="op in options.operations" :key="op.id" :value="op.id">{{ op.label }} · {{ op.id }}</option>
          </select></label
        >
        <button type="button" @click="setNotices(notices.filter((_, j) => i !== j))">移除此组通知</button>
      </div>
      <button
        type="button"
        :disabled="notices.length >= 4 || !places(-1).length"
        @click="setNotices([...notices, { locations: [places(-1)[0]!.id] }])"
      >
        添加分地点通知
      </button>
      <small v-if="notices.length">其他触发方式和观察范围可在移除分地点通知后选择。</small>
    </template>
    <small v-if="options.warning">{{ options.warning }}</small>
  </fieldset>
</template>
<style scoped>
.event-conditions {
  display: grid;
  gap: 0.6rem;
}
label {
  display: grid;
  gap: 0.25rem;
}
button {
  justify-self: start;
}
</style>
