import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlayerView } from '@perspectra/frontend'
import type { OfficialRpgBattleView } from '../official-pack-metadata.ts'
import { FrontendActions } from '../runtime/frontend-adapter.ts'
import { LensSimulation, type LensStep } from '../simulation/simulation.ts'
import { assertStep, buildSource } from './export.ts'
import { rpgBook } from './rpg.ts'
import { trialRequest } from './rpg-play.ts'

type Check = { step: string; passed: boolean; message: string }
const operation = (a: PlayerView['actions'][number]) =>
  (a.action.parameters.definitionRef as { id?: string } | undefined)?.id

export async function playExit(source: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const stage = mkdtempSync(join(tmpdir(), 'perspectra-exit-'))
  let sim: LensSimulation | undefined
  try {
    await buildSource(realpathSync(source), stage)
    const book = rpgBook(stage),
      map = book.config?.maps?.find(m => m.locationId === body.location),
      exit = map?.exits?.find(e => e.to === body.to)
    if (!map || !exit?.requires) throw new TypeError('请选择已配置钥匙的地图出口')
    const origin = map.locationId,
      { to, lockedReason } = exit,
      key = exit.requires.holds,
      request = trialRequest(stage, body, book)
    if (!map.drops?.includes(key)) throw new TypeError('请选择使用本图胜利掉落物的出口')
    signal?.throwIfAborted()
    const game = (sim = await LensSimulation.open(stage, { scenes: request.scenes }))
    const api = new FrontendActions(game.previewRuntime)
    let view = await api.view()
    const result = { location: origin, to, item: key, passed: false, checks: [] as Check[] }
    let step = '空手尝试通行'
    const atOrigin = () => view.scene?.locationId === origin
    const where = () => view.items?.find(i => i.id === key)?.where
    const phase = () =>
      view.activities?.find(a => a.key === request.key)?.phase ??
      (view.activity?.key === request.key ? view.activity.phase : undefined)
    const check = (message: string) => result.checks.push({ step, passed: true, message })
    async function perform(action: LensStep, denied = false) {
      signal?.throwIfAborted()
      const trace = await game.step(action)
      if (trace.error || trace.fault || !denied) assertStep(trace)
      view = await api.view()
      return trace
    }
    async function move(denied: boolean) {
      const offered = view.actions.find(a => a.kind === 'move' && a.target?.id === to)
      if (!offered) throw new Error('当前没有通往这个地点的移动选项')
      const trace = await perform({ kind: 'action', action: offered.action }, denied)
      const resolved = trace.resolutions?.find(r => r.actorId === book.player && r.actionType === 'move')
      if (denied) {
        if (!atOrigin() || resolved?.accepted !== false) throw new Error('预期门锁拒绝通行，实际结果不符')
        const expected = lockedReason ?? '这条路现在走不通。'
        if (resolved.reason !== 'plugin:' + expected) throw new Error('移动被其他规则拒绝：' + String(resolved.reason))
        check('移动被拒绝，玩家仍在原地。' + expected)
      } else {
        if (resolved?.accepted !== true || view.scene?.locationId !== to) throw new Error('移动后没有到达目标地点')
        check('已经到达' + (view.scene?.locationName ?? to))
      }
    }
    async function useItem(id: string, label: string) {
      const option = view.actions.find(a => operation(a) === id && a.target?.id === key)
      if (!option) throw new Error('当前没有对这件物品的「' + label + '」操作，请检查物品操作与包内规则')
      const trace = await perform({ kind: 'action', action: option.action })
      const resolved = trace.resolutions?.find(
        r => r.actorId === book.player && r.actionType === option.action.actionType,
      )
      if (resolved?.accepted !== true)
        throw new Error('「' + label + '」未获准：' + (resolved?.reason ?? '缺少裁定结果'))
    }
    try {
      if (!atOrigin() || where() === 'held') throw new Error('请让玩家从所选地图空手开始')
      await move(true)
      step = '战斗胜利并掉落钥匙'
      if (!view.activity?.active && phase() !== 'victory') await perform({ kind: 'wait' })
      for (let n = 0; n < 64 && phase() !== 'victory'; n++) {
        const active = view.activity
        if (!active?.active || active.key !== request.key || !active.id || active.revision === undefined) break
        const battle =
          view.activityStage?.renderer === 'official-rpg.battle'
            ? (view.activityStage.payload as unknown as OfficialRpgBattleView)
            : undefined
        const engage = view.actions.some(a => operation(a) === 'activity:engage' && a.target?.id === request.key)
        const enemies = new Set(battle?.units.filter(u => u.team === 'enemy' && u.hp > 0).map(u => u.name))
        const damage = (name: string) =>
          book.config?.skills
            ?.find(s => s.name === name)
            ?.effects.reduce((total, e) => total + (e.kind === 'damage' ? e.amount : 0), 0) ?? 0
        const skill = battle?.skills
          .filter(s => !s.unavailable && s.targets.some(t => enemies.has(t)))
          .sort((a, b) => damage(b.name) - damage(a.name))[0]
        const target = skill?.targets.find(t => enemies.has(t))
        if (
          !engage &&
          (!skill ||
            !target ||
            !view.actions.some(a => operation(a) === 'activity:skill' && a.target?.id === request.key))
        )
          throw new Error('当前没有可自动执行的对敌技能，请用交互试玩检查战斗')
        await perform({
          kind: 'activity',
          request: {
            activityKey: request.key,
            activityId: active.id,
            revision: active.revision,
            operation: engage ? 'engage' : 'skill',
            parameters: !engage && skill && target ? { skill: skill.name, target } : {},
          },
        })
      }
      if (phase() === 'not-started') throw new Error('遭遇未启动，请在「试玩起点」核对参与角色的场景')
      if (phase() !== 'victory') throw new Error('本次自动战斗没有取得胜利（' + (phase() ?? '未进入遭遇') + '）')
      if (!atOrigin() || where() !== 'here') throw new Error('战斗已获胜，但未核实所选钥匙作为本图掉落物出现在地上')
      check('战斗已胜利，玩家在地上看到钥匙')
      step = '胜利后未拾取'
      await move(true)
      step = '拾取钥匙'
      await useItem('status:take', '拿起')
      if (where() !== 'held') throw new Error('操作结束后玩家没有持有钥匙')
      check('玩家已持有钥匙')
      step = '持有但未开锁'
      await move(true)
      step = '使用钥匙开锁'
      await useItem('status:rpg-unlock', '开锁')
      check('开锁操作已经裁定')
      step = '开锁后通行'
      await move(false)
      result.passed = true
    } catch (e) {
      signal?.throwIfAborted()
      result.checks.push({ step, passed: false, message: (e as Error).message })
    }
    return result
  } finally {
    try {
      await sim?.close()
    } finally {
      rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  }
}
