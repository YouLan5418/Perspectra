import { expect, it, vi } from 'vitest'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createE5WorkerMock } = vi.hoisted(() => ({ createE5WorkerMock: vi.fn() }))

vi.mock('./e5-client.ts', () => ({ createE5Worker: createE5WorkerMock }))

import { createCoreRuntime } from './runtime.ts'
import { retain } from './episodes.ts'

const scope = {
  worldAddress: { tenantId: 'tenant', worldId: 'world', branchId: 'branch' },
  characterId: 'character:friend',
  asOfWorldSeq: 8,
}

it('replaces a failed E5 client for the next request without retrying the failed request', async () => {
  const assetDirectory = await mkdtemp(join(tmpdir(), 'memory-e5-restart-'))
  try {
    await writeFile(
      join(assetDirectory, 'tokenizer.json'),
      JSON.stringify({
        version: '1.0',
        truncation: null,
        padding: null,
        added_tokens: [],
        normalizer: null,
        pre_tokenizer: { type: 'Whitespace' },
        post_processor: null,
        decoder: null,
        model: { type: 'WordLevel', vocab: { '[UNK]': 0 }, unk_token: '[UNK]' },
      }),
    )
    await writeFile(join(assetDirectory, 'tokenizer_config.json'), '{}')

    const failure = new Error('injected E5 worker failure'),
      first = {
        encode: vi.fn(async () => {
          throw failure
        }),
        close: vi.fn(async () => {}),
      },
      second = {
        encode: vi.fn(async (texts: readonly string[]) => ({
          tokens: texts.map(text => Array.from(text, (_, index) => index)),
          vectors: texts.map(() => Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0))),
        })),
        close: vi.fn(async () => {}),
      }
    createE5WorkerMock.mockReset().mockReturnValueOnce(first).mockReturnValue(second)

    const source: WorldJsonObject = {
        sourceId: 'event:8',
        sourceHash: 'hash:8',
        worldSeq: 8,
        knownTick: 8,
        characterId: scope.characterId,
        worldAddress: scope.worldAddress,
        epistemicKind: 'reported_speech',
        text: 'character:player said: 我喜欢热茶。',
      },
      retained = await retain({ scope, sources: [source] }, async () => ({ atoms: [] })),
      retainedPrefix = { ...retained, episodes: [], observations: [] },
      runtime = createCoreRuntime({
        model: { protocol: 'openai', endpoint: 'http://127.0.0.1:9/v1/chat/completions', model: 'fixture' },
        assetDirectory,
      }),
      build = () =>
        runtime.run(
          { operation: 'build', scope, sources: [source], retainedPrefix, aliasHistory: [] },
          new AbortController().signal,
        )

    try {
      await expect(build()).rejects.toBe(failure)
      expect(first.encode).toHaveBeenCalledTimes(1)
      expect(first.close).toHaveBeenCalledTimes(1)
      expect(second.encode).not.toHaveBeenCalled()
      expect(createE5WorkerMock).toHaveBeenCalledTimes(2)

      const result = await build()
      expect(second.encode).toHaveBeenCalledTimes(1)
      expect((result.index as WorldJsonObject).vectors).toHaveLength(1)
    } finally {
      await runtime.close()
    }

    expect(second.close).toHaveBeenCalledTimes(1)
  } finally {
    await rm(assetDirectory, { recursive: true, force: true })
  }
})
