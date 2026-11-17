/** Node port of python/core/vendor/hindsight_api/engine/onnx_slices.py.
 * Hindsight MIT attribution: ../../python/core/vendor/LICENSE. Not yet selected by the provider.
 * Assets are local, frozen and verified before tokenizer/native session initialization. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'
import * as ort from 'onnxruntime-node'

export const E5_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
export const E5_MAX_TOKENS = 256
export const E5_BATCH_SIZE = 8
const ASSETS = {
  'config.json': 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
  'sentencepiece.bpe.model': 'cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865',
  'special_tokens_map.json': 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7',
  'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
  'tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
  'onnx/model_quantized.onnx': 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
} as const

/** Return verified bytes, so the session does not reopen an unchecked replacement. No download fallback. */
async function assets(directory: string) {
  const verified = new Map<string, Buffer>()
  for (const [name, hash] of Object.entries(ASSETS)) {
    const bytes = await readFile(join(directory, name))
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('E5 asset hash mismatch: ' + name)
    verified.set(name, bytes)
  }
  return verified
}

/** Python len() counts Unicode code points, not UTF-16 code units. Stable ties preserve input order. */
export function e5Batches(texts: readonly string[]): number[][] {
  const order = texts.map((_, i) => i)
  if (texts.length > E5_BATCH_SIZE) order.sort((a, b) => [...texts[b]!].length - [...texts[a]!].length)
  const windows: number[][] = []
  for (let i = 0; i < order.length; i += E5_BATCH_SIZE) windows.push(order.slice(i, i + E5_BATCH_SIZE))
  return windows
}

/** Masked mean + L2 normalization. Explicit float32 steps mirror numpy's encoder storage semantics. */
export function meanNormalize(hidden: Float32Array, mask: readonly number[], rows: number, width: number): number[] {
  if (mask.length !== rows || hidden.length !== rows * width || width !== 384)
    throw new Error('Unexpected E5 output shape')
  const out = new Float32Array(width)
  let count = 0
  for (let row = 0; row < rows; row++) {
    if (mask[row] !== 0 && mask[row] !== 1) throw new Error('Invalid E5 attention mask')
    count += mask[row]!
    for (let col = 0; col < width; col++) {
      const value = hidden[row * width + col]!
      if (!Number.isFinite(value)) throw new Error('Non-finite E5 output')
      out[col] = Math.fround(out[col]! + Math.fround(value * mask[row]!))
    }
  }
  for (let col = 0; col < width; col++) out[col] = Math.fround(out[col]! / Math.max(count, 1e-9))
  // Numpy's reduction may use SIMD/pairwise accumulation; parity tool measures the resulting error.
  let squared = 0
  for (const value of out) squared += Math.fround(value * value)
  const norm = Math.fround(Math.sqrt(Math.fround(squared))) || 1
  return Array.from(out, value => Math.fround(value / norm))
}

export class NodeE5 {
  private readonly tokenizer: Tokenizer
  private readonly session: ort.InferenceSession
  private constructor(tokenizer: Tokenizer, session: ort.InferenceSession) {
    this.tokenizer = tokenizer
    this.session = session
  }

  static async open(directory: string): Promise<NodeE5> {
    const files = await assets(directory)
    const tokenizer = new Tokenizer(
      JSON.parse(files.get('tokenizer.json')!.toString()),
      JSON.parse(files.get('tokenizer_config.json')!.toString()),
    )
    if (
      tokenizer.token_to_id('<s>') !== 0 ||
      tokenizer.token_to_id('</s>') !== 2 ||
      tokenizer.token_to_id('<pad>') !== 1
    )
      throw new Error('Frozen E5 special tokens differ')
    const session = await ort.InferenceSession.create(files.get('onnx/model_quantized.onnx')!, {
      executionProviders: ['cpu'],
      enableCpuMemArena: false,
    })
    return new NodeE5(tokenizer, session)
  }

  tokens(text: string, query = false, truncate = true): number[] {
    const encoded = this.tokenizer.encode((query ? 'query: ' : 'passage: ') + text).ids
    // Frozen XLM-R uses one leading <s> and one trailing </s>. Truncate content before the final token.
    if (encoded[0] !== 0 || encoded.at(-1) !== 2) throw new Error('Frozen E5 sequence framing differs')
    return truncate && encoded.length > E5_MAX_TOKENS ? [...encoded.slice(0, E5_MAX_TOKENS - 1), 2] : encoded
  }

  async encode(texts: readonly string[], query = false): Promise<number[][]> {
    const vectors: number[][] = Array.from({ length: texts.length }, () => [])
    for (const order of e5Batches(texts)) {
      const ids = order.map(i => this.tokens(texts[i]!, query))
      const length = Math.max(...ids.map(row => row.length))
      const padded = ids.map(row => [...row, ...Array<number>(length - row.length).fill(1)])
      const masks = ids.map(row => [...row.map(() => 1), ...Array<number>(length - row.length).fill(0)])
      const dims = [ids.length, length]
      const feeds: Record<string, ort.Tensor> = {
        input_ids: new ort.Tensor('int64', BigInt64Array.from(padded.flat(), BigInt), dims),
        attention_mask: new ort.Tensor('int64', BigInt64Array.from(masks.flat(), BigInt), dims),
      }
      if (this.session.inputNames.includes('token_type_ids'))
        feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(ids.length * length), dims)
      let result: ort.InferenceSession.ReturnType = {}
      try {
        result = await this.session.run(feeds)
        const tensor = result[this.session.outputNames[0]!]!
        if (
          tensor.type !== 'float32' ||
          tensor.dims.length !== 3 ||
          tensor.dims[0] !== ids.length ||
          tensor.dims[1] !== length ||
          tensor.dims[2] !== 384
        )
          throw new Error('Frozen E5 model output differs')
        const hidden = tensor.data as Float32Array
        for (let i = 0; i < order.length; i++)
          vectors[order[i]!] = meanNormalize(
            hidden.subarray(i * length * 384, (i + 1) * length * 384),
            masks[i]!,
            length,
            384,
          )
      } finally {
        for (const tensor of Object.values(result)) tensor.dispose()
        for (const tensor of Object.values(feeds)) tensor.dispose()
      }
    }
    return vectors
  }
  async close() {
    await this.session.release()
  }
}
