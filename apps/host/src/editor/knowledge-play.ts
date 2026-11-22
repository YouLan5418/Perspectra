import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isJsonObject } from '@perspectra/sdk/contracts'
import { acceptsVariableValue, type Scalar } from '@perspectra/world-pack/editor-fields'
import { LensSimulation } from '../simulation/simulation.ts'
import { buildSource, assertStep } from './export.ts'
import { knowledgeBook, compiledText } from './knowledge.ts'

/** Compare actual sends after the same player utterance, using a new game for each starting value. */
export async function playKnowledge(source: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const text = body.text
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new TypeError('请输入 1–2000 字的试玩发言')
  const root = realpathSync(source),
    stage = mkdtempSync(join(tmpdir(), 'perspectra-knowledge-preview-'))
  try {
    await buildSource(root, stage)
    const book = knowledgeBook(stage),
      row = book.rows.find(r => r.documentId === body.documentId)
    if (!row || (body.expected !== undefined && !isDeepStrictEqual(row, body.expected)))
      throw new TypeError('条目已改变，请重新载入后试玩')
    const variable = book.candidates.variables.find(v => v.key === body.variable)
    let values: (Scalar | null)[] = [null]
    if (body.variable !== undefined || body.values !== undefined) {
      if (
        !variable ||
        !Array.isArray(body.values) ||
        body.values.length !== 2 ||
        !body.values.every(v => acceptsVariableValue(variable, v)) ||
        body.values[0] === body.values[1]
      )
        throw new TypeError('请选择一个包级变量和两个不同的有效起点值')
      values = body.values as Scalar[]
    }
    const expectedContent = compiledText(row.text)
    const trials = []
    for (const value of values) {
      signal?.throwIfAborted()
      const sim = await LensSimulation.open(
        stage,
        variable && value !== null ? { status: { public: { [variable.key]: value } } } : {},
      )
      try {
        const step = await sim.step({ kind: 'say', text })
        assertStep(step)
        signal?.throwIfAborted()
        const calls = step.modelInputs ?? []
        const actors = book.candidates.readers
          .filter(r => r.scripted || calls.some(c => c.characterId === r.id))
          .map(r => ({
            id: r.id,
            name: r.name,
            requests: calls
              .filter(call => call.characterId === r.id)
              .map(({ input }) => {
                const knowledge = isJsonObject(input.context) ? input.context.knowledge : undefined
                const entries = isJsonObject(knowledge) && Array.isArray(knowledge.entries) ? knowledge.entries : []
                return {
                  received: entries.some(
                    entry =>
                      isJsonObject(entry) && entry.documentId === row.documentId && entry.content === expectedContent,
                  ),
                }
              }),
          }))
        trials.push({ value, actors })
      } finally {
        await sim.close()
      }
    }
    return { documentId: row.documentId, variable: variable?.key ?? null, text, trials }
  } finally {
    rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}
