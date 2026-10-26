import { createRpgMakerBridge } from './rpg-maker/transport.mjs'

// The lowest host API this plugin needs (packages/plugin-sdk); an older or newer-major host skips it.
export const hostApi = '1.0'

// Desktop MZ and this trusted host plugin share only a per-launch token, never model credentials.
export default async function rpgMakerBridge(ctx) {
  const bridge = await createRpgMakerBridge({
    port: Number(process.env.PERSPECTRA_RPG_MAKER_PORT ?? '51013'),
    token: process.env.PERSPECTRA_RPG_MAKER_TOKEN,
  })
  ctx.effect(() => () => bridge.close())
  ctx.provide('rpgMaker', bridge)
  const empty = { type: 'object', additionalProperties: false, properties: {} }
  ctx.effect(() => ctx.capabilities.register({
    id: 'rpg-maker', version: '0.1.0',
    methods: {
      observe: { arguments: empty, result: { type: 'object' }, effect: 'read' },
      'queue-common-event': {
        arguments: { type: 'object', additionalProperties: false, properties: { eventId: { type: 'integer', minimum: 1 } }, required: ['eventId'] },
        result: { type: 'object', additionalProperties: false, properties: { queued: { const: true }, eventId: { type: 'integer', minimum: 1 } }, required: ['queued', 'eventId'] },
        effect: 'external',
      },
    },
    async open(world, config) {
      const actors = config.actors
      if (Object.keys(config).join() !== 'actors' || !actors || typeof actors !== 'object' || Array.isArray(actors) ||
        !Object.keys(actors).length || Object.values(actors).some(id => !Number.isSafeInteger(id) || id < 1) ||
        new Set(Object.values(actors)).size !== Object.keys(actors).length)
        throw new TypeError('RPG Maker requires a unique character-to-actor mapping')
      const unbind = bridge.bindCharacterRequester((actorId, signal) => {
        const characterId = Object.keys(actors).find(id => actors[id] === actorId)
        if (!characterId) throw new TypeError('Actor is not bound to this world')
        return world.requestCharacter(characterId, signal)
      })
      return {
        async invoke(method, args, actorId, signal) {
          signal.throwIfAborted()
          const engineActor = actors[actorId]
          if (!engineActor) throw new TypeError('Character is not mapped to an RPG Maker actor')
          if (method === 'observe') return { completion: 'completed', data: await bridge.observe(engineActor) }
          return { completion: 'queued', data: await bridge.queueCommonEvent(engineActor, args.eventId) }
        },
        async close() { unbind() },
      }
    },
  }))
}
