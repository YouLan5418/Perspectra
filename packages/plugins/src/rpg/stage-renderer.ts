import type { ActivityStageRenderer, ActivityStageRenderContext, WorldJsonObject } from '@perspectra/sdk/contracts'
import type { OfficialRpgBattleView } from './battle-presentation.ts'

export const BATTLE_STAGE_STYLE = `
.battle-stage{
  --battle-bg:#141d21;--battle-surface:#1d292e;--battle-field:#19272b;--battle-border:#3d5056;
  --battle-text:#f2eee3;--battle-muted:#bac9ca;--battle-turn:#eed596;--battle-mint:#9ce2c4;--battle-enemy:#e9a593;
  background:var(--battle-bg);color:var(--battle-text);padding:clamp(18px,3vw,44px);
  font:15px/1.5 "Noto Sans CJK SC","Microsoft YaHei",sans-serif;overflow:auto;overflow-wrap:anywhere;color-scheme:dark
}
.battle-stage :is(h2,h3,p,dl,dd){margin:0}
.battle-stage h2{font-size:clamp(24px,3vw,36px);line-height:1.2;letter-spacing:-.035em}
.battle-stage h3{font-size:18px;line-height:1.3}
.battle-layout{max-width:1100px;min-height:100%;margin:0 auto;display:grid;align-content:start;gap:clamp(16px,2.8vh,28px)}
.battle-summary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px 24px;align-items:center}
.battle-kicker,.battle-reading-count,.battle-team h3{color:var(--battle-muted);font-size:13px;font-weight:650}
.battle-turn-line{grid-column:1/-1;padding:10px 0;border-block:1px solid var(--battle-border);display:flex;gap:5px 18px;align-items:baseline;flex-wrap:wrap}
.battle-turn-line strong{color:var(--battle-turn);font-size:clamp(19px,2.4vw,25px)}
.battle-phase{color:var(--battle-muted)}
.battle-stage button,.battle-record summary{
  font:inherit;color:inherit;background:var(--battle-surface);border:1px solid var(--battle-border);border-radius:8px;
  min-height:44px;padding:8px 14px;cursor:pointer;text-align:left
}
.battle-stage button:disabled{cursor:default;opacity:.57}
.battle-stage button:hover:not(:disabled),.battle-record summary:hover{border-color:var(--battle-mint)}
.battle-stage :is(button,summary):focus-visible{outline:3px solid var(--battle-mint);outline-offset:3px}
.battle-record{position:relative;align-self:center;z-index:1}
.battle-record summary{display:flex;align-items:center;gap:8px;list-style:none;font-size:14px}
.battle-record summary::-webkit-details-marker{display:none}
.battle-record summary::after{content:"＋";font-size:12px;color:var(--battle-muted)}
.battle-record[open] summary::after{content:"−"}
.battle-record-body{position:absolute;right:0;top:calc(100% + 8px);width:min(360px,calc(100vw - 36px));max-height:min(320px,65dvh);
  overflow:auto;padding:16px;border:1px solid var(--battle-border);border-radius:10px;background:var(--battle-surface);box-shadow:0 10px 30px #0006;
  display:grid;gap:8px
}
.battle-teams{
  display:grid;grid-template-columns:1fr 1fr;gap:clamp(12px,4vw,48px);align-items:start;
  padding:clamp(12px,3vw,32px);border:1px solid var(--battle-border);border-radius:16px;
  background:var(--battle-field) radial-gradient(ellipse at 50% 0%,#2a3c3e 0%,transparent 75%)
}
.battle-team{min-width:0;display:grid;gap:10px}
.battle-unit,.battle-stage button.battle-unit{
  padding:clamp(10px,1.5vw,18px);min-width:0;display:grid;gap:8px;background:var(--battle-surface);
  border:1px solid var(--battle-border);border-radius:10px;color:var(--battle-text)
}
.battle-unit[data-turn=true]{border-color:var(--battle-turn);box-shadow:inset 3px 0 var(--battle-turn)}
.battle-unit[data-down=true]{opacity:.6}
.battle-stage button.battle-unit[data-legal=true]{border-color:var(--battle-mint)}
.battle-unit[data-selected=true]{outline:2px solid var(--battle-mint);outline-offset:2px}
.battle-unit-name{font-size:clamp(16px,2vw,20px)}
.battle-unit-line{display:flex;align-items:baseline;justify-content:space-between;gap:3px 10px;flex-wrap:wrap}
.battle-meter-label,.battle-unit .battle-unit-meta{font-size:13px;color:var(--battle-muted)}
.battle-unit progress{appearance:none;width:100%;height:7px;border:0;border-radius:999px;overflow:hidden;background:#3b4b50;color:var(--battle-mint)}
.battle-unit progress::-webkit-progress-bar{background:#3b4b50}
.battle-unit progress::-webkit-progress-value{background:var(--battle-mint);border-radius:999px}
.battle-unit progress::-moz-progress-bar{background:var(--battle-mint)}
.battle-unit[data-team=enemy] progress::-webkit-progress-value{background:var(--battle-enemy)}
.battle-unit[data-team=enemy] progress::-moz-progress-bar{background:var(--battle-enemy)}
.battle-target-label,.battle-unit .battle-target-label{color:var(--battle-mint);font-size:13px;font-weight:650}
.battle-actions{display:grid;gap:12px}
.battle-choices{display:flex;flex-wrap:wrap;gap:8px;align-items:start}
.battle-skill{display:grid;gap:2px}
.battle-stage .battle-skill:disabled{opacity:1;border-style:dashed;color:var(--battle-muted)}
.battle-skill-meta{font-size:13px;color:var(--battle-muted)}
.battle-stage button.battle-primary{background:var(--battle-mint);color:#122f25;border-color:var(--battle-mint);font-weight:700}
.battle-stage button.battle-primary:hover:not(:disabled){background:#c2f2df}
.battle-notice,.battle-action-note{font-size:14px;color:var(--battle-muted);white-space:pre-wrap}
.battle-resources{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--battle-text)}
.battle-confirmation{display:flex;flex-wrap:wrap;gap:6px 24px}
.battle-confirmation div{display:flex;gap:8px}
.battle-confirmation dt{color:var(--battle-muted)}
.battle-confirmation dd{font-weight:650}
.battle-reader .battle-layout{max-width:760px;align-content:center}
.battle-reading-line{white-space:pre-wrap;border-left:2px solid var(--battle-turn);padding:12px 16px;background:var(--battle-surface);line-height:1.7}
@media(max-width:540px){
  .battle-stage{padding:16px}
  .battle-layout{gap:16px}
  .battle-turn-line{padding:8px 0}
  .battle-teams{gap:10px;border-radius:12px}
  .battle-action-note{font-size:13px}
}
`

/** Bundled display only. The host still owns options, submission, read position and view switching. */
export function createBattleStage(root: HTMLElement) {
  type Option = ActivityStageRenderContext['actions'][number]
  type Skill = OfficialRpgBattleView['skills'][number]
  type Selection = { option: Option; skill?: Skill | undefined; target?: string | undefined }

  root.classList.add('battle-stage')
  let identity = '',
    signature = ''
  let selection: Selection | undefined

  const { el } = {
    el<K extends keyof HTMLElementTagNameMap>(tag: K, content?: string, className?: string) {
      const node = document.createElement(tag)
      if (content !== undefined) node.textContent = content
      if (className) node.className = className
      return node
    },
  }

  return {
    update(payload: WorldJsonObject, context: ActivityStageRenderContext) {
      const { actions, disabled, identity: currentIdentity, notice, presentation } = context
      const battle = payload as unknown as OfficialRpgBattleView
      if (battle?.kind !== 'official-rpg-battle' || !battle.units.length) throw Error('Battle view incomplete')
      if (identity !== currentIdentity) {
        identity = currentIdentity
        selection = undefined
      }
      const key = JSON.stringify([identity, battle, actions, disabled, notice, presentation, !!presentation?.retry])
      if (signature === key) return
      signature = key

      const actor = battle.units.find(unit => unit.id === battle.turn)
      const phase = presentation?.phase ?? 'ready'
      const status = {
        ready: actions.length && !disabled ? '可选择行动' : '等待当前回合',
        submitting: '正在提交行动',
        processing: '系统处理中',
        responding: '角色正在回应',
        unconfirmed: '提交结果待确认',
        error: '处理未完成',
      }[phase]
      const settling = (phase === 'submitting' || phase === 'processing') && !!notice
      const inputReady = !disabled && (phase === 'ready' || phase === 'error')
      const actionChoices = actions.map(option => {
        const fields = option.argumentSchema?.properties as Record<string, { enum?: unknown[] }> | undefined
        if (!fields || !Object.keys(fields).length) return { option }
        if (!fields.skill || !fields.target) throw Error('Unsupported battle operation inputs')
        return {
          option,
          skills: battle.skills
            .filter(skill => fields.skill?.enum?.includes(skill.name))
            .map(skill => ({ ...skill, targets: skill.targets.filter(name => fields.target?.enum?.includes(name)) })),
        }
      })
      if (selection) {
        const choice = actionChoices.find(row => row.option.id === selection?.option.id)
        const skill = choice?.skills?.find(row => row.name === selection?.skill?.name)
        if (!choice || (selection.skill && (!skill || skill.unavailable || !skill.targets.length)))
          selection = undefined
        else
          selection = {
            option: choice.option,
            skill,
            target: skill?.targets.includes(selection.target ?? '') ? selection.target : undefined,
          }
      }
      const selfResources = presentation?.resources ?? []

      const { render } = {
        render(focusKey?: string) {
          const oldFocus = document.activeElement as HTMLElement | null
          const focusedInStage = oldFocus && root.contains(oldFocus)
          const oldKey = focusedInStage ? oldFocus.dataset.battleFocus : undefined
          const keepRecordOpen = root.querySelector<HTMLDetailsElement>('.battle-record')?.open ?? false
          const layout = el('div', undefined, 'battle-layout')
          const heading = el('div', undefined, 'battle-summary')
          const title = el('div')
          title.append(el('p', `第 ${battle.round} 回合`, 'battle-kicker'), el('h2', battle.title))
          const turn = el('div', undefined, 'battle-turn-line')
          turn.setAttribute('role', 'status')
          if (settling) turn.append(el('strong', notice))
          else turn.append(el('strong', actor ? `轮到 ${actor.name}` : '等待裁定'), el('span', status, 'battle-phase'))
          const record = el('details', undefined, 'battle-record')
          record.open = keepRecordOpen
          const summary = el('summary', '战斗记录')
          summary.dataset.battleFocus = 'record'
          const log = el('div', undefined, 'battle-record-body')
          log.append(el('p', battle.lastResult || '暂时没有战斗结果。'))
          for (const row of battle.sharedValues ?? []) log.append(el('p', `${row.label} ${row.value}`))
          record.append(summary, log)
          heading.append(title, record, turn)
          layout.append(heading)

          const { button } = {
            button(text: string, key: string, run: () => void, enabled = inputReady, className?: string) {
              const item = el('button', text, className)
              item.type = 'button'
              item.disabled = !enabled
              item.dataset.battleFocus = key
              item.onclick = () => {
                if (!item.disabled) run()
              }
              return item
            },
          }

          const targets = inputReady && selection?.skill && !selection.target ? selection.skill.targets : []
          const { chooseTarget } = {
            chooseTarget(name: string) {
              if (!selection) return
              selection.target = name
              render('confirm')
            },
          }
          const represented = new Set<string>()
          const teams = el('div', undefined, 'battle-teams')
          for (const team of ['party', 'enemy'] as const) {
            const box = el('section', undefined, 'battle-team')
            box.append(el('h3', team === 'party' ? '我方' : '敌方'))
            for (const unit of battle.units.filter(unit => unit.team === team)) {
              if (!Number.isFinite(unit.hp) || !Number.isFinite(unit.maxHp) || unit.maxHp <= 0)
                throw Error('Invalid health')
              const legal =
                targets.includes(unit.name) && battle.units.filter(row => row.name === unit.name).length === 1
              const card = legal ? button('', 'target:' + unit.name, () => chooseTarget(unit.name)) : el('div')
              card.className = 'battle-unit'
              card.dataset.unit = unit.id
              card.dataset.team = team
              card.dataset.turn = String(unit.id === battle.turn)
              card.dataset.down = String(unit.hp === 0)
              if (inputReady && selection?.target) card.dataset.selected = String(unit.name === selection.target)
              if (legal) {
                represented.add(unit.name)
                card.dataset.legal = 'true'
                card.setAttribute('aria-label', '选择目标 ' + unit.name)
              }
              const row = el('span', undefined, 'battle-unit-line')
              row.append(
                el('strong', unit.name, 'battle-unit-name'),
                el('span', `生命 ${unit.hp} / ${unit.maxHp}`, 'battle-meter-label'),
              )
              const hp = el('progress')
              hp.max = unit.maxHp
              hp.value = unit.hp
              hp.setAttribute('aria-label', unit.name + '生命')
              card.append(row, hp)
              for (const value of [...(unit.attributes ?? []), ...(unit.resources ?? [])])
                card.append(el('span', `${value.label} ${value.value} / ${value.max}`, 'battle-unit-meta'))
              if (unit.shield)
                card.append(
                  el('span', `护盾 ${unit.shield.amount} · 剩余 ${unit.shield.remaining} 次行动`, 'battle-unit-meta'),
                )
              for (const effect of unit.statuses ?? [])
                card.append(
                  el(
                    'p',
                    `${effect.name} · 剩余 ${effect.remaining} ${effect.timing === 'round-end' ? '轮' : '次行动'}`,
                  ),
                )
              if (legal) card.append(el('span', '可选目标', 'battle-target-label'))
              box.append(card)
            }
            teams.append(box)
          }
          layout.append(teams)

          const area = el('section', undefined, 'battle-actions')
          const choices = el('div', undefined, 'battle-choices')
          const resources = el('p', undefined, 'battle-resources')
          resources.dataset.authorizedResource = ''
          for (const resource of selfResources) resources.append(el('span', resource))
          if (inputReady && actionChoices.length) {
            if (selection && (!selection.skill || selection.target)) {
              const chosen = selection
              const details = el('dl', undefined, 'battle-confirmation')
              for (const [label, value] of [
                ['行动', chosen.skill?.name ?? chosen.option.label],
                ['目标', chosen.target],
                ['消耗', chosen.skill?.costs?.map(row => row.label + ' ' + row.amount).join('、') ?? undefined],
              ]) {
                if (!value) continue
                const pair = el('div')
                pair.append(el('dt', label), el('dd', value))
                details.append(pair)
              }
              area.append(el('h3', '确认行动'), details)
              choices.append(
                button(
                  chosen.skill ? '施放' + chosen.skill.name : '确认提交',
                  'confirm',
                  () => {
                    context.perform(
                      chosen.option.id,
                      chosen.skill ? { skill: chosen.skill.name, target: chosen.target } : {},
                    )
                  },
                  true,
                  'battle-primary',
                ),
                button('返回', 'back', () => {
                  selection = chosen.skill ? { ...chosen, target: undefined } : undefined
                  render(
                    chosen.skill?.targets.length ? 'target:' + chosen.skill.targets[0] : 'option:' + chosen.option.id,
                  )
                }),
              )
            } else if (selection?.skill) {
              const chosen = selection
              area.append(
                el('h3', '选择目标'),
                el('p', selection.skill.name + ' · 请在战场中选择高亮目标', 'battle-action-note'),
              )
              for (const name of targets.filter(name => !represented.has(name)))
                choices.append(button(name, 'target:' + name, () => chooseTarget(name)))
              choices.append(
                button('返回选技能', 'back', () => {
                  selection = undefined
                  render('skill:' + chosen.option.id + ':' + chosen.skill?.name)
                }),
              )
            } else {
              area.append(el('h3', '选择行动'))
              for (const { option, skills } of actionChoices) {
                if (skills) {
                  for (const skill of skills) {
                    const reason = skill.unavailable ?? (!skill.targets.length ? '暂无可选目标' : undefined)
                    const choice = button(
                      skill.name,
                      'skill:' + option.id + ':' + skill.name,
                      () => {
                        selection = { option, skill }
                        render('target:' + skill.targets[0])
                      },
                      !reason,
                    )
                    choice.className = 'battle-skill'
                    if (skill.costs) {
                      const cost = skill.costs
                        .map(
                          row => row.label + ' ' + row.amount + (row.shortfall ? '（还差 ' + row.shortfall + '）' : ''),
                        )
                        .join('、')
                      choice.append(el('span', cost ? '消耗 ' + cost : '无消耗', 'battle-skill-meta'))
                    }
                    if (reason) choice.append(el('span', reason, 'battle-skill-meta'))
                    choices.append(choice)
                  }
                } else {
                  choices.append(
                    button(option.label, 'option:' + option.id, () => {
                      selection = { option }
                      render('confirm')
                    }),
                  )
                }
              }
            }
            if (resources.childElementCount) area.append(resources)
          }
          if (presentation?.retry) choices.append(button('检查结果', 'retry', presentation.retry, true))
          if (choices.childElementCount) area.append(choices)
          if (notice && !settling) area.append(el('p', notice, 'battle-notice'))
          if (area.childElementCount) layout.append(area)
          root.replaceChildren(layout)

          if (focusKey || focusedInStage) {
            const focused = Array.from(root.querySelectorAll<HTMLElement>('[data-battle-focus]:not(:disabled)'))
            ;(focused.find(item => item.dataset.battleFocus === (focusKey || oldKey)) ?? focused[0] ?? root).focus({
              preventScroll: !focusKey,
            })
          }
        },
      }
      render()
    },
  }
}

export const officialRpgStageRenderer: ActivityStageRenderer = {
  id: 'official-rpg.battle',
  moduleId: 'official-rpg',
  style: BATTLE_STAGE_STYLE,
  presentation: { readingTitle: '阅读战斗叙事', selfStatusKeys: ['rpg-mp'] },
  create: createBattleStage,
}
