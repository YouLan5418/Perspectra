<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { X } from '@lucide/vue'
import { useLensStore } from './store.ts'
import { REQUEST_STATE_LABEL, SECTION_LABEL, showSource, showValue } from './format.ts'
import ChangeBadge from './ChangeBadge.vue'

/** 右侧详情：一个条目的全部字段、相对基准的“之前 → 之后”、源码位置，以及“想改这里”。 */
const store = useLensStore()
const item = computed(() => store.selected!)
const change = computed(() => store.changesById.get(item.value.id))
const parent = computed(() => (item.value.parentId ? store.itemById.get(item.value.parentId) : undefined))
const children = computed(() => store.childrenOf(item.value.id))
const links = computed(() => (item.value.links ?? []).flatMap(id => store.itemById.get(id) ?? []))
const requests = computed(() => (store.snapshot?.requests ?? []).filter(r => r.itemId === item.value.id))

const note = ref('')
watch(
  () => item.value.id,
  () => {
    note.value = ''
  },
)
async function submit() {
  const text = note.value.trim()
  if (text && (await store.addRequest(item.value.id, text))) note.value = ''
}
</script>

<template>
  <aside class="cr-detail lens-detail" aria-label="条目详情">
    <div class="cr-detail-head">
      <strong>{{ item.title }}</strong>
      <ChangeBadge :change="change" :child="store.hasChildChange(item.id)" />
      <span class="cr-spacer"></span>
      <button class="cr-icon-button" aria-label="关闭详情" @click="store.selectedId = ''"><X :size="15" /></button>
    </div>
    <div class="cr-detail-body">
      <p class="cr-muted">
        {{ SECTION_LABEL[item.section] }}
        <template v-if="parent">
          · 属于 <button class="lens-link" @click="store.jump(parent.id)">{{ parent.title }}</button>
        </template>
      </p>
      <dl class="cr-kv">
        <template v-for="field in item.fields" :key="field.key">
          <dt>{{ field.label }}</dt>
          <dd>{{ showValue(field.value) }}</dd>
        </template>
        <dt>位置</dt>
        <dd class="cr-mono">{{ showSource(item.source) }}</dd>
      </dl>

      <section v-if="change?.kind === 'changed'" class="lens-group">
        <h3>相对基准的改动</h3>
        <dl class="cr-kv">
          <template v-for="field in change.fields" :key="field.key">
            <dt>{{ field.label }}</dt>
            <dd>
              <span class="lens-before">{{ showValue(field.before) }}</span> →
              <span class="lens-after">{{ showValue(field.after) }}</span>
            </dd>
          </template>
        </dl>
      </section>
      <p v-else-if="change?.kind === 'added'" class="cr-muted">这是对比基准之后新增的条目。</p>

      <section v-if="links.length" class="lens-group">
        <h3>相关</h3>
        <button v-for="link in links" :key="link.id" class="cr-button tiny lens-chip" @click="store.jump(link.id)">
          {{ link.title }}
        </button>
      </section>
      <section v-if="children.length" class="lens-group">
        <h3>下属条目</h3>
        <button v-for="child in children" :key="child.id" class="lens-row" @click="store.jump(child.id)">
          <span>{{ child.title }}</span>
          <ChangeBadge :change="store.changesById.get(child.id)" />
        </button>
      </section>

      <section class="lens-group">
        <h3>想改这里</h3>
        <textarea
          v-model="note"
          class="cr-input lens-note"
          rows="3"
          maxlength="2000"
          placeholder="写一句给 AI 的话，例如“改成傍晚也能触发”"
          aria-label="想改这里"
        ></textarea>
        <button class="cr-button primary" :disabled="store.busy || !note.trim()" @click="submit()">加入待改清单</button>
        <ul v-if="requests.length" class="lens-requests">
          <li v-for="request in requests" :key="request.id">
            <span class="cr-tag line">{{ REQUEST_STATE_LABEL[request.state] }}</span> {{ request.note }}
          </li>
        </ul>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.lens-group {
  margin-top: 14px;
}
.lens-group h3 {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--cr-dim);
}
.lens-before {
  color: var(--cr-faint);
  text-decoration: line-through;
}
.lens-after {
  color: var(--cr-action);
}
.lens-chip {
  margin: 0 4px 4px 0;
}
.lens-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--cr-text);
  text-align: left;
  font-size: 12.5px;
}
.lens-row:hover {
  background: var(--cr-panel-3);
}
.lens-link {
  border: 0;
  padding: 0;
  background: none;
  color: var(--cr-blue);
  cursor: pointer;
}
.lens-note {
  display: block;
  width: 100%;
  height: auto;
  padding: 6px 8px;
  margin-bottom: 6px;
  resize: vertical;
  font-family: inherit;
}
.lens-requests {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  display: grid;
  gap: 4px;
}
</style>
