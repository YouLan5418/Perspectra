import { expect, it } from 'vitest'
import { parseExpressionSegments } from '@harness-world/contracts'
import { characterTurnCall } from '@harness-world/provider-chat'
import { gatewayTurnCall } from '../../desktop/host/gateway-turn-call.ts'

const context = (extra: object = {}) => ({
  character: { characterId: 'character:claude' },
  scene: { people: [{ characterId: 'character:claude' }, { characterId: 'character:player' }] },
  affordances: [],
  ...extra,
})

it('keeps an expression on a segment as presentation and refuses names that are not plain identifiers', () => {
  expect(parseExpressionSegments([{ type: 'speech', text: '嗯。', expression: 'smile' }])).toEqual([
    { type: 'speech', text: '嗯。', expression: 'smile' },
  ])
  expect(parseExpressionSegments([{ type: 'narration', text: '她笑了笑。' }])).toEqual([
    { type: 'narration', text: '她笑了笑。' },
  ])
  expect(() => parseExpressionSegments([{ type: 'speech', text: '嗯。', expression: 'Smile Big' }])).toThrow()
  expect(() => parseExpressionSegments([{ type: 'speech', text: '嗯。', mood: 'smile' }])).toThrow()
})

it('offers expressions to a character only when its pack declares some', () => {
  for (const call of [characterTurnCall, gatewayTurnCall]) {
    const plain = call({ context: context(), continuation: false })
    expect(JSON.stringify(plain.schema)).not.toContain('expression"')
    expect(plain.messages[0]!.content).not.toContain('expression')
    const dressed = call({ context: context({ expressions: ['smile', 'shy'] }), continuation: false })
    expect(JSON.stringify(dressed.schema)).toContain('"expression":{"type":"string","enum":["smile","shy"]}')
  }
  expect(
    characterTurnCall({ context: context({ expressions: ['smile', 'shy'] }), continuation: false }).messages[0]!
      .content,
  ).toContain('从 smile、shy 中选')
})
