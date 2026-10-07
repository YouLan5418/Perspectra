import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { LauncherCore } from './launcher-core.ts'

const root = process.argv[2]
if (!root) throw new Error('Launcher requires a private data directory')
const core = new LauncherCore(resolve('.'), resolve(root))
let initialized = false
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
try {
  for await (const line of lines) {
    try {
      if (!initialized) { await core.initialize(); initialized = true }
      const result = await core.handle(JSON.parse(line))
      process.stdout.write(JSON.stringify({ ok: true, result }) + '\n')
    } catch (error: unknown) {
      // Never echo request data, credentials, private Core stderr, or provider responses.
      const safe = error instanceof Error && !('code' in error) ? error.message : 'Launcher 本机操作失败。'
      process.stdout.write(JSON.stringify({ ok: false, error: safe }) + '\n')
    }
  }
} finally { await core.stop() }
