<script setup lang="ts">
import { computed } from 'vue'
import { activityStatus, asRecord, inlineJson, text } from './format.ts'
import { useCreatorStore } from './store.ts'

const store = useCreatorStore()
const activities = computed(() =>
  store.activities.map(value => {
    const item = asRecord(value)
    // 参与者与 game 变量都在最近提交的 state 里；未开始时 state 为 null。
    const state = asRecord(item.state)
    const game = asRecord(state.game)
    const [status, tone] = activityStatus(item.state)
    return {
      key: String(item.activityKey ?? 'default'),
      status,
      tone,
      description: [
        text(game.round) ? `第 ${text(game.round)} 轮` : '',
        text(game.turn) ? `轮到 ${store.label(text(game.turn))}` : '',
        text(state.revision) ? `修订 ${text(state.revision)}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      participants: Array.isArray(state.participants) ? state.participants.map(id => store.label(String(id))) : [],
      public: asRecord(game.public),
      private: asRecord(game.private),
      internal: asRecord(game.internal),
    }
  }),
)
</script>

<template>
  <div class="cr-scroll">
    <div class="cr-list-head" style="grid-template-columns: 140px 100px minmax(0, 1.4fr) minmax(0, 1.4fr)">
      <span>活动</span><span>状态</span><span>参与者</span><span>说明</span>
    </div>
    <div
      v-for="activity in activities"
      :key="activity.key"
      class="cr-list-row"
      style="grid-template-columns: 140px 100px minmax(0, 1.4fr) minmax(0, 1.4fr)"
      :class="{ selected: store.selection?.id === activity.key }"
      @click="store.select({ kind: 'activity', id: activity.key, label: `活动 · ${activity.key}` })"
    >
      <span class="cr-strong">{{ activity.key }}</span>
      <span
        ><span class="cr-tag" :class="activity.tone">{{ activity.status }}</span></span
      >
      <span class="cr-muted">{{ activity.participants.join('、') || '无参与者' }}</span>
      <span class="cr-muted">{{ activity.description || '—' }}</span>
    </div>
    <p v-if="!activities.length" class="cr-muted" style="padding: 12px">当前没有已安装或最近提交的活动。</p>

    <section v-for="activity in activities" :key="activity.key" class="cr-section">
      <h2>{{ activity.key }}</h2>
      <div class="cr-grid">
        <div class="cr-field-card">
          <small>公开变量（参与者共享）</small><span class="cr-mono">{{ inlineJson(activity.public, 160) }}</span>
        </div>
        <div v-for="[characterId, value] in Object.entries(activity.private)" :key="characterId" class="cr-field-card">
          <small>私有变量 · {{ store.label(characterId) }}</small
          ><span class="cr-mono">{{ inlineJson(value, 160) }}</span>
        </div>
        <div class="cr-field-card">
          <small>内部变量（不进入角色视图）</small><span class="cr-mono">{{ inlineJson(activity.internal, 160) }}</span>
        </div>
      </div>
      <p class="cr-muted">活动信息仅限创作者宿主；private 只给对应角色，internal 不进入任何角色视图。</p>
    </section>
  </div>
</template>
