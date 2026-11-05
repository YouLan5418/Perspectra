import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('rejects experiment dependencies and package internals while allowing current host paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-boundaries-'))
  try {
    for (const directory of [
      'desktop',
      'packages/frontend',
      'packages/application',
      'apps/launcher/src',
      'apps/launcher/src-tauri/src',
      'scripts/release',
      'scripts/build',
      'tests/scenarios',
      'tests/experiments',
      'packages/plugin-sdk',
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
      writeFileSync(join(root, 'desktop/entry.ts'), source)
      const result = spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], {
        encoding: 'utf8',
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('production source depends on an experiment path')
    }
    writeFileSync(join(root, 'desktop/entry.ts'), 'await store.commitRound(request)')
    const directCommit = spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], {
      encoding: 'utf8',
    })
    expect(directCommit.status).toBe(1)
    expect(directCommit.stderr).toContain('the host commits only through the core execution path')
    writeFileSync(join(root, 'desktop/entry.ts'), "join(repository, 'desktop', 'host', 'web-entry.ts')")
    writeFileSync(
      join(root, 'packages/frontend/player.ts'),
      "import type { Host } from '../../../desktop/host/world-runtime.ts'",
    )
    expect(
      spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).status,
    ).toBe(1)
    writeFileSync(join(root, 'packages/frontend/player.ts'), 'export interface Player {}')
    writeFileSync(
      join(root, 'packages/application/world.ts'),
      "import { install } from '@harness-world/interactions-basic'",
    )
    const implicitGameplay = spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], {
      encoding: 'utf8',
    })
    expect(implicitGameplay.status).toBe(1)
    expect(implicitGameplay.stderr).toContain('core must receive its gameplay install from composition')
    writeFileSync(join(root, 'packages/application/world.ts'), 'export {}')
    writeFileSync(join(root, 'packages/application/world.ts'), "import type { Host } from '../../desktop/entry.ts'")
    expect(
      spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).stderr,
    ).toContain('core must not depend on host adapters')
    writeFileSync(join(root, 'packages/application/world.ts'), 'export {}')
    writeFileSync(join(root, 'packages/plugin-sdk/contract.ts'), "import { Factory } from '@harness-world/application'")
    expect(
      spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).stderr,
    ).toContain('plugin SDK contracts must not import implementations')
    writeFileSync(join(root, 'packages/plugin-sdk/contract.ts'), 'export interface Contract {}')
    writeFileSync(
      join(root, 'examples/world-packs/sample/scripts/rules.js'),
      "import { Service } from '@deepseek-ai/cordis'",
    )
    expect(
      spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).stderr,
    ).toContain('world-pack scripts use author hooks')
    writeFileSync(join(root, 'examples/world-packs/sample/scripts/rules.js'), 'globalThis.activityScript = {}')

    writeFileSync(
      join(root, 'desktop/entry.ts'),
      "import { CharacterTurn } from '../packages/application/src/character-turn.ts'",
    )
    const internal = spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], {
      encoding: 'utf8',
    })
    expect(internal.status).toBe(1)
    expect(internal.stderr).toContain('use @harness-world/application')
    writeFileSync(join(root, 'desktop/entry.ts'), "import { CharacterTurn } from '@harness-world/application'")
    writeFileSync(
      join(root, 'apps/launcher/src/view.ts'),
      [
        "import type { InspectedRequest } from '@harness-world/provider-chat'",
        "import { rolePreset } from '@harness-world/provider-chat/preset'",
      ].join('\n'),
    )
    expect(
      spawnSync(process.execPath, [resolve('scripts/check-host-boundaries.mjs'), root], { encoding: 'utf8' }).status,
    ).toBe(0)
    // The launcher no longer reaches into package sources, not even for browser-safe modules.
    writeFileSync(
      join(root, 'apps/launcher/src/view.ts'),
      "import { rolePreset } from '../../../packages/provider-chat/src/preset.ts'",
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
