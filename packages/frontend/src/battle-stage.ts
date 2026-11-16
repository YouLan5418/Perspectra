import type { PlayerView } from './player-view.ts'

export const BATTLE_STAGE_HTML = `<section id="battle-stage" class="battle-stage" aria-label="官方 RPG 战斗" tabindex="-1" hidden></section>`
export const BATTLE_STAGE_STYLE = `
.battle-stage[hidden]{display:none!important}
.battle-stage{position:fixed;inset:0;z-index:1000;overflow:auto;box-sizing:border-box;padding:clamp(16px,4vw,48px);background:var(--ink-0,#faf9f6);color:var(--text,#222);display:flex;flex-direction:column;gap:20px}
.battle-stage h2,.battle-stage h3,.battle-stage p{margin:0}.battle-stage h2{font-size:clamp(22px,4vw,34px)}
.battle-summary{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.battle-kicker{font-size:12px;letter-spacing:.14em;opacity:.65}
.battle-teams{display:grid;grid-template-columns:1fr 1fr;gap:24px}.battle-team{display:grid;align-content:start;gap:10px}
.battle-unit{border:1px solid currentColor;border-radius:12px;padding:14px;display:grid;gap:8px}.battle-unit[data-turn=true]{outline:2px solid currentColor;outline-offset:3px}.battle-unit[data-down=true]{opacity:.5}
.battle-unit progress{width:100%;height:12px;accent-color:#497967}.battle-unit[data-team=enemy] progress{accent-color:#aa625b}
.battle-unit-line{display:flex;justify-content:space-between;gap:8px}.battle-actions{display:flex;flex-wrap:wrap;gap:12px;align-items:end}.battle-actions form{display:flex;flex-wrap:wrap;align-items:end;gap:10px;padding:12px;border:1px solid #8885;border-radius:10px}.battle-actions label{display:grid;gap:6px;font-size:13px}.battle-actions select,.battle-actions button,.battle-reading{min-height:44px;max-width:100%;font:inherit}.battle-actions select{padding:8px;background:var(--ink-0,#faf9f6);color:inherit;border:1px solid #888;border-radius:6px}.battle-actions button{padding:10px 18px}
.battle-reading{margin-top:auto;text-align:left;padding:16px;border:1px solid #8885;border-radius:12px;color:inherit;background:transparent;white-space:pre-wrap}.battle-notice{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}.battle-stage :focus-visible{outline:3px solid #568eb0;outline-offset:3px}
@media(max-width:540px){.battle-stage{gap:16px;padding:16px}.battle-teams{gap:14px;grid-template-columns:1fr}.battle-unit{padding:10px}.battle-actions,.battle-actions form{width:100%;box-sizing:border-box}.battle-actions label{flex:1;min-width:100px}.battle-actions button{flex:1}}
`

/** Bundled only: no loader, URLs or world rules. The caller owns perform, reading and view switching. */
export function createBattleStage(
  root: HTMLElement,
  perform: (optionId: string, args: Record<string, unknown>) => void,
  read: () => void,
) {
  let current: PlayerView | undefined,
    blocked = true,
    signature = ''
  const helpers = {
    el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
      const node = document.createElement(tag)
      if (text !== undefined) node.textContent = text
      return node
    },
    identity(view: PlayerView) {
      return JSON.stringify([
        view.battle?.activityId,
        view.battle?.revision,
        view.tailRound?.worldVersion,
        view.tailRound?.id,
        view.tailRound?.candidateIds?.[(view.tailRound.candidateIndex ?? 1) - 1],
      ])
    },
  }
  return {
    update(view: PlayerView, disabled: boolean, reading: boolean, dialogue: string, notice: string) {
      current = view
      blocked = disabled
      const battle = view.battle
      if (!battle || battle.kind !== 'official-rpg-battle' || !battle.units.length)
        throw Error('Battle view incomplete')
      const options = view.actions.filter(
        option =>
          (option.kind === 'activity' || option.kind === 'manage') &&
          option.target?.kind === 'activity' &&
          option.target.id === battle.activityKey,
      )
      const key = JSON.stringify([battle, options, helpers.identity(view)])
      if (key !== signature) {
        signature = key
        const snapshot = helpers.identity(view)
        const request = {
          send(id: string, args: Record<string, unknown> = {}) {
            if (
              blocked ||
              !current ||
              helpers.identity(current) !== snapshot ||
              !current.actions.some(option => option.id === id)
            )
              return
            perform(id, args)
          },
        }
        const heading = helpers.el('div')
        heading.className = 'battle-summary'
        const title = helpers.el('div')
        title.append(helpers.el('p', 'OFFICIAL RPG · 战斗'), helpers.el('h2', battle.title))
        title.firstElementChild!.className = 'battle-kicker'
        const actor = battle.units.find(unit => unit.id === battle.turn)?.name ?? '等待裁定'
        heading.append(title, helpers.el('p', `第 ${battle.round} 回合 · ${actor}`))
        const teams = helpers.el('div')
        teams.className = 'battle-teams'
        for (const team of ['party', 'enemy'] as const) {
          const box = helpers.el('section')
          box.className = 'battle-team'
          box.append(helpers.el('h3', team === 'party' ? '我方' : '敌方'))
          for (const unit of battle.units.filter(unit => unit.team === team)) {
            if (!Number.isFinite(unit.hp) || !Number.isFinite(unit.maxHp) || unit.maxHp <= 0)
              throw Error('Invalid health')
            const card = helpers.el('div')
            card.className = 'battle-unit'
            card.dataset.unit = unit.id
            card.dataset.team = team
            card.dataset.turn = String(unit.id === battle.turn)
            card.dataset.down = String(unit.hp === 0)
            const row = helpers.el('div')
            row.className = 'battle-unit-line'
            row.append(helpers.el('strong', unit.name), helpers.el('span', `${unit.hp} / ${unit.maxHp}`))
            const hp = helpers.el('progress')
            hp.max = unit.maxHp
            hp.value = unit.hp
            hp.setAttribute('aria-label', unit.name + '生命')
            card.append(row, hp)
            if (unit.shield)
              card.append(helpers.el('p', `护盾 ${unit.shield.amount} · 剩余 ${unit.shield.remaining} 次行动`))
            for (const status of unit.statuses ?? [])
              card.append(helpers.el('p', `${status.name} · 剩余 ${status.remaining} 次行动`))
            box.append(card)
          }
          teams.append(box)
        }
        const actions = helpers.el('div')
        actions.className = 'battle-actions'
        for (const option of options) {
          const properties = option.argumentSchema?.properties as Record<string, { enum?: unknown[] }> | undefined
          if (properties?.skill && properties?.target) {
            const form = helpers.el('form'),
              skill = helpers.el('select'),
              target = helpers.el('select'),
              button = helpers.el('button', option.label)
            skill.setAttribute('aria-label', '技能')
            target.setAttribute('aria-label', '合法目标')
            button.type = 'button'
            const choices = battle.skills.filter(item => properties.skill?.enum?.includes(item.name))
            for (const item of choices) {
              const opt = helpers.el('option', item.name + (item.unavailable ? ` · ${item.unavailable}` : ''))
              opt.value = item.name
              opt.disabled = !!item.unavailable || !item.targets.length
              skill.append(opt)
            }
            skill.value = choices.find(item => !item.unavailable && item.targets.length)?.name ?? ''
            const picker = {
              targets() {
                target.replaceChildren()
                for (const name of choices.find(item => item.name === skill.value)?.targets ?? []) {
                  if (!properties.target?.enum?.includes(name)) continue
                  const opt = helpers.el('option', name)
                  opt.value = name
                  target.append(opt)
                }
                button.dataset.unavailable = String(!target.value || !skill.value)
                button.disabled = blocked || button.dataset.unavailable === 'true'
              },
            }
            skill.onchange = () => picker.targets()
            picker.targets()
            for (const [text, input] of [
              ['技能', skill],
              ['合法目标', target],
            ] as const) {
              const label = helpers.el('label', text)
              label.append(input)
              form.append(label)
            }
            form.append(button)
            form.onsubmit = event => event.preventDefault()
            button.onclick = () => {
              if (target.value && skill.value) request.send(option.id, { skill: skill.value, target: target.value })
            }
            actions.append(form)
          } else if (!properties || Object.keys(properties).length === 0) {
            const button = helpers.el('button', option.label)
            button.type = 'button'
            button.onclick = () => request.send(option.id)
            actions.append(button)
          } else throw Error('Unsupported battle operation inputs')
        }
        if (!options.length) actions.append(helpers.el('p', '等待当前角色行动；可切回默认界面查看或继续。'))
        const feedback = helpers.el('p')
        feedback.className = 'battle-notice'
        feedback.setAttribute('role', 'status')
        const readingButton = helpers.el('button')
        readingButton.className = 'battle-reading'
        readingButton.type = 'button'
        readingButton.onclick = read
        root.replaceChildren(heading, teams, actions, feedback, readingButton)
      }
      for (const input of root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
        '.battle-actions button,.battle-actions select',
      ))
        input.disabled = disabled || input.dataset.unavailable === 'true'
      root.querySelector('.battle-notice')!.textContent = notice || battle.lastResult
      const readingButton = root.querySelector<HTMLButtonElement>('.battle-reading')!
      readingButton.textContent = reading ? dialogue + '\n点击继续阅读' : '已读完 · 按当前可用操作行动'
      readingButton.disabled = !reading
    },
  }
}
