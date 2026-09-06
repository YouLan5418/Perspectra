import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDefinitelyPlayerSpeech, OllamaUtilityIntentInterpreter } from './utility-intent.ts'
import type { ExperimentActionReference } from './compact-context.ts'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function setup(content: unknown, options: { status?: number; doneReason?: string; missingContent?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-utility-intent-'))
  roots.push(directory)
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    model: 'qwen3.5:4b', done_reason: options.doneReason ?? 'stop',
    message: options.missingContent ? {} : { content: JSON.stringify(content) },
  }), { status: options.status ?? 200 }))
  return { directory, fetchMock, interpreter: new OllamaUtilityIntentInterpreter(
    new URL('http://127.0.0.1:11434/api/chat'), 'qwen3.5:4b', 5_000, directory,
  ) }
}

const references: readonly ExperimentActionReference[] = [
  { kind: 'location', short: 'L1', source: 'location:station-platform', label: '末班车站台' },
  { kind: 'entity', short: 'E1', source: 'entity:tickets', label: '车票', locationSource: 'location:shelter' },
]

describe('local utility intent interpreter', () => {
  it('recognizes complete conversational questions without asking an action model', () => {
    expect(isDefinitelyPlayerSpeech('发生了什么')).toBe(true)
    expect(isDefinitelyPlayerSpeech('我们现在走吗？')).toBe(true)
    expect(isDefinitelyPlayerSpeech('为什么不等 Bob')).toBe(true)
    expect(isDefinitelyPlayerSpeech('好，我们去车站吧')).toBe(false)
    expect(isDefinitelyPlayerSpeech('拿上车票')).toBe(false)
  })

  it('translates constrained actions while preserving player speech verbatim', async () => {
    const speech = setup({ intent: 'speak', targetRef: '', question: '' })
    await expect(speech.interpreter.interpret('我们要不要走？', references)).resolves.toEqual({
      status: 'action', action: { actionType: 'speak', parameters: { text: '我们要不要走？' } },
    })
    const body = JSON.parse(speech.fetchMock.mock.calls[0]![1]!.body as string)
    expect(JSON.stringify(body.messages)).toContain('末班车站台')
    expect(JSON.stringify(body.messages)).not.toContain('location:station-platform')
    expect(readdirSync(speech.directory).sort()).toEqual(expect.arrayContaining([
      expect.stringMatching(/\.request\.json$/), expect.stringMatching(/\.response\.json$/),
    ]))

    const move = setup({ intent: 'move', targetRef: 'L1', question: '' })
    await expect(move.interpreter.interpret('去车站', references)).resolves.toEqual({
      status: 'action', action: { actionType: 'move', parameters: { locationId: 'location:station-platform' } },
    })
    const take = setup({ intent: 'take', targetRef: 'E1', question: '' })
    await expect(take.interpreter.interpret('拿上票', references)).resolves.toEqual({
      status: 'action', action: { actionType: 'take', parameters: { entityId: 'entity:tickets' } },
    })
    const clarification = setup({ intent: 'clarification', targetRef: '', question: '你要去哪个地点？' })
    await expect(clarification.interpreter.interpret('过去吧', references)).resolves.toEqual({
      status: 'clarification', question: '你要去哪个地点？',
    })
  })

  it('rejects unavailable, malformed, contradictory, incomplete, and failed outputs', async () => {
    const cases: { content: unknown; options?: Parameters<typeof setup>[1] }[] = [
      { content: { intent: 'move', targetRef: 'L9', question: '' } },
      { content: { intent: 'speak', targetRef: 'L1', question: '' } },
      { content: { intent: 'clarification', targetRef: '', question: '  ' } },
      { content: { intent: 'other', targetRef: '', question: '' } },
      { content: { intent: 'speak', targetRef: '', question: '', extra: true } },
      { content: { intent: 'speak', targetRef: '', question: 3 } },
      { content: { intent: 'speak', targetRef: '', question: 'x'.repeat(201) } },
      { content: null, options: { doneReason: 'length' } },
      { content: null, options: { missingContent: true } },
      { content: null, options: { status: 500 } },
    ]
    for (const value of cases) {
      const fixture = setup(value.content, value.options)
      await expect(fixture.interpreter.interpret('输入', references)).rejects.toThrow()
      fixture.fetchMock.mockRestore()
    }
  })

  it('uses clarification answers only as metadata and preserves the original speech', async () => {
    const fixture = setup({ intent: 'speak', targetRef: '', question: '' })
    await expect(fixture.interpreter.interpretClarification(
      '发生了什么', '你是想移动还是说话？', '是 speak', references,
    )).resolves.toEqual({
      status: 'action', action: { actionType: 'speak', parameters: { text: '发生了什么' } },
    })
    const body = JSON.parse(fixture.fetchMock.mock.calls[0]![1]!.body as string)
    expect(JSON.stringify(body.messages)).toContain('clarificationQuestion')
    expect(JSON.stringify(body.messages)).toContain('是 speak')
  })
})
