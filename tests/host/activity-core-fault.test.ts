import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { WorldApplication, type ActivityWorld } from '@harness-world/application'
import { RulebookRegistry } from '@harness-world/kernel'
import type { ActivityInstance } from '@harness-world/plugin-sdk'
import { HostCallbackErrors, hostCallback } from '@harness-world/runtime-cordis'
import { ActivitiesRuntime } from '../../desktop/host/activities-runtime.ts'
import { frozenInteractionWorld, basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'

it.each([TypeError, RangeError])('propagates a core %s before optional auto-start warnings', async ErrorType => {
  const root = mkdtempSync(join(tmpdir(), 'activity-core-fault-'))
  const app = new WorldApplication({
    worldPath: join(root, 'world.sqlite'),
    sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'),
    interactionPackages: [basicInteractionPackage],
  })
  const world = frozenInteractionWorld()
  app.activate(world)
  const failure = new ErrorType('core read failed'),
    callbacks = new HostCallbackErrors()
  const autoStart = vi.fn(() => ({ when: [true] }))
  const entry: ActivityInstance = {
    key: 'test',
    definition: { title: 'test', npcIds: ['character:npc'], operations: [] },
    hasAutoStart: true,
    hasResume: () => false,
    initialize: () => undefined,
    policy: () => undefined,
    resolve: () => undefined,
    published: () => undefined,
    resume: () => undefined,
    autoStart,
    simulate: () => undefined,
    schedule: () => undefined,
    outcome: () => undefined,
  }
  const catalog = ActivitiesRuntime.open(
    { entries: [entry], select: () => undefined, chooseAutoStart: () => 'test' },
    join(root, 'world.sqlite'),
    world.manifest.address,
    'character:player',
    undefined,
    new RulebookRegistry(),
    undefined,
    'test:activities',
    error => callbacks.has(error),
  )!
  try {
    const warning = vi.fn()
    const snapshot: ActivityWorld = {
      events: [],
      headSeq: 0,
      manifest: world.manifest,
      truth: () =>
        hostCallback(callbacks, () => {
          throw failure
        }),
      worldView: () => ({}),
    }
    let caught: unknown
    try {
      catalog.autoStartCandidates(snapshot, warning)
    } catch (error) {
      caught = error
    }
    expect(callbacks.has(failure)).toBe(true)
    expect(caught).toBe(failure)
    expect(warning).not.toHaveBeenCalled()
    expect(autoStart).not.toHaveBeenCalled()
  } finally {
    catalog.close()
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})
