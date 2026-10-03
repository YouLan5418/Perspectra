import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
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
  it('starts a local world, serves authorized state, closes, and refuses another pack for that save', async () => {
    const directory = await freshDirectory()
    const pack = resolve('examples/world-packs/hand-in-hand')
    expect((await preflightSave(pack, directory)).kind).toBe('new')
    const bundled = process.env.HCW_TEST_DESKTOP_BUNDLE === '1'
    const entry = bundled ? resolve('dist/backend/playtest.mjs') : resolve('tests/experiments/playtest-web-entry.ts')
    const child = spawn(process.execPath, [
      ...(bundled ? [] : ['--import', 'tsx']), entry,
      '--ollama', '--pack', pack, '--data-dir', directory,
      '--tuning', JSON.stringify({ maximumWaves: 1, maximumNpcCalls: 2, maximumCallsPerCharacter: 1,
        reactionDeadlineSeconds: 15, recentObservations: 4, recentSelfObservations: 0 }),
    ], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    try {
      const ready = await new Promise<{ port: number; token: string }>((resolveReady, rejectReady) => {
        const timeout = setTimeout(() => rejectReady(new Error(`startup timeout: ${stderr}`)), 30_000)
        child.on('message', value => {
          if (value && typeof value === 'object' && 'type' in value && value.type === 'ready'
            && 'port' in value && 'token' in value
            && typeof value.port === 'number' && typeof value.token === 'string') {
            clearTimeout(timeout)
            resolveReady({ port: value.port, token: value.token })
          }
        })
        child.once('exit', code => { clearTimeout(timeout); rejectReady(new Error(`exit ${code}: ${stderr}`)) })
      })
      const origin = `http://127.0.0.1:${ready.port}`
      expect((await fetch(`${origin}/api/state`)).status).toBe(401)
      const response = await fetch(`${origin}/api/state`, { headers: { 'x-playtest-token': ready.token } })
      expect(response.status).toBe(200)
      const state = await response.json() as { world: { title: string }; availableActions?: readonly { actionType: string }[] }
      expect(state.world.title).toBe('山脊上的两只手')
      expect(state.availableActions?.map(value => value.actionType)).toContain('interact')
      child.send({ type: 'shutdown' })
      const exitCode = await new Promise<number | null>(resolveExit => child.once('exit', resolveExit))
      expect(exitCode).toBe(0)
      expect((await preflightSave(pack, directory)).kind).toBe('resume')
      await expect(preflightSave(resolve('examples/world-packs/prototype-g1'), directory))
        .rejects.toThrow('世界包与存档中的世界不一致')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  }, 45_000)
})
