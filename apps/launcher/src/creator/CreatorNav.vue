<script setup lang="ts">
import { computed } from 'vue'
import {
  Activity,
  Boxes,
  Braces,
  Circle,
  Globe,
  ListTree,
  MessagesSquare,
  Send,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
} from '@lucide/vue'
import { useCreatorStore } from './store.ts'

const store = useCreatorStore()
defineProps<{ gameTitle: string; storyline: string; candidate: string; preview: boolean }>()

const groups = [
  {
    label: '对话与轨迹',
    items: [
      { id: 'conversation', label: '对话', icon: MessagesSquare },
      { id: 'trace', label: '轨迹', icon: ListTree },
      { id: 'requests', label: '模型请求', icon: Send },
    ],
  },
  {
    label: '世界',
    items: [
      { id: 'world', label: '世界总览', icon: Globe },
      { id: 'characters', label: '角色', icon: Users },
      { id: 'entities', label: '物品', icon: Boxes },
      { id: 'statuses', label: '状态', icon: Braces },
      { id: 'activities', label: '活动', icon: Activity },
    ],
  },
] as const

const activeCount = computed(() => store.characters.filter(character => character.processing.transport === 'ok').length)
</script>

<template>
  <nav class="cr-nav" :class="{ collapsed: store.navCollapsed }" aria-label="创作者导航">
    <div class="cr-brand">
      <span class="cr-brand-text">
        <strong>Perspectra 创作者</strong><br />
        <small>{{ preview ? '浏览器预览样例' : '只读调试接口' }}</small>
      </span>
      <button
        class="cr-icon-button"
        :aria-label="store.navCollapsed ? '展开导航' : '折叠导航'"
        @click="store.navCollapsed = !store.navCollapsed"
      >
        <PanelLeftOpen v-if="store.navCollapsed" :size="15" />
        <PanelLeftClose v-else :size="15" />
      </button>
    </div>

    <div class="cr-nav-scroll">
      <div class="cr-nav-group">当前</div>
      <div class="cr-nav-item" :title="gameTitle">
        <Globe :size="14" /><span class="cr-nav-label">{{ gameTitle }}</span>
      </div>
      <div class="cr-nav-item" :title="storyline">
        <ListTree :size="14" /><span class="cr-nav-label">{{ storyline }}</span>
        <span class="cr-nav-badge">{{ candidate }}</span>
      </div>

      <template v-for="group in groups" :key="group.label">
        <div class="cr-nav-group">{{ group.label }}</div>
        <button
          v-for="item in group.items"
          :key="item.id"
          class="cr-nav-item"
          :class="{ active: store.view === item.id }"
          :title="item.label"
          @click="store.view = item.id"
        >
          <component :is="item.icon" :size="14" />
          <span class="cr-nav-label">{{ item.label }}</span>
        </button>
      </template>

      <div class="cr-nav-group">
        角色
        <span v-if="!store.navCollapsed"> · {{ activeCount }}/{{ store.characters.length }} 有传输</span>
      </div>
      <button
        v-for="character in store.characters"
        :key="character.id"
        class="cr-nav-item"
        :class="{ active: store.server.characterId === character.id }"
        :title="`${character.name} · ${character.locationName ?? '位置未知'}`"
        @click="store.focusCharacter(character.id)"
      >
        <Circle
          :size="9"
          :fill="character.processing.transport === 'ok' ? 'currentColor' : 'none'"
          :style="{
            color:
              character.processing.transport === 'failed'
                ? 'var(--cr-fail)'
                : character.processing.transport === 'ok'
                  ? 'var(--cr-context)'
                  : 'var(--cr-faint)',
          }"
        />
        <span class="cr-nav-label">{{ character.name }}</span>
        <span class="cr-nav-badge">{{ character.locationName ?? '—' }}</span>
      </button>
      <p v-if="!store.characters.length" class="cr-nav-note">尚未读取角色。</p>
      <p v-else-if="store.server.characterId" class="cr-nav-note">
        <button class="cr-button tiny" @click="store.focusCharacter(store.server.characterId)">清除角色筛选</button>
      </p>
    </div>
  </nav>
</template>
