<script setup lang="ts">
import { computed } from 'vue'
import { asRecord, dateTimeLabel, durationLabel, inlineJson, KIND_LABEL, truncate } from './format.ts'
import { useCreatorStore } from './store.ts'

const store = useCreatorStore()
const recent = computed(() => [...store.trace].reverse().filter(node => !node.processing).slice(0, 12))
const publicVariables = computed(() => Object.entries(asRecord(store.world?.variables?.public)))
</script>

<template>
  <div class="cr-scroll">
    <section class="cr-section">
      <h2>世界身份</h2>
      <div class="cr-grid">
        <div class="cr-field-card"><small>标题</small><span>{{ store.world?.title ?? '—' }}</span></div>
        <div class="cr-field-card"><small>世界版本</small><span class="cr-mono">{{ store.world?.worldVersion ?? '—' }}</span></div>
        <div class="cr-field-card"><small>地址</small><span class="cr-mono">{{ store.world ? `${store.world.address.tenantId}/${store.world.address.worldId}/${store.world.address.branchId}` : '—' }}</span></div>
        <div class="cr-field-card"><small>已提交前缀</small><span>序号 {{ store.world?.headSeq ?? 0 }} · tick {{ store.world?.tick ?? 0 }}</span></div>
        <div class="cr-field-card"><small>包身份</small><span class="cr-mono">{{ truncate(store.world?.packHash ?? '—', 26) }}</span></div>
        <div class="cr-field-card"><small>故事线起点</small><span>{{ store.world?.storyParentNodeId ?? '无父节点' }}</span></div>
        <div class="cr-field-card"><small>宿主状态</small><span>{{ store.sourceBusy ? '本轮处理中' : store.paused ? '已暂停' : '空闲' }} · 采集{{ store.captureEnabled ? '已开启' : '未开启' }}</span></div>
        <div class="cr-field-card"><small>采集时间</small><span>{{ dateTimeLabel(store.world?.capturedAt) || '—' }}</span></div>
      </div>
    </section>

    <section class="cr-section">
      <h2>角色（{{ store.characters.length }}）</h2>
      <div class="cr-list-head" style="grid-template-columns: minmax(120px, 1fr) minmax(0, 1.4fr) 110px 110px"><span>角色</span><span>位置与场景</span><span>最近移动</span><span>传输状态</span></div>
      <div v-for="character in store.characters" :key="character.id" class="cr-list-row" style="grid-template-columns: minmax(120px, 1fr) minmax(0, 1.4fr) 110px 110px"
        @click="store.selectCharacter(character.id)">
        <span class="cr-strong">{{ character.name }}</span>
        <span class="cr-muted">{{ character.locationName ?? '位置未知' }} · {{ character.sceneIds.join('、') || '无场景' }}</span>
        <span class="cr-muted">{{ character.lastMovementSeq === null ? '—' : `#${character.lastMovementSeq}` }}</span>
        <span><span class="cr-tag" :class="character.processing.transport === 'ok' ? 'ok' : character.processing.transport === 'failed' ? 'danger' : 'muted'">
          {{ character.processing.transport === 'ok' ? '已返回' : character.processing.transport === 'failed' ? '失败' : character.processing.transport || '未捕获' }}</span></span>
      </div>
      <p v-if="!store.characters.length" class="cr-muted">尚未读取角色。</p>
    </section>

    <section class="cr-section">
      <h2>受追踪物品（{{ store.entities.length }}）</h2>
      <div v-for="entity in store.entities" :key="entity.id" class="cr-list-row" style="grid-template-columns: minmax(120px, 1fr) minmax(0, 1fr) minmax(0, 1fr) 90px"
        @click="store.selectEntity(entity.id, entity.name)">
        <span class="cr-strong">{{ entity.name }}</span>
        <span class="cr-muted">保管 {{ store.label(asRecord(entity.state).holderId as string) || '无人' }}</span>
        <span class="cr-muted">有效地点 {{ store.label(entity.effectiveLocationId, 'locations') || '未知' }}（{{ entity.locationBasis === 'holder' ? '随保管者' : entity.locationBasis }}）</span>
        <span class="cr-muted">#{{ entity.lastChangeSeq }}</span>
      </div>
      <p v-if="!store.entities.length" class="cr-muted">没有事件日志重建出的受追踪物品。</p>
    </section>

    <section class="cr-section">
      <h2>公开变量</h2>
      <div class="cr-grid">
        <div v-for="[key, value] in publicVariables" :key="key" class="cr-field-card" @click="store.select({ kind: 'variable', id: `public.${key}`, label: `变量 · ${key}` })">
          <small>{{ key }}</small><span class="cr-mono">{{ inlineJson(value, 80) }}</span>
        </div>
      </div>
      <p v-if="!publicVariables.length" class="cr-muted">当前没有安装公开变量，或未安装变量模块。</p>
    </section>

    <section class="cr-section">
      <h2>最近事件</h2>
      <div v-for="node in recent" :key="node.key" class="cr-compact" :class="{ selected: store.selectedKey === node.key }" @click="store.selectNode(node)">
        <span class="cr-kind" :class="node.tone">{{ KIND_LABEL[node.kind] }}</span>
        <strong style="min-width: 56px; font-size: 12.5px">{{ store.label(node.characterId) || '世界' }}</strong>
        <span class="cr-compact-main">{{ node.summary }}</span>
        <span class="cr-tag" :class="node.tone">{{ node.statusLabel }}</span>
        <span class="cr-cell-num">{{ node.durationMs === undefined ? `#${node.seq ?? '—'}` : durationLabel(node.durationMs) }}</span>
      </div>
      <p v-if="!recent.length" class="cr-muted">暂无轨迹。</p>
    </section>

    <section class="cr-section">
      <h2>已知限制</h2>
      <ul class="cr-muted" style="padding-left: 18px; margin: 0">
        <li v-for="item in store.limitations" :key="item">{{ item }}</li>
      </ul>
    </section>
  </div>
</template>
