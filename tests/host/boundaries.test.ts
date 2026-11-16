import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('rejects experiment dependencies and package internals while allowing current host paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-boundaries-'))
  try {
    for (const directory of [
      'apps/host/src',
      'packages/frontend',
      'packages/core',
      'apps/launcher/src',
      'apps/launcher/src-tauri/src',
      'scripts/release',
      'scripts/build',
      'tests/scenarios',
      'tests/experiments',
      'packages/sdk',
      'examples/world-packs/sample/scripts',
    ]) {
      mkdirSync(join(root, directory), { recursive: true })
    }
    writeFileSync(join(root, 'package.json'), '{}')
    for (const source of [
      "import './tests/experiments/entry.ts'",
      "join(repository, 'tests', 'experiments', 'playtest-web-entry.ts')",
      "resolve(repository, 'experiments', 'hindsight-core', 'core.py')",
    ]) {
      writeFileSync(join(root, 'apps/host/src/entry.ts'), source)
      const result = spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], {
        encoding: 'utf8',
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('production source depends on an experiment path')
    }
    writeFileSync(join(root, 'apps/host/src/entry.ts'), 'await store.commitRound(request)')
    const directCommit = spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], {
      encoding: 'utf8',
    })
    expect(directCommit.status).toBe(1)
    expect(directCommit.stderr).toContain('the host commits only through the core execution path')
    writeFileSync(join(root, 'apps/host/src/entry.ts'), "join(repository, 'apps/host/src', 'host', 'web-entry.ts')")
    writeFileSync(
      join(root, 'packages/frontend/player.ts'),
      "import type { Host } from '../../apps/host/src/runtime/world-runtime.ts'",
    )
    expect(
      spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).status,
    ).toBe(1)
    writeFileSync(join(root, 'packages/frontend/player.ts'), 'export interface Player {}')
    writeFileSync(
      join(root, 'packages/core/world.ts'),
      "import { install } from '@perspectra/plugins/basic-interactions'",
    )
    const implicitGameplay = spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], {
      encoding: 'utf8',
    })
    expect(implicitGameplay.status).toBe(1)
    expect(implicitGameplay.stderr).toContain('core must receive its gameplay install from composition')
    writeFileSync(join(root, 'packages/core/world.ts'), 'export {}')
    writeFileSync(join(root, 'packages/core/world.ts'), "import type { Host } from '../../apps/host/src/entry.ts'")
    expect(
      spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).stderr,
    ).toContain('core must not depend on host adapters')
    writeFileSync(join(root, 'packages/core/world.ts'), 'export {}')
    writeFileSync(join(root, 'packages/sdk/contract.ts'), "import { Factory } from '@perspectra/core'")
    expect(
      spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).stderr,
    ).toContain('plugin SDK contracts must not import implementations')
    writeFileSync(join(root, 'packages/sdk/contract.ts'), 'export interface Contract {}')
    writeFileSync(
      join(root, 'examples/world-packs/sample/scripts/rules.js'),
      "import { Service } from '@deepseek-ai/cordis'",
    )
    expect(
      spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).stderr,
    ).toContain('world-pack scripts use author hooks')
    writeFileSync(join(root, 'examples/world-packs/sample/scripts/rules.js'), 'globalThis.activityScript = {}')

    writeFileSync(
      join(root, 'apps/host/src/entry.ts'),
      "import { CharacterTurn } from '../../../packages/core/src/application/character-turn.ts'",
    )
    const internal = spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], {
      encoding: 'utf8',
    })
    expect(internal.status).toBe(1)
    expect(internal.stderr).toContain('use @perspectra/core')
    writeFileSync(join(root, 'apps/host/src/entry.ts'), "import { CharacterTurn } from '@perspectra/core'")
    writeFileSync(
      join(root, 'apps/launcher/src/view.ts'),
      [
        "import type { InspectedRequest } from '@perspectra/providers/chat'",
        "import { rolePreset } from '@perspectra/providers/chat/preset'",
      ].join('\n'),
    )
    expect(
      spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).status,
    ).toBe(0)
    for (const specifier of [
      '@perspectra/core/store',
      '@perspectra/memory-core',
      '@perspectra/providers/status',
      'node:fs',
      'fs',
    ]) {
      writeFileSync(join(root, 'apps/launcher/src/view.ts'), `import * as implementation from '${specifier}'`)
      const result = spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], {
        encoding: 'utf8',
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Launcher browser must use browser-safe public exports')
    }
    writeFileSync(
      join(root, 'apps/launcher/src/view.ts'),
      "import type { InspectorSnapshot } from '@perspectra/providers/chat'",
    )
    writeFileSync(
      join(root, 'apps/host/src/entry.ts'),
      "import { officialStatusProvider } from '@perspectra/providers/status'",
    )
    expect(
      spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).stderr,
    ).toContain('official implementations must be selected at a Host composition entry')
    writeFileSync(join(root, 'apps/host/src/entry.ts'), "import { CharacterTurn } from '@perspectra/core'")
    // The launcher no longer reaches into package sources, not even for browser-safe modules.
    writeFileSync(
      join(root, 'apps/launcher/src/view.ts'),
      "import { rolePreset } from '../../../packages/providers/src/chat/preset.ts'",
    )
    expect(
      spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).status,
    ).toBe(1)
    writeFileSync(join(root, 'apps/launcher/src/view.ts'), 'export {}')
    writeFileSync(
      join(root, 'scripts/release/verify.mjs'),
      "import { DEFAULT_PAGE } from '../../packages/frontend/src/default-template.ts'",
    )
    expect(
      spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).status,
    ).toBe(0)
    writeFileSync(join(root, 'apps/launcher/src/view.ts'), 'export {}')
    writeFileSync(join(root, 'tests/experiments/live.ts'), "import { scenario } from '../support/scenario.ts'")
    // Concatenated so the checker does not read this fixture text as an import of the real repository.
    writeFileSync(join(root, 'tests/scenarios/scenario.test.ts'), 'import { live } from ' + "'../experiments/live.ts'")
    const regression = spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], {
      encoding: 'utf8',
    })
    expect(regression.status).toBe(1)
    expect(regression.stderr).toContain('move shared code to tests/support')
    writeFileSync(join(root, 'tests/scenarios/scenario.test.ts'), "import { scenario } from '../support/scenario.ts'")
    expect(
      execFileSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }),
    ).toContain('Host boundaries passed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
