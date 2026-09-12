import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { canonicalCompiledWorldPackBytes, compileWorldPackSource, executeWorldPackCli } from '@harness-world/world-pack'
import { WorldPlaytestRuntime } from './playtest-runtime.ts'
import { createStepManifestationSchema } from '@harness-world/contracts'
import { parsePlaytestLaunchArguments } from './playtest-launch.ts'

it.each([4, 5] as const)('plays and reopens an expressive Pack through the v%s web Provider adapter', async version => {
  const root = mkdtempSync(join(tmpdir(), 'grouped-web-'))
  const source = join(root, 'source')
  const packPath = join(root, 'pack.json')
  const interactionsPath = join(root, 'interactions.json')
  await executeWorldPackCli(['init', '--profile', 'expressive-social', source])
  writeFileSync(packPath, canonicalCompiledWorldPackBytes(await compileWorldPackSource(source)))
  writeFileSync(interactionsPath, readFileSync(new URL('../../examples/world-packs/possession-interactions.json', import.meta.url)))
  const dataDirectory = join(root, 'data')
  const options = { dataDirectory, packPath, provider: 'deepseek' as const, apiKey: 'TEST_SECRET_NOT_FOR_EVIDENCE',
    ...(version === 5 ? { interactionsPath } : { actionGroups: true }) }
  let aliceRootCalls = 0
  let reactionCalls = 0
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(String(input)).toBe('https://api.deepseek.com/chat/completions')
    expect((init?.headers as any).authorization).toBe('Bearer TEST_SECRET_NOT_FOR_EVIDENCE')
    const body = JSON.parse(String(init?.body))
    expect(body.max_tokens).toBe(2048)
    expect(JSON.stringify(body)).not.toContain('submit_actions/v2')
    const segments = body.messages.filter((message: any) => message.role === 'user').map((message: any) => JSON.parse(message.content))
    const actorId = segments.find((value: any) => value.segmentKind === 'character_anchor').content.characterId
    const reminder = segments.find((value: any) => value.segmentKind === 'output_reminder').content
    expect(reminder.tool).toBe(`submit_actions/v${version}`)
    const upstream = body.messages.map((message: { content: string }) => message.content).join('\n')
    expect(upstream).toContain(JSON.stringify(createStepManifestationSchema('speak')))
    const reaction = reminder.maximumReflectionOperations === 0
    if (reaction) {
      reactionCalls++
      expect(body.messages[2].content).toContain(version === 5 ? '"const":"interact"' : '"const":"move"')
    }
    const actions: object[] = []
    if (actorId === 'character:alice' && !reaction) {
      aliceRootCalls++
      if (aliceRootCalls <= (version === 5 ? 2 : 1)) {
        actions.push({ actionId: 'first', actorId, actionType: version === 5 ? 'interact' : 'take', actionVersion: 1,
          parameters: version === 5
            ? { targetId: 'entity:ticket-bundle', interactionId: aliceRootCalls === 1 ? 'core:take' : 'core:give', arguments: aliceRootCalls === 1 ? {} : { recipientId: 'character:player' } }
            : { entityId: 'entity:ticket-bundle' } },
        { actionId: 'second', actorId, actionType: 'speak', actionVersion: 1, parameters: { text: aliceRootCalls === 1 ? '票据收好了。' : '票据交给你。' }, manifestation: { independent: ['nod'], onSuccess: ['quiet_voice'] } })
      }
    }
    return new Response(JSON.stringify({ model: 'test-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ schemaVersion: version, decision: actions.length > 0 ? 'act' : 'abstain', actions }) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }))
  })
  let runtime: WorldPlaytestRuntime | undefined
  try {
    runtime = await WorldPlaytestRuntime.create(options)
    expect((await runtime.state()).debug).toMatchObject({ manifestVersion: version + 3, outputProtocol: `submit_actions/v${version}` })
    const state = await runtime.submit('/say Alice，请收好票据。')
    expect(state.transcript.some(value => value.text.includes('票据收好了。'))).toBe(true)
    expect(reactionCalls).toBeGreaterThan(0)
    if (version === 5) {
      const gave = await runtime.submit('Alice，请把票据交给我。')
      expect(gave.transcript.some(value => value.text.includes('交由旅人持有'))).toBe(true)
      const dropped = await runtime.submit('/interact entity:ticket-bundle core:drop')
      expect(dropped.transcript.some(value => value.player && value.text.includes('放在当前位置'))).toBe(true)
      await runtime.submit('/interact entity:ticket-bundle core:take')
    }
    const head = (await runtime.state()).debug.headSeq
    await runtime.close()
    const calls = fetchMock.mock.calls.length
    runtime = await WorldPlaytestRuntime.create(options)
    expect((await runtime.state()).debug.headSeq).toBe(head)
    expect(fetchMock).toHaveBeenCalledTimes(calls)
    const evidence = readdirSync(join(dataDirectory, 'requests')).map(file => readFileSync(join(dataDirectory, 'requests', file), 'utf8')).join('\n')
    expect(evidence).toContain('grouped-playtest/v2')
    expect(evidence).not.toContain('TEST_SECRET_NOT_FOR_EVIDENCE')
    expect(evidence).not.toContain('invalid_model_output')
    for (const content of [
      JSON.stringify({ schemaVersion: version, decision: 'act', actions: [{
        actionId: 'bad', actorId: 'character:alice', actionType: 'speak', actionVersion: 1,
        parameters: { text: '这句不应提交。' }, manifestation: { independent: ['smile', 'smile'], onSuccess: [] },
      }] }),
      '{' + 'x'.repeat(70_000),
    ]) {
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ model: 'test-model',
        choices: [{ finish_reason: 'stop', message: { content, reasoning_content: 'PRIVATE_REASONING_NOT_FOR_EVIDENCE' } }],
        usage: { prompt_tokens: 20, completion_tokens: 10 } })))
      const state = await runtime.submit('/say 再试一次。')
      expect(state.notice).toContain('无效动作格式')
      const failures = readdirSync(join(dataDirectory, 'requests')).filter(file => file.endsWith('.invalid.json'))
        .map(file => JSON.parse(readFileSync(join(dataDirectory, 'requests', file), 'utf8')))
      expect(failures.some(failure => failure.rawOutput === content.slice(0, 65_536)
        && failure.rawOutputTruncated === (content.length > 65_536))).toBe(true)
      expect(failures.some(failure => failure.validationError === 'invalid or duplicate step cues')).toBe(true)
      expect(JSON.stringify(failures)).not.toContain('PRIVATE_REASONING_NOT_FOR_EVIDENCE')
      expect(JSON.stringify(failures)).not.toContain('TEST_SECRET_NOT_FOR_EVIDENCE')
    }
  } finally {
    await runtime?.close()
    fetchMock.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})

it('validates grouped launch flags and requires a Pack before creating a new protocol world', async () => {
  expect(parsePlaytestLaunchArguments(['--pack', 'pack.json', '--interactions', 'catalog.json'])).toMatchObject({ interactionsPath: 'catalog.json' })
  expect(parsePlaytestLaunchArguments(['--action-groups', '--pack', 'pack.json'])).toMatchObject({ actionGroups: true })
  for (const args of [['--interactions'], ['--interactions', '--pack'], ['--interactions', 'a', '--interactions', 'b'], ['--action-groups', '--action-groups'], ['--action-groups', '--interactions', 'a']]) {
    expect(() => parsePlaytestLaunchArguments(args)).toThrow()
  }
  await expect(WorldPlaytestRuntime.create({ dataDirectory: 'unused', actionGroups: true })).rejects.toThrow('require --pack')
})
