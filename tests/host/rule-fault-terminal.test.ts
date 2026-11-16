import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { WorldApplication } from '@perspectra/core'
import { WorldStore, RoundInbox, PlayerInputJobs } from '@perspectra/core/store'
import { createWorldInstanceScope, createPluginCallContext } from '@perspectra/core/runtime'
import type { RulesInstance } from '@perspectra/sdk'
import { guardedRules, layeredCoreRules } from '../../apps/host/src/runtime/rule-layers.ts'
import { frozenIntentWorld } from '../fixtures/player-intent-world.ts'
import { basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'
async function fixture(rules: RulesInstance) {
  const root = mkdtempSync(join(tmpdir(), 'terminal-rule-fault-'))
  const scope = await createWorldInstanceScope(new Context()),
    context = createPluginCallContext(scope)
  const guarded = guardedRules(rules, 'rules', context, () => {})
  const app = new WorldApplication({
    worldPath: join(root, 'world.sqlite'),
    sessionPath: join(root, 'session.sqlite'),
    contextPath: join(root, 'context.sqlite'),
    memoryPath: join(root, 'memory.sqlite'),
    rulebooks: layeredCoreRules(() => [guarded], [basicInteractionPackage]),
    interactionPackages: [basicInteractionPackage],
  })
  const world = frozenIntentWorld(),
    address = world.manifest.address
  app.activate(world)
  const store = new WorldStore(join(root, 'world.sqlite')),
    inbox = new RoundInbox(join(root, 'world.sqlite')),
    jobs = new PlayerInputJobs(join(root, 'world.sqlite'))
  const submit = (key: string) =>
    app.submitText(address, { text: key, idempotencyKey: key, principalId: 'principal:player', correlationId: key })
  return {
    app,
    store,
    inbox,
    jobs,
    context,
    address,
    submit,
    async close() {
      await app.close()
      await scope.close()
      store.close()
      inbox.close()
      jobs.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
it('terminates a preparation fault and never revives the old input when a fresh input arrives', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  let broken = true,
    calls = 0
  const f = await fixture({
    affordances(input, next) {
      calls++
      if (broken) throw new Error('PRIVATE_PREPARE')
      return next(input)
    },
  })
  try {
    const before = f.store.head(f.address)
    await expect(f.submit('old-fault')).rejects.toMatchObject({ origin: 'plugin', operation: 'affordances' })
    expect(f.jobs.read(f.address, 'old-fault')).toMatchObject({
      status: 'failed',
      records: { failed: { pluginId: 'rules', operation: 'affordances' } },
    })
    expect(f.store.head(f.address)).toEqual(before)
    const attempted = calls
    broken = false
    await expect(f.submit('old-fault')).rejects.toMatchObject({ origin: 'plugin' })
    expect(calls).toBe(attempted)
    expect(await f.submit('fresh')).toMatchObject({ status: 'submitted', result: { status: 'accepted' } })
    const speech = f.store.readEvents(f.address).filter(event => event.eventType === 'character.speak')
    expect(JSON.stringify(speech)).toContain('fresh')
    expect(JSON.stringify(speech)).not.toContain('old-fault')
    expect(JSON.stringify(f.jobs.read(f.address, 'old-fault'))).not.toContain('PRIVATE_PREPARE')
  } finally {
    log.mockRestore()
    await f.close()
  }
})
it('terminates invalid plugin effects as a plugin fault without a world commit or implicit retry', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  let broken = true,
    calls = 0
  const f = await fixture({
    resolve(input, next) {
      calls++
      if (!broken) return next(input)
      return {
        status: 'accepted',
        events: [
          {
            eventType: 'entity.transferred',
            eventVersion: 1,
            data: {
              entityId: 'entity:missing',
              characterId: input.characterId,
              interactionId: 'forged',
              fromHolderId: null,
              fromLocationId: 'location:nowhere',
              toHolderId: input.characterId,
              toLocationId: null,
            },
          },
        ],
      }
    },
  })
  try {
    const before = f.store.head(f.address)
    await expect(f.submit('invalid-effect')).rejects.toMatchObject({ origin: 'plugin', operation: 'resolve' })
    expect(f.jobs.read(f.address, 'invalid-effect')?.status).toBe('failed')
    expect(f.inbox.readStatus(f.address, { idempotencyKey: 'invalid-effect' })?.status).toBe('failed')
    expect(f.store.head(f.address)).toEqual(before)
    expect(f.context.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ pluginId: 'rules', operation: 'resolve' })]),
    )
    broken = false
    const attempted = calls
    await expect(f.submit('invalid-effect')).rejects.toMatchObject({ origin: 'plugin' })
    expect(calls).toBe(attempted)
    expect(await f.submit('fresh')).toMatchObject({ status: 'submitted', result: { status: 'accepted' } })
  } finally {
    log.mockRestore()
    await f.close()
  }
})

it('keeps the current input independent when an earlier accepted FIFO round faults', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = await fixture({
    resolve(input, next) {
      if ((input.action.parameters as { text?: string })?.text === 'earlier') throw new Error('earlier plugin fault')
      return next(input)
    },
  })
  try {
    await f.app.acceptRound(f.address, {
      idempotencyKey: 'earlier',
      principalId: 'principal:player',
      correlationId: 'earlier',
      action: { actionType: 'speak', parameters: { text: 'earlier' } },
    })
    expect(await f.submit('current')).toMatchObject({ status: 'submitted', result: { status: 'accepted' } })
    expect(f.inbox.readStatus(f.address, { idempotencyKey: 'earlier' })?.status).toBe('failed')
    expect(f.jobs.read(f.address, 'current')?.status).toBe('completed')
    expect(f.inbox.readStatus(f.address, { idempotencyKey: 'current' })?.status).toBe('committed')
    const speech = JSON.stringify(f.store.readEvents(f.address).filter(event => event.eventType === 'character.speak'))
    expect(speech).not.toContain('earlier')
    expect(speech).toContain('current')
  } finally {
    await f.close()
    log.mockRestore()
  }
})
