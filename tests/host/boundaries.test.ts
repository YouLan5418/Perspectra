import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('rejects experiment dependencies and package internals while allowing current host paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-boundaries-'))
  try {
    for (const directory of ['desktop', 'packages/frontend', 'apps/launcher/src', 'apps/launcher/src-tauri/src', 'scripts/release', 'scripts/build', 'tests/scenarios', 'tests/experiments']) {
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
    writeFileSync(join(root, 'desktop/main.ts'), "import { CharacterTurn } from '../packages/application/src/character-turn.ts'")
    const internal = spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' })
    expect(internal.status).toBe(1)
    expect(internal.stderr).toContain('use @harness-world/application')
    writeFileSync(join(root, 'desktop/main.ts'), "import { CharacterTurn } from '@harness-world/application'")
    writeFileSync(join(root, 'apps/launcher/src/view.ts'), [
      "import type { InspectedRequest } from '../../../packages/provider-chat/src/request-inspector.ts'",
      "import { rolePreset } from '../../../packages/provider-chat/src/preset.ts'"].join('\n'))
    expect(spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).status).toBe(0)
    writeFileSync(join(root, 'apps/launcher/src/view.ts'), "import { RequestInspector } from '../../../packages/provider-chat/src/request-inspector.ts'")
    expect(spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).status).toBe(1)
    writeFileSync(join(root, 'apps/launcher/src/view.ts'), 'export {}')
    writeFileSync(join(root, 'tests/experiments/live.ts'), "import { scenario } from '../support/scenario.ts'")
    // Concatenated so the checker does not read this fixture text as an import of the real repository.
    writeFileSync(join(root, 'tests/scenarios/scenario.test.ts'), "import { live } from " + "'../experiments/live.ts'")
    const regression = spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' })
    expect(regression.status).toBe(1)
    expect(regression.stderr).toContain('move shared code to tests/support')
    writeFileSync(join(root, 'tests/scenarios/scenario.test.ts'), "import { scenario } from '../support/scenario.ts'")
    expect(execFileSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' })).toContain('Host boundaries passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
