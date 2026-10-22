import { expect, it } from 'vitest'
import type { WorldJsonObject } from '@harness-world/contracts'
import { characterRequestText } from './character-context-text.ts'
import { characterActionExplanations } from './character-action-explanations.ts'

it('renders offered moves and item transfers without adding targets or changing authority parameters', () => {
  // A pack's own hand-over: the model reads the author's name for it, with the item's current look.
  const option = {
    label: '把材料交给',
    targetRef: { kind: 'entity', id: 'entity:kit' },
    bindingId: 'status',
    definitionRef: { id: 'status:give', version: 1 },
    arguments: {},
  }
  const context: WorldJsonObject = {
    scene: { name: '档案室', people: [{ characterId: 'character:patient', name: '伊蕾' }] },
    items: {
      current: [{ entityId: 'entity:kit', kind: '封装材料' }],
      lastObserved: [{ entityId: 'entity:hidden', kind: '私密备用物品' }],
    },
    affordances: [
      { actionType: 'move', destinations: [{ locationId: 'location:inn', name: '旅馆' }] },
      { actionType: 'interact', interactions: [option] },
    ],
  }
  const before = JSON.stringify(context),
    options = characterActionExplanations(context)
  expect(options).toHaveLength(2)
  expect(options[0]).toMatchObject({
    meaning: '前往旅馆',
    operation: { decision: 'perform', actionType: 'move', parameters: { locationId: 'location:inn' } },
  })
  expect(options[0]!.description).toContain('离开档案室')
  expect(options[0]!.description).toContain('成功后')
  expect(options[1]).toMatchObject({
    meaning: '把材料交给：封装材料',
    operation: {
      decision: 'perform',
      actionType: 'interact',
      parameters: {
        targetRef: option.targetRef,
        bindingId: 'status',
        definitionRef: option.definitionRef,
        arguments: {},
      },
    },
  })
  expect(JSON.stringify(options)).not.toContain('私密备用物品')
  expect(JSON.stringify(context)).toBe(before)
  expect(JSON.parse(characterRequestText({ context, canPerform: true })).context.actionExplanations).toEqual(options)
  expect(JSON.parse(characterRequestText({ context, canPerform: false })).context.actionExplanations).toBeUndefined()
  expect(JSON.parse(characterRequestText({ context, continuation: true })).context.actionExplanations).toBeUndefined()
})

it('never infers an effect for custom or changed-version definitions or items with no offered operation', () => {
  const context: WorldJsonObject = {
    items: { current: [{ entityId: 'entity:visible-only', kind: '看得到但没有操作的物品' }] },
    affordances: [
      {
        actionType: 'interact',
        interactions: [
          {
            targetRef: { kind: 'entity', id: 'entity:target' },
            bindingId: 'custom',
            definitionRef: { id: 'author:heal', version: 1 },
            arguments: {},
            argumentSchema: { required: ['text'] },
          },
          {
            targetRef: { kind: 'entity', id: 'entity:target' },
            bindingId: 'changed',
            definitionRef: { id: 'base:take', version: 2 },
            arguments: {},
          },
        ],
      },
    ],
  }
  const options = characterActionExplanations(context)
  expect(options).toHaveLength(2)
  expect(options[0]!.description).toContain('具体效果以该定义')
  expect(options[0]!.argumentSchema).toEqual({ required: ['text'] })
  expect(options[1]!.meaning).toBe('请求交互 base:take（entity:target）')
  expect(JSON.stringify(options)).not.toContain('纳入你保管')
  expect(JSON.stringify(options)).not.toContain('看得到但没有操作')
})
