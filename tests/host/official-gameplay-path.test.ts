import { appendFileSync, readFileSync, rmSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { officialStatusProvider } from '@perspectra/providers/status'
import { officialActivitiesProvider } from '@perspectra/providers/activities'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { assembleRoleplay, officialRpgContent } from '../../apps/host/src/official-bundle.ts'
import { copyRpgFixture, openRpgWorld } from '../support/rpg-fixture.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('routes official native Handlers through selected state and activity providers', async () => {
  const { root, pack, data } = copyRpgFixture({
    config: config => {
      config.maps[0].scripted = []
    },
    places: { 'character:cheng': 'location:ruin-1' },
  })
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const calls: string[] = []
  const composition = assembleRoleplay({
    status: {
      id: 'selected-status',
      version: '1.0.0',
      open: async (services, signal) => {
        const instance = await officialStatusProvider.open(services, signal)
        const initialize = instance.initialize.bind(instance)
        instance.initialize = ids => {
          calls.push('initialize')
          return initialize(ids)
        }
        instance.resolve = () => {
          calls.push('status')
          return { rejectReason: 'selected state refused' }
        }
        return instance
      },
    },
    activities: {
      id: 'selected-activities',
      version: '1.0.0',
      open: async (services, signal) => {
        const instance = await officialActivitiesProvider.open(services, signal)
        for (const entry of instance.entries)
          entry.resolve = () => {
            calls.push('activity')
            return { rejectReason: 'selected activity refused' }
          }
        return instance
      },
    },
  })
  const f = await openRpgWorld(pack, data, { composition })
  cleanup.push(() => f.close())
  expect(calls).toContain('initialize')
  await f.move('location:bedroom')
  const beforeRest = f.events()
  await expect(f.runtime.submit('/status rpg-rest {}')).rejects.toThrow('selected state refused')
  expect(calls).toContain('status')
  expect(f.events()).toEqual(beforeRest)
  await f.move('location:ruin-1')
  const state = (f.events().findLast(event => event.eventType === 'activity.updated')!.data as WorldJsonObject)
    .state as WorldJsonObject
  const beforeAttack = f.events()
  const pending = f.runtime.perform({
    actionType: 'interact',
    parameters: {
      targetRef: { kind: 'character', id: 'character:player' },
      bindingId: state.id!,
      definitionRef: { id: 'activity:skill', version: 1 },
      arguments: { activityId: state.id!, revision: state.revision!, skill: '普通攻击', target: '遗迹守卫' },
    },
  })
  await expect(pending).rejects.toThrow('selected activity refused')
  expect(calls).toContain('activity')
  expect(f.events().filter(event => event.eventType === 'activity.updated')).toEqual(
    beforeAttack.filter(event => event.eventType === 'activity.updated'),
  )
})

it.each(['missing', 'damaged', 'missing-owner', 'invalid-value', 'invalid-phase'] as const)(
  'rejects %s recovery before changing existing save files',
  async fault => {
    const { root, pack, data } = copyRpgFixture({ places: { 'character:cheng': 'location:ruin-1' } })
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const original = await openRpgWorld(pack, data)
    if (fault === 'invalid-phase') await original.move('location:ruin-1')
    await original.close()
    const record = join(data, 'plugin-set.json')
    if (fault === 'missing') unlinkSync(record)
    else if (fault === 'damaged') writeFileSync(record, '{broken')
    else if (fault === 'missing-owner') {
      const value = JSON.parse(readFileSync(record, 'utf8'))
      value.gameplayData = {}
      writeFileSync(record, JSON.stringify(value))
    } else {
      const db = new DatabaseSync(join(data, 'world.sqlite'))
      try {
        if (fault === 'invalid-phase') {
          const row = db
            .prepare("SELECT seq,data_json FROM events WHERE event_type='activity.updated' ORDER BY seq DESC LIMIT 1")
            .get() as { seq: number; data_json: string }
          const value = JSON.parse(row.data_json)
          value.state.game.phase = 'phase-not-declared'
          db.prepare('UPDATE events SET data_json=? WHERE seq=?').run(JSON.stringify(value), row.seq)
        } else {
          const row = db
            .prepare("SELECT seq,data_json FROM events WHERE event_type='status.updated' ORDER BY seq LIMIT 1")
            .get() as { seq: number; data_json: string }
          const value = JSON.parse(row.data_json)
          value.changes.find((change: { key: string }) => change.key === 'rpg-hp').value = 'invalid'
          db.prepare('UPDATE events SET data_json=? WHERE seq=?').run(JSON.stringify(value), row.seq)
        }
      } finally {
        db.close()
      }
    }
    const files = () =>
      Object.fromEntries(
        readdirSync(data)
          .filter(name => name === 'plugin-set.json' || name.endsWith('.sqlite'))
          .map(name => [name, readFileSync(join(data, name)).toString('base64')]),
      )
    const before = files()
    await expect(openRpgWorld(pack, data)).rejects.toThrow()
    expect(files()).toEqual(before)
  },
)

it('derives manual Host lifecycle changes atomically while automatic starts and escape remain exempt', async () => {
  const { root, pack, data } = copyRpgFixture({
    config: config => {
      config.maps[0].scripted = []
    },
    places: { 'character:cheng': 'location:ruin-1' },
  })
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const operations: string[] = []
  let fail = false
  const composition = assembleRoleplay({
    content: [
      {
        ...officialRpgContent,
        generate: (config, facts) => {
          const generated = officialRpgContent.generate(config, facts)
          return {
            ...generated,
            gameplay: generated.gameplay!.map(definition => ({
              ...definition,
              afterAction: input => {
                operations.push(input.operationId)
                if (fail && input.operationId === 'activity:resume') throw new Error('resume derivative failed')
                return definition.afterAction?.(input) ?? []
              },
            })),
          }
        },
      },
    ],
  })
  const f = await openRpgWorld(pack, data, { composition })
  cleanup.push(() => f.close())
  await f.move('location:ruin-1')
  expect(operations).not.toContain('activity:start')
  const current = () =>
    (f.events().findLast(event => event.eventType === 'activity.updated')!.data as WorldJsonObject)
      .state as WorldJsonObject
  const act = (operation: string) =>
    f.runtime.activityAction({
      activityKey: 'rpg-map-ruin-1',
      activityId: String(current().id),
      revision: Number(current().revision),
      operation,
      parameters: {},
      requestId: operation,
    })
  await act('suspend')
  expect(operations).toContain('activity:suspend')
  const suspended = f.events()
  fail = true
  await expect(act('resume')).rejects.toMatchObject({ origin: 'plugin', operation: 'afterAction' })
  expect(f.events()).toEqual(suspended)
  fail = false
  await act('resume')
  await f.runtime.escape()
  expect(operations).not.toContain('activity:escape')
})

it('passes the full actor-authorized view to a selected provider combining base scripts and RPG', async () => {
  const { root, pack, data } = copyRpgFixture({
    edit: directory => {
      appendFileSync(
        join(directory, 'scripts/status.js'),
        [
          "statusScript.definition.statuses.push({key:'base-bag',label:'bag',type:'object',schema:{type:'object',properties:{open:{type:'boolean'}},required:['open'],additionalProperties:false},owner:'public',alwaysKnown:true});",
          "statusScript.definition.statuses.push({key:'base-secret',label:'secret',type:'string',owner:'character',alwaysKnown:false});",
          "const originalInit=statusScript.initialize; statusScript.initialize=ids=>{const result=originalInit(ids);result.public['base-bag']={open:true};for(const id of ids) result.characters[id]['base-secret']='PRIVATE_'+id;return result;};",
          "const originalPolicy=statusScript.policy; statusScript.policy=(known,actor,place)=>{if(!known.public['base-bag'].open) return {operations:[]};return originalPolicy(known,actor,place);};",
        ].join('\n'),
      )
    },
  })
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const seen: WorldJsonObject[] = []
  const composition = assembleRoleplay({
    status: {
      id: 'combined-state',
      version: '1',
      open: async (services, signal) => {
        const instance = await officialStatusProvider.open(services, signal)
        const policy = instance.policy.bind(instance)
        instance.policy = (known, actor, place) => {
          if (actor === 'character:player') seen.push(structuredClone(known))
          return policy(known, actor, place)
        }
        return instance
      },
    },
  })
  const f = await openRpgWorld(pack, data, { composition })
  cleanup.push(() => f.close())
  await f.move('location:bedroom')
  seen.length = 0
  await f.runtime.submit('/status rpg-rest {}')
  expect(seen.length).toBeGreaterThan(0)
  for (const known of seen) {
    expect(known.public).toMatchObject({ 'base-bag': { open: true } })
    expect(JSON.stringify(known)).not.toContain('PRIVATE_character:cheng')
    expect(JSON.stringify(known)).not.toContain('PRIVATE_character:mei')
  }
})
