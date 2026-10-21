import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('rejects direct and constructed experiment dependencies while allowing current host paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-boundaries-'))
  try {
    for (const directory of ['desktop', 'packages/frontend', 'apps/launcher/src', 'apps/launcher/src-tauri/src', 'scripts/release', 'scripts/build']) {
      mkdirSync(join(root, directory), { recursive: true })
    }
    writeFileSync(join(root, 'package.json'), '{}')
    for (const source of [
      "import './tests/experiments/entry.ts'",
      "join(repository, 'tests', 'experiments', 'playtest-web-entry.ts')",
      "resolve(repository, 'experiments', 'hindsight-core', 'core.py')",
    ]) {
      writeFileSync(join(root, 'desktop/main.ts'), source)
      const result = spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('production source depends on an experiment path')
    }
    writeFileSync(join(root, 'desktop/main.ts'), "join(repository, 'desktop', 'host', 'web-entry.ts')")
    writeFileSync(join(root, 'packages/frontend/player.ts'), "import type { Host } from '../../../desktop/host/world-runtime.ts'")
    expect(spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).status).toBe(1)
    writeFileSync(join(root, 'packages/frontend/player.ts'), 'export interface Player {}')
    expect(execFileSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' })).toContain('Host boundaries passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
