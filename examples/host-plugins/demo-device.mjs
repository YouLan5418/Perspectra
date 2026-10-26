import { setTimeout as delay } from 'node:timers/promises'

// The lowest host API this plugin needs (packages/plugin-sdk); an older or newer-major host skips it.
export const hostApi = '1.0'

// An in-memory device demonstrates host capabilities without credentials or another installed application.
export default function demoDevice(ctx) {
  const worlds = new Map()
  ctx.provide('demoDevice', {
    worlds: () => [...worlds.keys()],
    requestCharacter: (worldVersion, characterId) => {
      const world = worlds.get(worldVersion)
      if (!world) throw new Error('Demo device world is not attached')
      return world.requestCharacter(characterId)
    },
  })
  const args = { type: 'object', additionalProperties: false, properties: { message: { type: 'string', maxLength: 80 } }, required: ['message'] }
  ctx.effect(() => ctx.capabilities.register({
    id: 'demo-device', version: '0.1.0',
    methods: {
      confirm: { arguments: args, result: { type: 'object', additionalProperties: false, properties: { confirmed: { type: 'boolean' }, actorId: { type: 'string' } }, required: ['confirmed', 'actorId'] }, effect: 'read' },
      queue: { arguments: args, result: { type: 'object', additionalProperties: false, properties: { queued: { type: 'boolean' } }, required: ['queued'] }, effect: 'external' },
    },
    async open(world) {
      worlds.set(world.worldVersion, world)
      return {
        async invoke(method, _args, actorId, signal) {
          await delay(10, undefined, { signal })
          return method === 'queue' ? { completion: 'queued', data: { queued: true } }
            : { completion: 'completed', data: { confirmed: true, actorId } }
        },
        async close() { worlds.delete(world.worldVersion) },
      }
    },
  }))
}
