<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLensStore } from './store.ts'
import { REQUEST_STATE_LABEL, requestsForAi, showSource } from './format.ts'

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
const pendingCount = computed(() => requests.value.filter(r => r.state === 'open' || r.state === 'changed').length)

/** 备用：把待改和已改动待确认的条目复制成可读文本，贴给不能运行命令行的 AI。 */
const copyNotice = ref<{ ok: boolean; text: string } | null>(null)
async function copyForAi() {
  try {
    await navigator.clipboard.writeText(requestsForAi(requests.value))
    copyNotice.value = { ok: true, text: `已复制 ${pendingCount.value} 条到剪贴板。` }
  } catch (cause) {
    copyNotice.value = {
      ok: false,
      text: '复制失败：' + (cause instanceof Error ? cause.message : String(cause)),
    }
  }
}
</script>

<template>
  <section class="cr-center">
    <div class="cr-scroll">
      <p class="cr-banner">在任意条目的详情里写“想改这里”即可加入清单；AI 通过命令行读取清单，不能关闭或修改条目。</p>
      <div class="lens-copy">
        <button class="cr-button tiny" :disabled="!pendingCount" @click="copyForAi">复制给 AI</button>
        <span class="cr-muted">备用：AI 不能运行命令行时，把待改和已改动的条目复制成文本贴给它。</span>
        <span v-if="copyNotice" role="status" :class="copyNotice.ok ? 'lens-copied' : 'lens-copy-failed'">
          {{ copyNotice.text }}
        </span>
      </div>
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
.lens-copy {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 0 10px;
  font-size: 12.5px;
}
.lens-copied {
  color: var(--cr-context);
}
.lens-copy-failed {
  color: var(--cr-fail);
}
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
