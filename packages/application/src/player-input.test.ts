import { describe, expect, it } from 'vitest'
import type { ActionAffordance } from '@harness-world/kernel'
import { PlayerInputInterpreter } from './player-input.ts'

const afforded: readonly ActionAffordance[] = [
  { actionType: 'speak', actionVersion: 1 },
  { actionType: 'move', actionVersion: 1 },
  { actionType: 'take', actionVersion: 1 },
  { actionType: 'wave', actionVersion: 2 },
  { actionType: 'speak', actionVersion: 1 },
]

describe('PlayerInputInterpreter', () => {
  it('maps ordinary text and generic commands to candidate Actions', () => {
    const interpreter = new PlayerInputInterpreter()
    expect(interpreter.interpret('大家晚上好。', afforded)).toEqual({
      status: 'resolved', action: { actionType: 'speak', parameters: { text: '大家晚上好。' } },
    })
    expect(interpreter.interpret('/move location:hall', afforded)).toEqual({
      status: 'resolved', action: { actionType: 'move', parameters: { locationId: 'location:hall' } },
    })
    expect(interpreter.interpret('/take entity:glass', afforded)).toEqual({
      status: 'resolved', action: { actionType: 'take', parameters: { entityId: 'entity:glass' } },
    })
    expect(interpreter.interpret('/act wave {"to":"character:bob"}', afforded)).toEqual({
      status: 'resolved', action: { actionType: 'wave', parameters: { to: 'character:bob' } },
    })
  })

  it('clarifies malformed, unknown, and unaffordable commands without guessing', () => {
    const interpreter = new PlayerInputInterpreter()
    for (const text of ['/move', '/move location:a location:b']) {
      expect(interpreter.interpret(text, afforded)).toMatchObject({
        status: 'clarification_required', reason: 'move requires exactly one locationId',
      })
    }
    for (const text of ['/take', '/take entity:a entity:b']) {
      expect(interpreter.interpret(text, afforded)).toMatchObject({
        status: 'clarification_required', reason: 'take requires exactly one entityId',
      })
    }
    expect(interpreter.interpret('/act', afforded)).toMatchObject({
      status: 'clarification_required', reason: 'act requires an actionType and canonical JSON parameters',
    })
    expect(interpreter.interpret('/act wave nope', afforded)).toEqual({
      status: 'clarification_required', reason: 'act parameters must be valid World JSON', candidates: ['wave'],
    })
    expect(interpreter.interpret('/act wave {"amount":1.5}', afforded)).toMatchObject({
      status: 'clarification_required', reason: 'act parameters must be valid World JSON',
    })
    expect(interpreter.interpret('/act dance {}', afforded)).toMatchObject({
      status: 'clarification_required', reason: 'action is not currently afforded',
    })
    expect(interpreter.interpret('/unknown', afforded)).toEqual({
      status: 'clarification_required', reason: 'unknown player command',
      candidates: ['move', 'speak', 'take', 'wave'],
    })
    expect(interpreter.interpret('hello', [])).toEqual({
      status: 'clarification_required', reason: 'action is not currently afforded', candidates: [],
    })
  })

  it('fails closed on malformed text or affordance contracts', () => {
    const interpreter = new PlayerInputInterpreter()
    expect(() => interpreter.interpret(' padded ', afforded)).toThrow('unpadded')
    expect(() => interpreter.interpret('hello', [{ actionType: ' bad ', actionVersion: 1 }])).toThrow('unpadded')
    expect(() => interpreter.interpret('hello', [{ actionType: 'speak', actionVersion: 0 }])).toThrow('positive safe integer')
    expect(() => interpreter.interpret('hello', [{ actionType: 'speak', actionVersion: 1.5 }])).toThrow('positive safe integer')
  })
})
