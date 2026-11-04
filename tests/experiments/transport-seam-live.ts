/** Live acceptance for the shipped transport example. Uses new data and process-only credentials. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadHostPlugins } from '../../desktop/host-plugins.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { environmentRoleModels } from '../../desktop/model-connections.ts'
import { playSettings } from '../../desktop/play-settings.ts'

const endpoint = process.env.PERSPECTRA_MODEL_ENDPOINT
const model = process.env.PERSPECTRA_MODEL
const key = process.env.PERSPECTRA_MODEL_API_KEY
assert(endpoint && model, 'set PERSPECTRA_MODEL_ENDPOINT and PERSPECTRA_MODEL')
const root = resolve(process.argv[2] ?? '.tmp/transport-live-' + randomUUID())
assert(!existsSync(root), 'acceptance needs a new data directory')
mkdirSync(root, { recursive: true })
const session = await loadHostPlugins(
  [
    {
      id: 'simple-transport',
      enabled: true,
      path: resolve('examples/host-plugins/simple-transport.mjs'),
      config: { endpoint, model },
    },
  ],
  key ? { 'simple-transport': { apiKey: key } } : {},
)
assert.deepEqual(session.skipped, [])
const selected = session.seams.llmTransport!
let sends = 0
const seen: { preset: boolean; generation: boolean }[] = []
let runtime: WorldHostRuntime | undefined
const prompt = '请用角色自己的语气，简短地回答本轮玩家的问题，不要替他人发言。'
const started = performance.now()
try {
  runtime = await WorldHostRuntime.create({
    dataDirectory: root,
    packPath: resolve('examples/world-packs/dynamic-scheduling'),
    serialScheduling: true,
    models: environmentRoleModels({
      PERSPECTRA_MODEL_ENDPOINT: 'http://127.0.0.1:9/v1/chat/completions',
      PERSPECTRA_MODEL: 'unused-official',
      PERSPECTRA_MODEL_API_KEY: 'UNUSED_OFFICIAL_CREDENTIAL',
    }),
    plugins: {
      ...session.seams,
      llmTransport: {
        ...selected,
        open: async (world, signal) => {
          const instance = await selected.open(world, signal)
          return {
            ...instance,
            send: async (actor, call, abort) => {
              sends++
              seen.push({
                preset: call.messages.some(message => message.content.includes(prompt)),
                generation: call.generation.temperature === 0.3,
              })
              return instance.send(actor, call, abort)
            },
          }
        },
      },
    },
    preset: {
      prompt,
      temperature: 0.3,
      textRules: [
        {
          id: 'output',
          name: 'output proof',
          enabled: true,
          stage: 'output',
          target: 'speech',
          pattern: '^',
          flags: '',
          replacement: '【输出校验】',
        },
        {
          id: 'display',
          name: 'display proof',
          enabled: true,
          stage: 'display',
          target: 'speech',
          pattern: '【输出校验】',
          flags: 'g',
          replacement: '【展示校验】',
        },
      ],
    },
    playSettings: playSettings({
      maximumWaves: 1,
      maximumNpcCalls: 4,
      maximumCallsPerCharacter: 1,
      modelTimeoutSeconds: 120,
      activationTimeoutSeconds: 240,
      reactionDeadlineSeconds: 240,
    }),
  })
  runtime.requestInspection(true)
  for (const text of ['你好，你现在正在忙什么？', '如果有空，我们可以聊一会儿吗？']) {
    const state = await runtime.submit(text)
    assert(!state.error, 'character processing failed')
  }
  const before = await runtime.state()
  assert(
    before.transcript.some(line => line.text.includes('【展示校验】')),
    'output/display rules were not observed',
  )
  const inspection = runtime.requestInspection()
  assert(
    inspection.requests.length > 0 &&
      inspection.requests.every(request => request.status === 'ok' && request.body?.transport === 'simple-transport'),
    'missing transport inspection',
  )
  await runtime.regenerate(before.tailRound!.id!, 'transport-live-regenerate')
  const state = await runtime.state()
  assert(!state.error && sends > 2, 'regeneration did not use the transport')
  assert(
    seen.every(call => call.preset && call.generation),
    'preset was lost',
  )
  await runtime.close()
  runtime = undefined
  const summary = {
    model,
    sends,
    elapsedMs: Math.round(performance.now() - started),
    preset: true,
    outputAndDisplay: true,
    inspection: true,
    regenerated: true,
    transcript: state.transcript,
  }
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  const scan = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) scan(path)
      else {
        const bytes = readFileSync(path)
        for (const secret of [key, 'UNUSED_OFFICIAL_CREDENTIAL'])
          assert(!secret || !bytes.includes(Buffer.from(secret)), 'credential found in generated evidence')
      }
    }
  }
  scan(root)
  process.stdout.write(
    JSON.stringify({
      model,
      sends,
      elapsedMs: summary.elapsedMs,
      preset: true,
      outputAndDisplay: true,
      regenerated: true,
    }) + '\n',
  )
} finally {
  await runtime?.close()
  await session.close()
}
