<script setup lang="ts">
import { computed } from 'vue'
import type { LensItem } from '../../../../desktop/lens/view.ts'
import { useLensStore } from './store.ts'
import { fieldValue, showValue } from './format.ts'
import ChangeBadge from './ChangeBadge.vue'

/** 按角色看：她什么时候会自己动、能做什么、能去哪、和哪些事件有关。 */
const store = useLensStore()
const characters = computed(() => store.inSection('characters'))
const removed = computed(() => store.removedIn('characters'))
/** 最近一步推演里获得机会的角色。 */
const activated = computed(() => new Set(store.snapshot?.simulation.trace.at(-1)?.activated ?? []))
/** 静态白名单之外的第二层：推演当前时刻，运行时（状态脚本 policy、活动、白名单）真的会给她的交互。
 * 选项与白名单用同一套命名规则，所以按名字对应。 */
const availableNow = (item: LensItem, name: string) =>
  (store.snapshot?.simulation.npcOptions[item.id] ?? []).some(option => option.label === name)
const hasOptions = (item: LensItem) => item.id in (store.snapshot?.simulation.npcOptions ?? {})

const wake = (item: LensItem) => {
  const every = fieldValue(item.fields, 'everyPlayerTurns')
  const chances = fieldValue(item.fields, 'opportunities')
  return every === undefined ? '' : `每 ${showValue(every)} 个玩家回合给她 ${showValue(chances ?? 1)} 次主动机会`
}
const list = (item: LensItem, key: string) => {
  const value = fieldValue(item.fields, key)
  return Array.isArray(value) ? value : []
}
const changedKeys = (item: LensItem) => {
  const change = store.changesById.get(item.id)
  return new Set(change?.kind === 'changed' ? change.fields.map(field => field.key) : [])
}
const events = (item: LensItem) => (item.links ?? []).flatMap(id => store.itemById.get(id) ?? [])
</script>

<template>
  <section class="cr-center">
    <div class="cr-scroll">
      <div class="cr-grid lens-cards">
        <article
          v-for="item in characters"
          :key="item.id"
          class="cr-field-card lens-card"
          :class="{ selected: store.selectedId === item.id }"
          @click="store.select(item.id)"
        >
          <header class="lens-card-head">
            <strong>{{ item.title }}</strong>
            <ChangeBadge :change="store.changesById.get(item.id)" :child="store.hasChildChange(item.id)" />
            <span v-if="activated.has(item.id)" class="cr-tag accent">上一步获得机会</span>
          </header>
          <p class="cr-muted lens-persona">{{ showValue(fieldValue(item.fields, 'persona') ?? '') }}</p>
          <dl class="cr-kv">
            <template v-if="fieldValue(item.fields, 'scene') !== undefined">
              <dt>初始场景</dt>
              <dd>{{ showValue(fieldValue(item.fields, 'scene')!) }}</dd>
            </template>
            <template v-if="wake(item)">
              <dt
                :class="{
                  changed: changedKeys(item).has('everyPlayerTurns') || changedKeys(item).has('opportunities'),
                }"
              >
                唤醒
              </dt>
              <dd>{{ wake(item) }}</dd>
            </template>
            <template v-if="list(item, 'triggers').length">
              <dt :class="{ changed: changedKeys(item).has('triggers') }">也会叫醒她</dt>
              <dd>{{ list(item, 'triggers').join('、') }}</dd>
            </template>
            <template v-if="fieldValue(item.fields, 'interactions') !== undefined">
              <dt :class="{ changed: changedKeys(item).has('interactions') }">可用交互</dt>
              <dd v-if="!hasOptions(item) || !list(item, 'interactions').length">
                {{ showValue(fieldValue(item.fields, 'interactions')!) }}
              </dd>
              <dd v-else class="lens-abilities">
                <span v-for="name in list(item, 'interactions')" :key="name" class="lens-ability">
                  {{ name }}
                  <span v-if="availableNow(item, name)" class="cr-tag ok">此刻可用</span>
                  <span v-else class="cr-tag muted">此刻不可用</span>
                </span>
              </dd>
            </template>
            <template v-if="fieldValue(item.fields, 'places') !== undefined">
              <dt :class="{ changed: changedKeys(item).has('places') }">可去地点</dt>
              <dd>{{ showValue(fieldValue(item.fields, 'places')!) }}</dd>
            </template>
            <template v-if="events(item).length">
              <dt :class="{ changed: changedKeys(item).has('events') }">相关事件</dt>
              <dd>
                <button
                  v-for="event in events(item)"
                  :key="event.id"
                  class="cr-button tiny lens-chip"
                  @click.stop="store.jump(event.id)"
                >
                  {{ event.title }}
                </button>
              </dd>
            </template>
          </dl>
        </article>
        <article v-for="change in removed" :key="change.id" class="cr-field-card lens-card removed">
          <header class="lens-card-head">
            <strong>{{ change.title }}</strong>
            <ChangeBadge :change="change" />
          </header>
        </article>
      </div>
      <p v-if="!characters.length && !removed.length" class="cr-empty">这个包没有角色。</p>
    </div>
  </section>
</template>

<style scoped>
.lens-cards {
  padding: 12px;
  grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
}
.lens-card {
  cursor: pointer;
  display: grid;
  gap: 6px;
  align-content: start;
}
.lens-card.selected {
  border-color: var(--cr-blue);
  background: var(--cr-blue-soft);
}
.lens-card.removed {
  cursor: default;
  opacity: 0.6;
}
.lens-card.removed strong {
  text-decoration: line-through;
}
.lens-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.lens-persona {
  margin: 0;
  font-size: 12px;
}
.cr-kv dt.changed {
  color: var(--cr-action);
}
.lens-abilities {
  display: grid;
  gap: 2px;
}
.lens-ability {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.lens-chip {
  margin: 0 4px 4px 0;
}
</style>
