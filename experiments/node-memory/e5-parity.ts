/** Mandatory real-asset milestone, deliberately exits nonzero if assets/oracle/parity are unavailable. */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { createE5Worker } from '../../packages/memory-core/src/node/e5-client.ts'
const python = process.argv[2], assets = process.argv[3]
if (!python || !assets) throw new Error('Usage: node --import tsx experiments/node-memory/e5-parity.ts PYTHON ASSET_DIRECTORY')
const texts = ['我答应明天帮你修理收音机。', '她没有答应明天来。', '林岑（阿岑）把钥匙交给了夏遥。', 'character:lin 与 Lin 在门外。', '暴雨停了，窗台上留着水。', 'The key is on the table.', 'café e\u0301 ＡＢＣ ①', '👩🏽‍🔧修理零件🧰', '', '完整引用；保留否定、条件和不确定性。'.repeat(120), '钥匙', '我没有拿走那把钥匙。']
const client = createE5Worker(resolve(assets))
const report: object[] = []
const sides: { actual: number[][]; oracle: number[][] }[] = []
try {
  for (const query of [false, true]) {
    const input = { texts, query }
    const oracle = JSON.parse(execFileSync(resolve(python), ['experiments/node-memory/e5-oracle.py', resolve(assets)], {
      input: JSON.stringify(input), encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
    })) as { tokens: number[][]; vectors: number[][] }
    const actual = await client.encode(texts, query, new AbortController().signal)
    assert.deepEqual(actual.tokens, oracle.tokens, 'E5 token IDs must be exact, including truncated sequences')
    let error = 0
    for (let i = 0; i < texts.length; i++) {
      assert.equal(actual.vectors[i]!.length, 384)
      for (let d = 0; d < 384; d++) error = Math.max(error, Math.abs(actual.vectors[i]![d]! - oracle.vectors[i]![d]!))
    }
    assert.ok(error <= 2e-5, `Maximum coordinate error ${error} exceeds 2e-5; investigate, do not widen silently`)
    // Same full candidate ordering, not only the nearest one. Exclude the query's own document.
    const rank = (vectors: number[][], i: number) => vectors.map((v, j) => ({ j, score: v.reduce((sum, x, k) => sum + x * vectors[i]![k]!, 0) })).filter(r => r.j !== i).sort((a, b) => b.score - a.score || a.j - b.j).map(r => r.j)
    for (let i = 0; i < texts.length; i++) assert.deepEqual(rank(actual.vectors, i), rank(oracle.vectors, i))
    sides.push({actual: actual.vectors, oracle: oracle.vectors})
    report.push({ query, exactTokenIds: true, maximumCoordinateError: error, rankingEqual: true, inputs: texts.length })
  }
  // Actual retrieval is asymmetric: prefixed query against prefixed passages.
  const rankAcross = (q: number[], docs: number[][]) => docs.map((v, j) => ({j, score: v.reduce((sum, x, k) => sum + x * q[k]!, 0)})).sort((a,b) => b.score-a.score || a.j-b.j).map(row => row.j)
  for(let i=0;i<texts.length;i++) assert.deepEqual(rankAcross(sides[1]!.actual[i]!, sides[0]!.actual), rankAcross(sides[1]!.oracle[i]!, sides[0]!.oracle), 'query/passage candidate order differs')
  report.push({asymmetricQueryPassageRanking: true})
  await mkdir('.tmp/node-memory', { recursive: true })
  await writeFile('.tmp/node-memory/e5-parity.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally { await client.close() }
