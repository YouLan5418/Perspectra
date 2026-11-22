<script setup lang="ts">
import { computed } from 'vue'
import type { InspectedEventRule, InspectedPacingDecision } from '../../../host/src/runtime/creator-inspection.ts'
import { pacingReasons } from './format.ts'
import { useCreatorStore } from './store.ts'

const store = useCreatorStore()
const rules = computed(() => store.world?.worldEvents ?? [])
const pacing = computed(() => store.world?.pacingDiagnostics)
const committed = computed(
  () => new Map(rules.value.flatMap(r => (r.occurrence ? [[r.occurrence.id, r.occurrence.seq] as const] : []))),
)
const kinds = { activity: '活动', event: '世界事件', beat: '节拍' }
const wakes = { pending: '等待处理', claimed: '已领取，尚无完成记录', completed: '已完成处理' }
const checkResults = {
  round: '尚未到触发轮次',
  clock: '尚未跨过时钟阈值',
  'clock-invalid': '尚未检测到跨越，时钟历史含缺失或无效值',
  'clock-window': '跨越发生在本次结算窗口之前',
  activity: '需等当前活动结束',
  ready: '触发条件已满足',
}
function state(item: InspectedEventRule) {
  if (item.occurrence) return '已发生 · #' + item.occurrence.seq
  if (item.rule.trigger === 'paced') {
    if (!pacing.value?.managedEvents.includes(item.rule.id)) return '节拍器未接管'
    if (!pacing.value.enabled) return '节拍器已关闭'
  }
  return item.lastCheck ? checkResults[item.lastCheck.result] : '尚无判定记录'
}
function outcome(d: InspectedPacingDecision) {
  if (d.error) return '判定出错'
  if (d.skipped === 'activity-in-progress') return '活动进行中，本轮跳过选择'
  if (d.skipped === 'unmanaged-activity') return '优先启动独立活动'
  if (!d.choice) return '未取得判定结果'
  const why = d.choice.reason.why
  return typeof why === 'string' ? (pacingReasons[why] ?? why) : d.choice.kind === 'none' ? '未选中候选' : '已选中候选'
}
function openRule(id: string) {
  const row = document.getElementById('event-rule-' + id)
  if (!(row instanceof HTMLDetailsElement)) return
  row.open = true
  row.querySelector('summary')?.focus()
  row.scrollIntoView({ block: 'nearest' })
}
function missedWitnesses(item: InspectedEventRule) {
  return item.rule.wakeCharacters?.filter(id => !item.occurrence?.witnesses.some(w => w.id === id)) ?? []
}
</script>

<template>
  <div class="cr-scroll event-diagnostics">
    <section class="cr-section">
      <h2>世界事件 · {{ rules.length }}</h2>
      <p v-if="!rules.length" class="cr-muted">
        {{ store.world ? '当前实例没有世界事件规则。' : '正在读取世界事件…' }}
      </p>
      <details v-for="item in rules" :id="'event-rule-' + item.rule.id" :key="item.rule.id" class="diagnostic-row">
        <summary>
          <strong>{{ item.rule.id }}</strong> · {{ state(item) }}
        </summary>
        <dl>
          <dt>触发条件</dt>
          <dd>
            {{ item.rule.trigger === 'paced' ? '由节拍器选择' : '到条件即结算' }} ·
            <template v-if="item.rule.crossesPackTime"
              >跨过第 {{ item.rule.crossesPackTime.at.day }} 天的「{{ item.rule.crossesPackTime.at.slot }}」</template
            >
            <template v-else>第 {{ item.rule.round }} 轮起</template>
            <template v-if="item.rule.trigger === 'paced'">
              · {{ item.rule.duringActivity ? '活动中也可入选' : '仅在活动空闲时入选' }}</template
            >
          </dd>
          <template v-if="item.rule.crossesPackTime"
            ><dt>当前包内时钟</dt>
            <dd>
              {{ item.rule.crossesPackTime.dayKey }} =
              {{ store.world?.statusTruth?.public[item.rule.crossesPackTime.dayKey] ?? '未知' }} ·
              {{ item.rule.crossesPackTime.slotKey }} =
              {{ store.world?.statusTruth?.public[item.rule.crossesPackTime.slotKey] ?? '未知' }}
            </dd></template
          >
          <template v-if="item.lastCheck"
            ><dt>最近条件检查</dt>
            <dd>
              第 {{ item.lastCheck.round }} 轮 · #{{ item.lastCheck.seq }} · {{ checkResults[item.lastCheck.result] }}
            </dd></template
          >
          <dt>事件与状态</dt>
          <dd>{{ item.rule.type }} · {{ item.rule.set.key }} = {{ item.rule.set.value }}</dd>
          <dt>见证范围</dt>
          <dd>
            {{ store.label(item.rule.location, 'locations') }} ·
            {{
              item.rule.witnesses
                .map(w =>
                  w === 'scene'
                    ? '所在场景'
                    : w === 'global'
                      ? '所有活跃角色'
                      : '持有' + store.label(w.holds, 'entities'),
                )
                .join(' 或 ')
            }}
          </dd>
          <template v-if="item.rule.sceneNotices?.length"
            ><dt>附加场景通知</dt>
            <dd v-for="group in item.rule.sceneNotices" :key="group.locations.join(',')">
              {{ group.locations.map(id => store.label(id, 'locations')).join('、') }} · {{ group.text
              }}<template v-if="group.fromOperation">（限收到 {{ group.fromOperation }} 完整操作信息者）</template>
            </dd></template
          >
          <dt>指定唤醒</dt>
          <dd>{{ item.rule.wakeCharacters?.map(id => store.label(id)).join('、') || '无人' }}</dd>
          <template v-if="item.occurrence"
            ><dt>提交记录</dt>
            <dd>
              #{{ item.occurrence.seq }} · 周期 {{ item.occurrence.cycle
              }}<template v-if="item.occurrence.pacedRound !== null">
                · 节拍第 {{ item.occurrence.pacedRound }} 轮</template
              >
            </dd></template
          >
          <template v-if="item.occurrence?.clockTransaction"
            ><dt>时钟跨越事务</dt>
            <dd class="cr-mono">{{ item.occurrence.clockTransaction }}</dd></template
          >
        </dl>
        <template v-if="item.occurrence">
          <h3>实际收到通知的角色 · {{ item.occurrence.witnesses.length }}</h3>
          <p v-if="missedWitnesses(item).length">
            指定唤醒的
            {{
              missedWitnesses(item)
                .map(id => store.label(id))
                .join('、')
            }}
            未收到本次个人通知，未安排事件唤醒。
          </p>
          <p v-if="!item.occurrence.witnesses.length" class="cr-muted">事件已提交，本次没有个人通知。</p>
          <div v-for="w in item.occurrence.witnesses" :key="w.id" class="witness">
            <strong>{{ store.label(w.id) }}</strong> · #{{ w.seq }} · {{ w.wake ? wakes[w.wake] : '仅收到通知' }}
            <p>{{ w.notice }}</p>
          </div>
          <template v-if="item.occurrence.deliveries.length">
            <h3>插件投递</h3>
            <p v-for="g in item.occurrence.deliveries" :key="g.plugin + ':' + g.mode">
              {{ g.plugin }} ·
              {{ g.mode === 'live' ? '实时投递已授权，无持久回执' : g.receipt ? '持久回执已提交' : '尚无持久回执' }}
            </p>
          </template>
        </template>
      </details>
    </section>
    <section class="cr-section">
      <h2>
        节拍器判定 <span v-if="pacing" class="cr-muted">· {{ pacing.enabled ? '已开启' : '已关闭' }}</span>
      </h2>
      <p v-if="!pacing" class="cr-muted">{{ store.world ? '当前实例没有启用节拍器。' : '正在读取节拍器…' }}</p>
      <p v-else class="cr-muted">
        {{ pacing.decisions.length ? '当前实例最近 16 次结算，最新在前。' : '当前实例尚无节拍判定记录。' }}
      </p>
      <details v-for="d in pacing?.decisions" :key="d.id" class="diagnostic-row">
        <summary>
          <strong>第 {{ d.round }} 轮</strong> · {{ outcome(d)
          }}<template v-if="d.choice && d.choice.kind !== 'none'"> · {{ d.choice.key }}</template>
        </summary>
        <p class="cr-muted">判定时序号 #{{ d.seq }} · 周期 {{ d.cycle }} · {{ d.busy ? '活动进行中' : '活动空闲' }}</p>
        <p v-if="d.error" class="cr-banner danger">{{ d.error }}</p>
        <p v-if="d.priorityActivity">独立活动 · {{ d.priorityActivity }}</p>
        <p v-if="d.occurrenceId">
          {{
            committed.has(d.occurrenceId)
              ? '该次选择已提交 · #' + committed.get(d.occurrenceId)
              : '该次选择尚无提交记录'
          }}
        </p>
        <template v-if="d.candidates">
          <h3>提交给节拍器的候选 · {{ d.candidates.length }}</h3>
          <p v-if="!d.candidates.length" class="cr-muted">本轮候选为空。</p>
          <p v-for="c in d.candidates" :key="c.kind + ':' + c.key">
            {{ kinds[c.kind] }} ·
            <button v-if="c.kind === 'event'" type="button" class="rule-link" @click="openRule(c.key)">
              {{ c.key }}</button
            ><span v-else>{{ c.key }}</span>
            <strong v-if="d.choice?.kind === c.kind && d.choice.key === c.key"> · 已选中</strong>
          </p>
          <template v-if="d.choice">
            <p v-if="typeof d.choice.reason.chance === 'number'">
              本轮触发概率 {{ Math.round(d.choice.reason.chance * 100) }}%
            </p>
            <p v-if="d.lastFired">
              上次已发生 · 第 {{ d.lastFired.round }} 轮 · {{ kinds[d.lastFired.kind] }} {{ d.lastFired.key }}
            </p>
            <p v-if="typeof d.choice.reason.tension === 'number'">
              张力 {{ d.choice.reason.tension.toFixed(2)
              }}<template v-if="typeof d.choice.reason.stagnation === 'number'">
                · 停滞度 {{ d.choice.reason.stagnation.toFixed(2) }}</template
              ><template v-if="d.lastProgressRound !== undefined">
                · 最近进展基准为第 {{ d.lastProgressRound }} 轮</template
              >
            </p>
            <p v-if="Array.isArray(d.choice.reason.repeated)">重复间隔内 · {{ d.choice.reason.repeated.join('、') }}</p>
          </template>
        </template>
        <template v-if="d.beats.length"
          ><h3>节拍条件</h3>
          <div v-for="beat in d.beats" :key="beat.id" class="witness">
            <strong>{{ beat.id }}</strong>
            <p v-if="beat.error" class="cr-banner danger">{{ beat.error }}</p>
            <p v-for="(check, index) in beat.checks" :key="index">
              {{ check.met ? '通过' : '未满足' }} · {{ check.label || '条件 ' + (index + 1) }}
            </p>
          </div>
        </template>
      </details>
    </section>
  </div>
</template>

<style scoped>
.diagnostic-row {
  border-bottom: 1px solid var(--cr-line);
  padding: 8px 0;
  overflow-wrap: anywhere;
}
.diagnostic-row summary {
  cursor: pointer;
  padding: 3px 0;
}
.diagnostic-row[open] > summary {
  margin-bottom: 10px;
}
.event-diagnostics dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 5px 14px;
}
.event-diagnostics dt {
  color: var(--cr-dim);
  grid-column: 1;
}
.event-diagnostics dd {
  margin: 0;
  grid-column: 2;
}
.event-diagnostics h3 {
  margin: 12px 0 5px;
  font-size: 13px;
}
.diagnostic-row p {
  margin: 4px 0;
}
.witness {
  padding: 5px 0;
}
.rule-link {
  color: inherit;
  font: inherit;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
}
</style>
