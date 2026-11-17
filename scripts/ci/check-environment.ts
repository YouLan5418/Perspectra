import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { coreAssetDirectory } from '../../packages/memory-core/src/node-paths.ts'
import { NodeE5 } from '../../packages/memory-core/src/node/e5.ts'

// Fail in environment setup, before a long suite, if native dependencies or
// frozen assets are unavailable. This performs real CPU inference without an LLM.
const database = new DatabaseSync(':memory:')
try {
  assert.equal(database.prepare('SELECT 1 AS ready').get()?.ready, 1)
} finally {
  database.close()
}

const encoder = await NodeE5.open(coreAssetDirectory())
try {
  const vectors = await encoder.encode(['CI 本机记忆环境检查'])
  assert.equal(vectors.length, 1)
  assert.equal(vectors[0]?.length, 384)
  assert(vectors[0].every(Number.isFinite))
  console.log(JSON.stringify({ node: process.version, sqlite: 'ready', e5: 'CPU', dimensions: 384 }))
} finally {
  await encoder.close()
}
