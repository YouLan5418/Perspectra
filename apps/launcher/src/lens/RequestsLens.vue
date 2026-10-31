<script setup lang="ts">
import { computed } from 'vue'
import { useLensStore } from './store.ts'
import { REQUEST_STATE_LABEL, showSource } from './format.ts'

/** 待改清单：作者圈选给 AI 的条目。AI 只能读；改动后显示“已改动，待确认”，由作者核对后自己关闭。 */
const store = useLensStore()
const ORDER = { changed: 0, open: 1, removed: 2, closed: 3 } as const
const requests = computed(() =>
  [...(store.snapshot?.requests ?? [])].sort(
    (a, b) => ORDER[a.state] - ORDER[b.state] || b.createdAt.localeCompare(a.createdAt),
  ),
)
const TONE = { open: 'line', changed: 'warn', removed: 'danger', closed: 'muted' } as const
const when = (iso: string) => iso.slice(0, 16).replace('T', ' ')
</script>

<template>
  <section class="cr-center">
    <div class="cr-scroll">
      <p class="cr-banner">在任意条目的详情里写“想改这里”即可加入清单；AI 通过命令行读取清单，不能关闭或修改条目。</p>
      <article v-for="request in requests" :key="request.id" class="cr-section lens-request" :class="request.state">
        <header class="lens-request-head">
          <span class="cr-tag" :class="TONE[request.state]">{{ REQUEST_STATE_LABEL[request.state] }}</span>
          <button
            class="lens-item-link"
            :disabled="!store.itemById.has(request.itemId)"
            @click="store.jump(request.itemId)"
          >
            {{ request.itemTitle }}
          </button>
          <time class="cr-muted">{{ when(request.createdAt) }}</time>
          <button
            v-if="request.state !== 'closed'"
            class="cr-button tiny lens-close"
            :disabled="store.busy"
            @click="store.closeRequest(request.id)"
          >
            关闭
          </button>
        </header>
        <p class="lens-note">{{ request.note }}</p>
        <p class="cr-mono cr-muted lens-source">{{ showSource(request.source) }}</p>
      </article>
      <p v-if="!requests.length" class="cr-empty">清单是空的。</p>
    </div>
  </section>
</template>

<style scoped>
.lens-request.closed {
  opacity: 0.55;
}
.lens-request-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12.5px;
}
.lens-item-link {
  border: 0;
  padding: 0;
  background: none;
  color: var(--cr-text);
  font-weight: 600;
  cursor: pointer;
  text-align: left;
  overflow-wrap: anywhere;
}
.lens-item-link:disabled {
  cursor: default;
  color: var(--cr-dim);
}
.lens-close {
  margin-left: auto;
}
.lens-note {
  margin: 6px 0 2px;
  overflow-wrap: anywhere;
}
.lens-source {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
