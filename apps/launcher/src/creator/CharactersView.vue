<script setup lang="ts">
import { computed } from 'vue'
import { asRecord, dateTimeLabel, durationLabel, inlineJson } from './format.ts'
import { useCreatorStore } from './store.ts'

const store = useCreatorStore()
/** 每个角色最近一次处理：轮次结束状态来自最近的 turn 记录。 */
const activation = computed(() => {
  const table: Record<string, { status: string; calls: string; at: string }> = {}
  for (const record of store.records) {
    if (record.kind !== 'turn') continue
    const detail = store.details[record.id]
    const data = asRecord((detail?.data ?? {}) as Record<string, unknown>)
    table[record.characterId] = { status: String(record.summary.status ?? data.status ?? '—'), calls: data.calls === undefined ? '—' : String(data.calls), at: record.capturedAt }
  }
  return table
})
</script>

<template>
  <div class="cr-scroll">
    <div class="cr-list-head" style="grid-template-columns: minmax(120px, 1fr) minmax(0, 1.2fr) 120px 130px 150px">
      <span>角色</span><span>位置与场景</span><span>传输状态</span><span>最近反应周期</span><span>最近移动</span>
    </div>
    <div v-for="character in store.characters" :key="character.id" class="cr-list-row"
      style="grid-template-columns: minmax(120px, 1fr) minmax(0, 1.2fr) 120px 130px 150px"
      :class="{ selected: store.selection?.id === character.id }" @click="store.selectCharacter(character.id)">
      <span class="cr-strong">{{ character.name }}</span>
      <span class="cr-muted">{{ character.locationName ?? '位置未知' }} · {{ character.sceneIds.join('、') || '无场景' }}</span>
      <span><span class="cr-tag" :class="character.processing.transport === 'ok' ? 'ok' : character.processing.transport === 'failed' ? 'danger' : 'muted'">
        {{ character.processing.transport === 'ok' ? '已返回' : character.processing.transport === 'failed' ? '失败' : character.processing.transport || '未捕获' }}</span></span>
      <span class="cr-muted">
        <template v-if="activation[character.id]">
          {{ activation[character.id]!.status }} · {{ activation[character.id]!.calls }} 次调用
          <span class="cr-tl-sub">{{ dateTimeLabel(activation[character.id]!.at) }}</span>
        </template>
        <template v-else>—</template>
      </span>
      <span class="cr-muted">#{{ character.lastMovementSeq ?? '—' }} · {{ character.lifecycle }}</span>
    </div>
    <p v-if="!store.characters.length" class="cr-muted" style="padding: 12px">尚未读取角色。</p>

    <section class="cr-section">
      <h2>角色处理入口</h2>
      <p class="cr-muted">lastActivation 与最新传输状态可能来自不同处理时刻；点击角色可查看当前授权观察、最近一次实际请求与已安装记忆分层。</p>
      <div v-for="character in store.characters" :key="character.id" class="cr-block">
        <header>
          <strong>{{ character.name }}</strong>
          <span>{{ character.locationName ?? '位置未知' }}</span>
          <span class="cr-spacer" style="margin-left: auto" />
          <button class="cr-button tiny" @click="store.selectCharacter(character.id)">查看档案</button>
          <button class="cr-button tiny" @click="store.focusCharacter(character.id); store.view = 'conversation'">只看此角色</button>
        </header>
        <div class="cr-kv">
          <dt>最近激活</dt><dd>{{ inlineJson(character.processing.lastActivation, 120) }}</dd>
          <dt>最近移动</dt><dd>{{ character.lastMovementSeq === null ? '无记录' : `序号 #${character.lastMovementSeq}` }}</dd>
          <dt>生命周期</dt><dd>{{ character.lifecycle }}</dd>
          <dt>轮次耗时</dt><dd>{{ durationLabel(store.records.find(record => record.kind === 'turn' && record.characterId === character.id)?.summary.durationMs) || '未记录' }}</dd>
        </div>
      </div>
    </section>
  </div>
</template>
