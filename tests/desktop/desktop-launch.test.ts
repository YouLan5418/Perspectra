import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { preflightSave } from '../../desktop/save-preflight.ts'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const within = relative(resolve('.tmp'), directory)
    if (within.startsWith('..') || within === '' || !basename(directory).startsWith('desktop-launch-test-')) {
      throw new Error('refusing to remove a directory outside the desktop test root')
    }
    await rm(directory, { recursive: true, force: true })
  }
})

async function freshDirectory(): Promise<string> {
  await mkdir(resolve('.tmp'), { recursive: true })
  const directory = await mkdtemp(resolve('.tmp', 'desktop-launch-test-'))
  directories.push(directory)
  return directory
}

describe('desktop launch boundary', () => {
  it.each(['hand-in-hand', 'autonomy-scheduling', 'scripted-performance'])(
    'starts %s with an external character loop, serves authorized state and closes',
    async packName => {
      const directory = await freshDirectory()
      const pluginDirectory = await freshDirectory(),
        pluginPath = join(pluginDirectory, 'speech.mjs')
      await writeFile(
        pluginPath,
        `import { writeFileSync, appendFileSync } from 'node:fs';
      export const hostApi = '2.5';
      export default function(ctx) {
        ctx.effect(() => ctx.knowledge.register({ id:'packaged-knowledge',version:'1.0.0',open:async()=>({
          select:context=>{writeFileSync(new URL('./knowledge-ran', import.meta.url),context.character.characterId);return undefined},
          close:()=>writeFileSync(new URL('./knowledge-closed', import.meta.url),'yes'),
        }) }));
        ctx.effect(() => ctx.characterLoop.register({ id:'packaged-loop', version:'1.0.0', open:async()=>({
          run: async activation => {
            for (let step = 0; step < 2; step++) {
              activation.prepare({canPerform:step === 0 && !activation.continuation,continuation:activation.continuation || step > 0});
              const result = await activation.submit(await activation.decide(() => false));
              appendFileSync(new URL('./loop-ran', import.meta.url), activation.characterId + '\\n');
              if (result.decision === 'abstain') return 'abstained';
              if (result.decision === 'publish') return result.status === 'accepted' ? 'published' : 'failed';
            }
            return 'budget_exhausted';
          },
          close: () => writeFileSync(new URL('./loop-closed', import.meta.url), 'yes'),
        }) }));
        ctx.effect(() => ctx.llm.registerTransport({ id:'packaged-transport', version:'1.0.0', open:async()=>({ model:'packaged-fixture', schemaMode:'native', send:async()=>({value:{decision:'abstain'}}) }) }));
        ctx.effect(() => ctx.frontendServices.registerSpeech(async () => ({contentType:'audio/wav',bytes:new Uint8Array([1])})));
        ctx.effect(() => ctx.frontendServices.registerBgm({
          tracks: [{id:'calm',title:'日常',contentType:'audio/wav',bytes:new Uint8Array([82,73,70,70])}],
          selectTrack: () => 'calm',
        }));
        ctx.effect(() => () => writeFileSync(new URL('./plugin-closed', import.meta.url), 'yes'));
      }`,
      )
      const pack = resolve('examples/world-packs', packName)
      expect((await preflightSave(pack, directory)).kind).toBe('new')
      const bundled = process.env.HCW_TEST_DESKTOP_BUNDLE === '1'
      const entry = bundled ? resolve('dist/backend/playtest.mjs') : resolve('desktop/host/web-entry.ts')
      const child = spawn(
        process.execPath,
        [
          ...(bundled ? [] : ['--import', 'tsx']),
          entry,
          '--memory-none',
          '--pack',
          pack,
          '--data-dir',
          directory,
          '--tuning',
          JSON.stringify({
            maximumWaves: 1,
            maximumNpcCalls: 2,
            maximumCallsPerCharacter: 1,
            reactionDeadlineSeconds: 15,
            recentObservations: 4,
            recentSelfObservations: 0,
          }),
        ],
        {
          cwd: resolve('.'),
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          windowsHide: true,
          env: {
            ...process.env,
            PERSPECTRA_ROLE_MODELS: undefined,
            PERSPECTRA_MODEL_KEYS: undefined,
            PERSPECTRA_MODEL_ENDPOINT: 'http://127.0.0.1:9/v1/chat/completions',
            PERSPECTRA_MODEL: 'fixture',
            PERSPECTRA_HOST_PLUGINS: JSON.stringify([
              { id: 'tts', path: pluginPath, enabled: true },
              { id: 'disabled', path: join(pluginDirectory, 'not-installed.mjs'), enabled: false },
            ]),
          },
        },
      )
      let stderr = ''
      child.stderr?.on('data', chunk => {
        stderr += String(chunk)
      })
      try {
        const ready = await new Promise<{ port: number; token: string }>((resolveReady, rejectReady) => {
          const timeout = setTimeout(() => rejectReady(new Error(`startup timeout: ${stderr}`)), 30_000)
          child.on('message', value => {
            if (
              value &&
              typeof value === 'object' &&
              'type' in value &&
              value.type === 'ready' &&
              'port' in value &&
              'token' in value &&
              typeof value.port === 'number' &&
              typeof value.token === 'string'
            ) {
              clearTimeout(timeout)
              resolveReady({ port: value.port, token: value.token })
            }
          })
          child.once('exit', code => {
            clearTimeout(timeout)
            rejectReady(new Error(`exit ${code}: ${stderr}`))
          })
        })
        const origin = `http://127.0.0.1:${ready.port}`
        expect((await fetch(`${origin}/api/state`)).status).toBe(401)
        const response = await fetch(`${origin}/api/state`, { headers: { 'x-playtest-token': ready.token } })
        expect(response.status).toBe(200)
        const state = (await response.json()) as {
          world: { title: string }
          debug: { model: string }
          availableActions?: readonly { actionType: string }[]
        }
        expect(state.world.title.length).toBeGreaterThan(0)
        if (packName === 'hand-in-hand') expect(state.world.title).toBe('山脊上的两只手')
        expect(state.debug.model).toBe('packaged-fixture')
        if (packName === 'hand-in-hand')
          expect(state.availableActions?.map(value => value.actionType)).toContain('interact')
        const init = await (
          await fetch(`${origin}/frontend-api/v1/init`, { headers: { 'x-playtest-token': ready.token } })
        ).json()
        expect(init.capabilities).toContain('speech')
        expect(init.capabilities).toContain('bgm')
        const music = await fetch(`${origin}/frontend-api/v1/bgm/audio`, {
          method: 'POST',
          headers: { 'x-playtest-token': ready.token, 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'calm' }),
        })
        expect(music.status).toBe(200)
        expect(new Uint8Array(await music.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]))
        const submitted = await fetch(`${origin}/api/${packName === 'scripted-performance' ? 'activity' : 'submit'}`, {
          method: 'POST',
          headers: { 'x-playtest-token': ready.token, 'content-type': 'application/json' },
          body: JSON.stringify(
            packName === 'scripted-performance'
              ? {
                  activityKey: 'default',
                  activityId: null,
                  revision: 0,
                  operation: 'start',
                  parameters: {},
                  requestId: 'packaged-loop',
                }
              : { text: '你好。' },
          ),
        })
        expect(submitted.status).toBe(200)
        const actors = await readFile(join(pluginDirectory, 'loop-ran'), 'utf8')
        expect(actors).toContain('character:')
        expect(await readFile(join(pluginDirectory, 'knowledge-ran'), 'utf8')).toContain('character:')
        if (packName === 'autonomy-scheduling') expect(actors).toContain('character:friend')
        child.send({ type: 'shutdown' })
        const exitCode = await new Promise<number | null>(resolveExit => child.once('exit', resolveExit))
        expect(exitCode).toBe(0)
        expect(await readFile(join(pluginDirectory, 'plugin-closed'), 'utf8')).toBe('yes')
        expect(await readFile(join(pluginDirectory, 'loop-closed'), 'utf8')).toBe('yes')
        expect(await readFile(join(pluginDirectory, 'knowledge-closed'), 'utf8')).toBe('yes')
        expect((await preflightSave(pack, directory)).kind).toBe('resume')
        await expect(preflightSave(resolve('examples/world-packs/prototype-g1'), directory)).rejects.toThrow(
          '世界包与存档中的世界不一致',
        )
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill()
      }
    },
    45_000,
  )
})
