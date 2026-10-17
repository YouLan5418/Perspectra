import { expect, it } from 'vitest'
import { modelsDraft, draftModels } from './model-choices.ts'
const a = '6f1c2a4e-1d0b-4c39-9a51-0d6c1b7e2f10', b = '7a2d3b5f-2e1c-4d4a-8b62-1e7d2c8f3a21'
const characters = ['character:companion', 'character:friend']

it('opens an instance with one override and saves it back unchanged', () => {
  const models = { decision: { connectionId: a, model: 'base', thinkingLevel: 'low' as const }, characters: {
    'character:companion': { decision: { connectionId: b, model: 'strong', thinkingLevel: 'high' as const }, memory: { connectionId: a, model: 'cheap' } } } }
  const draft = modelsDraft(models, characters)
  expect(draft.memoryFollows).toBe(true)
  expect(draft.characters['character:friend']!.override).toBe(false)
  expect(draft.characters['character:companion']).toMatchObject({ override: true, thinkingLevel: 'high', memoryFollows: false, memory: { connectionId: a, model: 'cheap' } })
  expect(draftModels(draft)).toEqual(models)
})

it('drops followed layers, trims models, forgets characters no longer in the pack and rejects incomplete choices', () => {
  const draft = modelsDraft({ decision: { connectionId: a, model: 'base' }, memory: { connectionId: b, model: 'old' },
    characters: { 'character:gone': { decision: { connectionId: b, model: 'x' } } } }, characters)
  expect(Object.keys(draft.characters)).toEqual(characters)
  draft.memoryFollows = true
  draft.characters['character:friend'] = { ...draft.characters['character:friend']!, override: true, decision: { connectionId: b, model: ' quick ' } }
  expect(draftModels(draft)).toEqual({ decision: { connectionId: a, model: 'base', thinkingLevel: 'off' },
    characters: { 'character:friend': { decision: { connectionId: b, model: 'quick', thinkingLevel: 'off' } } } })
  draft.characters['character:friend']!.decision = { connectionId: b, model: ' ' }
  expect(draftModels(draft)).toBeUndefined()
  draft.characters['character:friend']!.override = false
  draft.memoryFollows = false; delete draft.memory
  expect(draftModels(draft)).toBeUndefined()
  expect(draftModels(modelsDraft(undefined, characters))).toBeUndefined()
})
