import { describe, expect, it } from 'vitest'
import { DeterministicInvestigationIntentParser, type InvestigationIntentCatalog } from './investigation-intent.ts'

function catalog(): InvestigationIntentCatalog {
  return {
    characters: [
      { id: 'character:bob', aliases: ['Bob', '鲍勃'] },
      { id: 'character:detective', aliases: ['侦探', 'Detective'] },
    ],
    entities: [
      { id: 'entity:desk', aliases: ['书桌', 'desk'] },
      { id: 'entity:key', aliases: ['钥匙', 'key'] },
    ],
    evidence: [
      { id: 'evidence:key-moved', aliases: ['钥匙痕迹', '线索'] },
      { id: 'evidence:dust', aliases: ['灰尘痕迹', '线索'] },
    ],
  }
}

describe('DeterministicInvestigationIntentParser', () => {
  it('validates its stable alias catalog', () => {
    expect(() => new DeterministicInvestigationIntentParser({
      ...catalog(), characters: [{ id: 'character:bob', aliases: ['Bob'] }, { id: 'character:bob', aliases: ['鲍勃'] }],
    })).toThrow('unique')
    expect(() => new DeterministicInvestigationIntentParser({
      ...catalog(), characters: [{ id: 'character:bob', aliases: [] }],
    })).toThrow('at least one alias')
    expect(() => new DeterministicInvestigationIntentParser({
      ...catalog(), characters: [{ id: ' padded ', aliases: ['Bob'] }],
    })).toThrow('unpadded')
    expect(() => new DeterministicInvestigationIntentParser({
      ...catalog(), characters: [{ id: 'character:bob', aliases: [' padded '] }],
    })).toThrow('unpadded')
  })

  it('parses explicit commands and compact Chinese investigation intents', () => {
    const parser = new DeterministicInvestigationIntentParser(catalog())
    expect(parser.parse('/speak hello world')).toEqual({
      status: 'resolved', action: { actionType: 'speak', parameters: { text: 'hello world' } },
    })
    expect(parser.parse('说 我们开始吧')).toMatchObject({ status: 'resolved', action: { actionType: 'speak' } })
    expect(parser.parse('检查一下书桌')).toEqual({
      status: 'resolved', action: { actionType: 'inspect', parameters: { entityId: 'entity:desk' } },
    })
    expect(parser.parse('/inspect KEY')).toMatchObject({
      status: 'resolved', action: { parameters: { entityId: 'entity:key' } },
    })
    expect(parser.parse('询问鲍勃关于钥匙')).toEqual({
      status: 'resolved',
      action: { actionType: 'ask', parameters: { targetCharacterId: 'character:bob', topicId: 'entity:key' } },
    })
    expect(parser.parse('/ask Detective key')).toMatchObject({
      status: 'resolved', action: { parameters: { targetCharacterId: 'character:detective', topicId: 'entity:key' } },
    })
    expect(parser.parse('向侦探出示钥匙痕迹')).toEqual({
      status: 'resolved',
      action: {
        actionType: 'present_evidence',
        parameters: { evidenceId: 'evidence:key-moved', targetCharacterId: 'character:detective' },
      },
    })
    expect(parser.parse('/present evidence:key-moved Bob')).toMatchObject({
      status: 'resolved', action: { parameters: { targetCharacterId: 'character:bob' } },
    })
    expect(parser.parse('指控鲍勃：钥匙痕迹')).toEqual({
      status: 'resolved',
      action: { actionType: 'accuse', parameters: { suspectId: 'character:bob', evidenceIds: ['evidence:key-moved'] } },
    })
    expect(parser.parse('/accuse Bob evidence:key-moved evidence:dust')).toMatchObject({
      status: 'resolved', action: { parameters: { evidenceIds: ['evidence:key-moved', 'evidence:dust'] } },
    })
  })

  it('requires clarification instead of guessing unknown, ambiguous, or malformed intents', () => {
    const parser = new DeterministicInvestigationIntentParser(catalog())
    expect(() => parser.parse(' padded ')).toThrow('unpadded')
    for (const input of ['/speak', '/inspect', '/inspect desk key', '/ask Bob', '/present evidence:key-moved', '/accuse Bob']) {
      expect(parser.parse(input)).toMatchObject({ status: 'clarification_required' })
    }
    expect(parser.parse('/inspect cabinet')).toMatchObject({
      status: 'clarification_required', reason: 'inspection target is unknown', candidates: ['entity:desk', 'entity:key'],
    })
    expect(parser.parse('/ask Alice key')).toMatchObject({ status: 'clarification_required', reason: 'question target is unknown' })
    expect(parser.parse('/ask Bob missing')).toMatchObject({ status: 'clarification_required', reason: 'question topic is unknown' })
    expect(parser.parse('/present missing Bob')).toMatchObject({ status: 'clarification_required', reason: 'evidence is unknown' })
    expect(parser.parse('/present evidence:key-moved Alice')).toMatchObject({ status: 'clarification_required', reason: 'evidence target is unknown' })
    expect(parser.parse('/accuse Alice evidence:key-moved')).toMatchObject({ status: 'clarification_required', reason: 'suspect is unknown' })
    expect(parser.parse('/accuse Bob missing')).toMatchObject({ status: 'clarification_required', reason: 'evidence is unknown' })
    expect(parser.parse('/accuse Bob evidence:key-moved evidence:key-moved')).toMatchObject({
      status: 'clarification_required', reason: 'accuse evidence must be unique',
    })
    expect(parser.parse('/present 线索 Bob')).toMatchObject({
      status: 'clarification_required', reason: 'evidence is ambiguous',
      candidates: ['evidence:dust', 'evidence:key-moved'],
    })
    expect(parser.parse('跳舞')).toEqual({
      status: 'clarification_required', reason: 'unsupported player intent',
      candidates: ['accuse', 'ask', 'inspect', 'present_evidence', 'speak'],
    })
  })

  it('filters evidence aliases and clarification candidates through durable view authorization', () => {
    const parser = new DeterministicInvestigationIntentParser(catalog())
    expect(parser.parse('/present 线索 Bob', { evidenceIds: [] })).toMatchObject({
      status: 'clarification_required', reason: 'evidence is unknown', candidates: [],
    })
    expect(parser.parse('/present 线索 Bob', { evidenceIds: ['evidence:key-moved'] })).toMatchObject({
      status: 'resolved', action: { parameters: { evidenceId: 'evidence:key-moved' } },
    })
    expect(() => parser.parse('/present 线索 Bob', {
      evidenceIds: ['evidence:key-moved', 'evidence:key-moved'],
    })).toThrow('unique')
    expect(() => parser.parse('/present 线索 Bob', { evidenceIds: ['evidence:future'] })).toThrow('absent')
  })
})
