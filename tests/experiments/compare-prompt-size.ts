/**
 * Read-only comparison of the three prompt projections over one recorded Context.
 *
 * `full` is the Context as assembled, `compact` is what the playtest currently sends, and `lean` is the
 * per-segment projection that keeps only what a character can act on. Only the third one is a proposal;
 * nothing here changes a production path.
 *
 * Usage: node --import tsx tests/experiments/compare-prompt-size.ts <directory with final-context.json>
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { renderExperiment, type ExperimentMessage } from './compact-context.ts'
import { renderLeanContext } from './lean-context.ts'
import { estimateCostCny, estimateTokens } from './context-cost.ts'

const [directoryArgument] = process.argv.slice(2)
if (!directoryArgument) throw new Error('usage: compare-prompt-size <directory with final-context.json>')
const directory = resolve(directoryArgument)

interface RecordedMessage {
  readonly role: string
  readonly content: string
}

const messages = (JSON.parse(readFileSync(join(directory, 'final-context.json'), 'utf8')) as RecordedMessage[])
  .map(message => ({ role: message.role as ExperimentMessage['role'], content: message.content }))

const size = (values: readonly { readonly content: string }[]) =>
  values.reduce((sum, value) => sum + Buffer.byteLength(value.content), 0)
const tokens = (values: readonly { readonly content: string }[]) =>
  values.reduce((sum, value) => sum + estimateTokens(value.content), 0)

const full = renderExperiment(messages, 'full').messages
const compact = renderExperiment(messages, 'compact').messages
const lean = renderLeanContext(messages).messages

const names = ['host_protocol', 'controller_contract', ...renderExperiment(messages, 'compact').sizes
  .map(entry => entry.segment).slice(2)]
const bytes = (values: readonly { readonly content: string }[], index: number) =>
  Buffer.byteLength(values[index]!.content)

const rows = messages.map((_, index) => ({
  segment: names[index] ?? `message:${index}`,
  full: bytes(full, index),
  compact: bytes(compact, index),
  lean: bytes(lean, index),
}))

const width = Math.max(...rows.map(row => row.segment.length), 'segment'.length)
const pad = (value: string, length: number) => value.padEnd(length)

process.stdout.write(`${pad('segment', width)}${'full'.padStart(8)}${'compact'.padStart(9)}${'lean'.padStart(8)}\n`)
for (const row of rows) {
  process.stdout.write(`${pad(row.segment, width)}${row.full.toString().padStart(8)}${row.compact.toString().padStart(9)}${row.lean.toString().padStart(8)}\n`)
}
process.stdout.write(`${pad('TOTAL', width)}${size(full).toString().padStart(8)}${size(compact).toString().padStart(9)}${size(lean).toString().padStart(8)}\n`)

const calls = 8
const report = (label: string, values: readonly { readonly content: string }[]) => {
  const totalTokens = tokens(values)
  const cost = estimateCostCny({ missedTokens: totalTokens, cachedTokens: 0, outputTokens: 0 })
  process.stdout.write(`${label.padEnd(26)} tokens ${totalTokens.toString().padStart(6)}  one action (${calls} calls) ${(cost * calls).toFixed(4)} CNY  off-peak ${(cost * calls * 0.5).toFixed(4)} CNY\n`)
  return totalTokens
}
const fullTokens = report('full (as assembled)', full)
report('compact (playtest today)', compact)
const leanTokens = report('lean (proposal)', lean)
process.stdout.write(`\nlean keeps ${((leanTokens / fullTokens) * 100).toFixed(1)}% of the assembled tokens.\n`)
