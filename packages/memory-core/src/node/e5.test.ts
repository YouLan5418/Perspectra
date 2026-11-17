import { expect, it, vi } from 'vitest'
import { Tensor } from 'onnxruntime-node'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { e5Batches, meanNormalize, NodeE5, E5_REVISION } from './e5.ts'
import { createE5Worker } from './e5-client.ts'

it('keeps the frozen E5 identity and Python code-point batching, including stable ties', async () => {
  const manifest = JSON.parse(await readFile('packages/memory-core/python/core/e5-assets.json', 'utf8'))
  expect(E5_REVISION).toBe(manifest.revision)
  expect(e5Batches(['a', 'bbb'])).toEqual([[0, 1]])
  expect(e5Batches(['😀', '中', 'abc', 'def', '', 'x', 'y', 'z', '12345'])).toEqual([[8, 2, 3, 0, 1, 5, 6, 7], [4]])
})
it('masks padding before normalization and refuses malformed native results', () => {
  const hidden = new Float32Array(384 * 2)
  hidden[0] = 3
  hidden[1] = 4
  hidden.fill(100, 384)
  expect(meanNormalize(hidden, [1, 0], 2, 384).slice(0, 2)).toEqual([Math.fround(0.6), Math.fround(0.8)])
  expect(() => meanNormalize(hidden, [2, 0], 2, 384)).toThrow('mask')
  hidden[0] = NaN
  expect(() => meanNormalize(hidden, [1, 0], 2, 384)).toThrow('Non-finite')
})
it('fails closed on changed local assets before any inference or remote fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e5-invalid-'))
  try {
    await writeFile(join(dir, 'config.json'), '{}')
    await expect(NodeE5.open(dir)).rejects.toThrow('hash mismatch')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('runs in a Node worker and rejects missing assets without exposing paths; closes idempotently', async () => {
  const client = createE5Worker('/nonexistent/private-asset-location')
  try {
    await expect(client.encode(['私密文字'], false, new AbortController().signal)).rejects.toThrow(
      'Local E5 request failed',
    )
  } finally {
    await client.close()
    await client.close()
  }
  await expect(client.encode([], false, new AbortController().signal)).rejects.toThrow('cancelled')
})
it('does not start an already cancelled CPU request', async () => {
  const client = createE5Worker('/unavailable')
  const abort = new AbortController()
  abort.abort()
  await expect(client.encode(['abc'], false, abort.signal)).rejects.toThrow('cancelled')
  await client.close()
})

it('rejects concurrent work and terminates running CPU work on abort', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e5-cancel-'))
  // Protocol/lifecycle fixture, deliberately not an E5 inference or parity substitute.
  const entry = join(dir, 'busy.mjs')
  await writeFile(entry, "import {parentPort} from 'node:worker_threads';parentPort.on('message',()=>{while(true){}})")
  const { pathToFileURL } = await import('node:url')
  const client = createE5Worker('/unused', pathToFileURL(entry))
  try {
    const abort = new AbortController()
    const pending = client.encode(['abc'], false, abort.signal)
    const rejected = expect(pending).rejects.toThrow('closed')
    await expect(client.encode(['def'], false, new AbortController().signal)).rejects.toThrow('busy')
    await new Promise(done => setTimeout(done, 100))
    abort.abort()
    await rejected
    await client.close()
  } finally {
    await client.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 5000)

it('disposes native input tensors when inference rejects', async () => {
  const dispose = vi.spyOn(Tensor.prototype, 'dispose')
  const encoder = Reflect.construct(NodeE5, [
    { encode: () => ({ ids: [0, 42, 2] }) },
    {
      inputNames: ['input_ids', 'attention_mask'],
      run: async () => {
        throw new Error('native inference rejected')
      },
    },
  ]) as NodeE5
  try {
    await expect(encoder.encode(['test'])).rejects.toThrow('native inference rejected')
    expect(dispose).toHaveBeenCalledTimes(2)
  } finally {
    dispose.mockRestore()
  }
})
