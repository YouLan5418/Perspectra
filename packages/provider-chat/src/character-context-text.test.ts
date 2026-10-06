import { expect, it } from 'vitest'
import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import { compactCognition, characterRequestText } from './character-context-text.ts'
import { prototypeTurnCall } from './prototype-turn.ts'
function unpackTable(value: WorldJsonValue): WorldJsonObject[] {
  if (Array.isArray(value)) return value as WorldJsonObject[]
  const table = value as { common: WorldJsonObject; columns: string[]; rows: WorldJsonValue[][] }
  return table.rows.map(row => ({ ...table.common, ...Object.fromEntries(table.columns.map((key, i) => [key, row[i]!])) }))
}
function expand(compact: WorldJsonObject): WorldJsonObject {
  const sources = unpackTable(compact.sources!)
  const restore = (value: WorldJsonValue): WorldJsonValue => {
    if (Array.isArray(value)) return value.map(restore)
    if (value !== null && typeof value === 'object') {
      const object = value as WorldJsonObject
      if (Object.keys(object).length === 1 && typeof object.sourceIndex === 'number') return sources[object.sourceIndex]!
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, restore(v)]))
    }
    return value
  }
  return Object.fromEntries(Object.entries(compact).filter(([key]) => key !== 'sources').map(([key, value]) => {
    if (value !== null && !Array.isArray(value) && typeof value === 'object' && (value as WorldJsonObject).records !== undefined) {
      const group = value as WorldJsonObject
      const rows = unpackTable(group.records!), values = unpackTable(group.values!)
      return [key, rows.map((row, i) => restore({ ...row, value: values[i]! }))]
    }
    return [key, restore(value)]
  }))
}
const source = { sourceKind: 'reported_speech', sourceId: 'event:private', sourceHash: 'sha256:' + 'a'.repeat(64) }
const cognition: WorldJsonObject = { characterId: 'character:a', address: { worldId: 'world:a' }, asOfWorldSeq: 20,
  bundleHash: 'sha256:' + 'b'.repeat(64),
  claims: Array.from({ length: 5 }, (_, i) => ({ kind: 'subjective-claim', characterId: 'character:a', id: `claim:${i}`,
    validFromSeq: i + 1, validToSeq: null, sourceRef: source,
    value: { proposition: { text: `未经核实的说法${i}` }, stance: 'suspected', confidencePermille: 600,
      basisRefs: [source], source, awareness: 'conscious', status: 'active' } })),
  goals: [], affects: [], innerTensions: [], relationships: [], commitments: [], openLoops: [] }
it('preserves every cognition value, ID, scope and evidence reference when factoring repeated structure', () => {
  const before = JSON.stringify(cognition)
  const compact = compactCognition(cognition)
  expect(expand(compact)).toEqual(cognition)
  expect(JSON.stringify(compact).length).toBeLessThan(before.length * 0.7)
  expect(JSON.stringify(cognition)).toBe(before)
  expect(JSON.stringify(compact)).toContain('未经核实的说法')
})
it('compresses only the rendered cognition, keeping host context and other role-visible material intact', () => {
  const request = { context: { cognition, character: { characterId: 'character:a' },
    observations: [{ text: '本人已观察到的内容。' }], memories: [{ text: '可修正认识。' }] }, continuation: false }
  const original = JSON.stringify(request)
  const rendered = JSON.parse(prototypeTurnCall(request).messages.at(-1)!.content)
  expect(expand(rendered.context.cognition)).toEqual(cognition)
  expect(rendered.context.observations).toEqual(request.context.observations)
  expect(rendered.context.memories).toEqual(request.context.memories)
  expect(JSON.stringify(request)).toBe(original)
  expect(characterRequestText({ context: { observations: [] } })).toBe(JSON.stringify({ context: { observations: [] } }))
})
it('preserves optional fields and nulls in heterogeneous records', () => {
  const variant = { ...cognition, claims: [{ ...((cognition.claims as WorldJsonObject[])[0]!),
    value: { source, stance: 'doubted', extra: null } }, (cognition.claims as WorldJsonObject[])[1]!] }
  expect(expand(compactCognition(variant))).toEqual(variant)
})
