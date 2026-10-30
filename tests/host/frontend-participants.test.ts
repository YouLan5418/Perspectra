import { expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { createParticipantPicker } from '../../packages/frontend/src/participant-picker.ts'
import { DEFAULT_SCRIPT } from '../../packages/frontend/src/default-template.ts'
import { HOST_ACTIVITY_PAGE } from '../../desktop/host/host-page.ts'

class Element {
  children: Element[] = []
  dataset: Record<string, string> = {}
  textContent = ''
  value = ''
  checked = false
  disabled = false
  parentNode: Element | null = null
  onchange = () => {}
  onclick = () => {}
  append(...children: Element[]) {
    for (const child of children) child.parentNode = this
    this.children.push(...children)
  }
  setAttribute() {}
}
const selection = {
  min: 2,
  max: 3,
  candidates: ['Claude', 'DeepSeek', 'GPT', '备用角色'].map(name => ({ id: 'character:' + name, name })),
}
const document = { createElement: () => new Element() }
const embeddedPicker = () =>
  runInNewContext('(' + createParticipantPicker.toString() + ')', { document }) as typeof createParticipantPicker

it('keeps independently checked participants, reports limits and allows deselection', () => {
  const changed: boolean[] = []
  const picker = embeddedPicker()(selection, '谁是卧底', valid => changed.push(valid))
  const element = picker.element as unknown as Element
  const inputs = element.children.slice(2).map(label => label.children[0]!)
  const toggle = (index: number) => {
    const input = inputs[index]!
    input.checked = !input.checked
    input.onchange()
  }
  expect(picker.valid()).toBe(false)
  for (let i = 0; i < 4; i++) toggle(i)
  expect(changed).toEqual([false, true, true, false])
  expect(element.children[1]!.textContent).toContain('已选 4 人')
  toggle(3)
  expect(picker.read()).toEqual(selection.candidates.slice(0, 3).map(candidate => candidate.id))
  toggle(1)
  expect(picker.read()).toEqual(['character:Claude', 'character:GPT'])
  expect(picker.valid()).toBe(true)
})

it('submits the complete checked list from the stage and keeps the start gate in sync', () => {
  const group = new Element()
  const sent: unknown[] = []
  const context = {
    document,
    participantPicker: embeddedPicker(),
    send: (...args: unknown[]) => sent.push(args),
    controls: () => {
      for (const child of group.children) child.disabled = child.dataset.unavailable === 'true'
    },
    node: () => new Element(),
  }
  const source = DEFAULT_SCRIPT.slice(
    DEFAULT_SCRIPT.indexOf(' function appendAction('),
    DEFAULT_SCRIPT.indexOf('\n let inventoryKey='),
  )
  const append = runInNewContext(source + ';appendAction', context) as (group: Element, option: unknown) => void
  append(group, { id: 'undercover:start', label: '开始 谁是卧底', participantSelection: selection })
  context.controls()
  const button = group.children[1]!
  expect(button.disabled).toBe(true)
  for (const label of group.children[0]!.children.slice(2, 4)) {
    const input = label.children[0]!
    input.checked = true
    input.onchange()
  }
  expect(button.disabled).toBe(false)
  button.onclick()
  expect(sent).toEqual([
    ['perform', { optionId: 'undercover:start', npcIds: ['character:Claude', 'character:DeepSeek'] }],
  ])
  expect(() => new Function(DEFAULT_SCRIPT)).not.toThrow()
  for (const script of HOST_ACTIVITY_PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    expect(() => new Function(script[1]!)).not.toThrow()
  }
  expect(HOST_ACTIVITY_PAGE).toContain('const npcIds=picker.read()')
})

it.each([false, true])('keeps the host selection and start gate consistent when busy=%s', busy => {
  const group = new Element()
  const buttons: Element[] = []
  const sent: unknown[] = []
  const choice = { title: '谁是卧底', participantSelection: selection }
  const start = HOST_ACTIVITY_PAGE.indexOf('const selection=choice.participantSelection,disabled=')
  const source = HOST_ACTIVITY_PAGE.slice(start, HOST_ACTIVITY_PAGE.indexOf('}else add(', start))
  runInNewContext(source, {
    choice,
    state: { busy, paused: false },
    posting: false,
    blocked: false,
    participantPicker: embeddedPicker(),
    node: () => group,
    send: (...args: unknown[]) => sent.push(args),
    add: (_text: string, work: () => void, disabled: boolean) => {
      const button = new Element()
      button.onclick = work
      button.disabled = disabled
      buttons.push(button)
      return button
    },
  })
  const fieldset = group.children[0]!
  const button = buttons[0]!
  expect(button.disabled).toBe(true)
  for (const label of fieldset.children.slice(2, 4)) {
    const input = label.children[0]!
    input.checked = true
    input.onchange()
  }
  expect(fieldset.disabled).toBe(busy)
  expect(button.disabled).toBe(busy)
  if (!button.disabled) button.onclick()
  expect(sent).toEqual(busy ? [] : [['start', { npcIds: ['character:Claude', 'character:DeepSeek'] }, choice]])
})
