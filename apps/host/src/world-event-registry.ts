import { Service, type Context } from '@deepseek-ai/cordis'
import { worldEventType, type EventSubscription, type WorldEventsApi } from '@perspectra/sdk'

export interface WorldEventConsumer {
  readonly plugin: string
  readonly subscription: EventSubscription
  readonly signal: AbortSignal
  active(): boolean
}
interface Registration {
  ancestry: number[]
  subscription: EventSubscription
  lifetime: AbortController
}

/** The plugin-facing service receives only subscribe. Cordis binds its method receiver to the caller. */
class WorldEventRegistry extends Service implements WorldEventsApi {
  readonly subscribe: WorldEventsApi['subscribe']
  constructor(ctx: Context, install: (caller: Context, subscription: EventSubscription) => () => void) {
    super(ctx, 'worldEvents')
    this.subscribe = function (this: WorldEventRegistry, subscription) {
      return install(this.ctx, subscription)
    }
  }
}

/** Bind registrations to an installed manifest only after Cordis finishes loading it. */
export function installWorldEventRegistry(root: Context) {
  const entries = new Set<Registration>()
  let sealed = false
  new WorldEventRegistry(root, (ctx, subscription) => {
    if (sealed) throw new TypeError('worldEvents subscriptions must be installed during plugin startup')
    worldEventType(subscription.type)
    if (!['live', 'durable'].includes(subscription.mode) || typeof subscription.open !== 'function')
      throw new TypeError('invalid world event subscription')
    const ancestry: number[] = []
    let fiber = ctx.fiber
    while (fiber.uid !== null && !ancestry.includes(fiber.uid)) {
      ancestry.push(fiber.uid)
      fiber = fiber.parent.fiber
    }
    const entry = {
      ancestry,
      lifetime: new AbortController(),
      subscription: Object.freeze({
        mode: subscription.mode,
        type: subscription.type,
        open: subscription.open.bind(subscription),
      }) as EventSubscription,
    }
    entries.add(entry)
    const remove = () => {
      entries.delete(entry)
      entry.lifetime.abort()
    }
    ctx.effect(() => remove)
    return remove
  })
  return (owners: ReadonlyMap<number, { id: string; allowed: boolean }>): WorldEventConsumer[] => {
    sealed = true
    const keys = new Set<string>()
    return [...entries].map(entry => {
      const uid = entry.ancestry.find(id => owners.has(id))
      const owner = uid === undefined ? undefined : owners.get(uid)
      if (!owner?.allowed)
        throw new TypeError('worldEvents subscription requires an identified enabled plugin with a declared service')
      const key = JSON.stringify([owner.id, entry.subscription.mode, entry.subscription.type])
      if (keys.has(key)) throw new TypeError('duplicate world event subscription')
      keys.add(key)
      return {
        plugin: owner.id,
        subscription: entry.subscription,
        signal: entry.lifetime.signal,
        active: () => entries.has(entry),
      }
    })
  }
}
