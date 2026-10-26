import Ajv from 'ajv'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { WorldAddress, WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'

export const CAPABILITY_PENDING = 'HOST_CAPABILITY_PENDING'

/** A pack's required capability has no installed provider; the world must not open. */
export class MissingCapabilityError extends TypeError {
  constructor(readonly capability: string) {
    super('Required capability unavailable: ' + capability)
  }
}

export interface CapabilityMethod {
  readonly arguments: WorldJsonObject
  readonly result: WorldJsonObject
  readonly effect: 'read' | 'external'
}
export interface CapabilityOutcome {
  readonly completion: 'completed' | 'queued'
  readonly data: WorldJsonValue
}
export interface CapabilityRequirement {
  readonly id: string
  readonly version: string
  readonly required: boolean
  readonly config: WorldJsonObject
  readonly characters?: readonly string[]
}
export interface CapabilityWorld {
  readonly address: WorldAddress
  readonly worldVersion: string
  /** Bound by the host to the pack's declared NPCs; never accepts caller-supplied Context. */
  readonly requestCharacter: (characterId: string, signal?: AbortSignal) => Promise<WorldJsonObject>
}
export interface CapabilityProvider {
  readonly id: string
  readonly version: string
  readonly methods: Readonly<Record<string, CapabilityMethod>>
  readonly open: (
    world: CapabilityWorld,
    config: WorldJsonObject,
  ) => Promise<{
    invoke(method: string, args: WorldJsonObject, actorId: string, signal: AbortSignal): Promise<CapabilityOutcome>
    close(): Promise<void>
  }>
}
export interface CapabilityCatalog {
  list(): readonly {
    readonly id: string
    readonly version: string
    readonly methods: Readonly<Record<string, CapabilityMethod>>
  }[]
  attach(world: CapabilityWorld, requirements: readonly CapabilityRequirement[]): Promise<CapabilitySession>
}

/** Native providers are trusted. Their game sessions still receive only explicitly bound host operations. */
export class HostCapabilities extends Service implements CapabilityCatalog {
  private readonly providers = new Map<string, CapabilityProvider>()
  private readonly sessions = new Set<CapabilitySession>()
  private closed = false
  constructor(ctx: Context) {
    super(ctx, 'capabilities')
    ctx.effect(() => async () => {
      this.closed = true
      this.providers.clear()
      await Promise.all([...this.sessions].map(session => session.close()))
    })
  }
  readonly register = (provider: CapabilityProvider): (() => Promise<void>) => {
    if (this.closed) throw new Error('Capability catalog is closed')
    if (
      !/^[a-z][a-z0-9-]{0,40}$/u.test(provider.id) ||
      !provider.version ||
      provider.version.length > 80 ||
      typeof provider.open !== 'function' ||
      !Object.keys(provider.methods).length
    )
      throw new TypeError('Invalid capability provider')
    if (this.providers.has(provider.id)) throw new TypeError('Duplicate capability provider: ' + provider.id)
    const ajv = new Ajv({ strict: true })
    for (const [name, method] of Object.entries(provider.methods)) {
      if (
        !/^[a-z][a-z0-9-]{0,40}$/u.test(name) ||
        !['read', 'external'].includes(method.effect) ||
        method.arguments.type !== 'object'
      )
        throw new TypeError('Invalid capability method')
      ajv.compile(method.arguments)
      ajv.compile(method.result)
    }
    const installed = { ...provider, methods: structuredClone(provider.methods) }
    this.providers.set(provider.id, installed)
    return async () => {
      if (this.providers.get(provider.id) !== installed) return
      this.providers.delete(provider.id)
      await Promise.all([...this.sessions].map(session => session.cancelProvider(provider.id)))
    }
  }
  readonly list = () =>
    [...this.providers.values()].map(({ id, version, methods }) => ({ id, version, methods: structuredClone(methods) }))
  readonly attach = async (
    world: CapabilityWorld,
    requirements: readonly CapabilityRequirement[],
  ): Promise<CapabilitySession> => {
    if (this.closed) throw new Error('Capability catalog is closed')
    let session: CapabilitySession | undefined
    session = await CapabilitySession.open(world, requirements, this.providers, () => {
      if (session) this.sessions.delete(session)
    })
    if (this.closed) {
      await session.close()
      throw new Error('Capability catalog is closed')
    }
    this.sessions.add(session)
    return session
  }
}

export class CapabilitySession {
  private readonly bindings = new Map<
    string,
    {
      provider: CapabilityProvider
      service: Awaited<ReturnType<CapabilityProvider['open']>>
      lifetime: AbortController
      characters: readonly string[]
    }
  >()
  private readonly lifetime = new AbortController()
  private closed = false
  private uncertain = false
  private external = false
  private readonly active = new Set<AbortController>()
  private constructor(private readonly disposed: () => void) {}
  static async open(
    world: CapabilityWorld,
    requirements: readonly CapabilityRequirement[],
    providers: ReadonlyMap<string, CapabilityProvider>,
    disposed: () => void,
  ) {
    const session = new CapabilitySession(disposed)
    try {
      for (const requirement of requirements) {
        const provider = providers.get(requirement.id)
        if (!provider || provider.version !== requirement.version) {
          if (requirement.required) throw new MissingCapabilityError(requirement.id + '@' + requirement.version)
          continue
        }
        const lifetime = new AbortController()
        const boundWorld: CapabilityWorld = {
          ...world,
          address: structuredClone(world.address),
          requestCharacter: (characterId, signal) => {
            if (session.closed || lifetime.signal.aborted)
              return Promise.reject(new Error('Capability session is closed'))
            if (!requirement.characters?.includes(characterId))
              return Promise.reject(new TypeError('Character is not bound to this capability'))
            return world.requestCharacter(
              characterId,
              AbortSignal.any([session.lifetime.signal, lifetime.signal, ...(signal ? [signal] : [])]),
            )
          },
        }
        const service = await provider.open(boundWorld, structuredClone(requirement.config))
        if (providers.get(requirement.id) !== provider) {
          await service.close()
          throw new Error('Capability was unloaded during initialization')
        }
        session.bindings.set(requirement.id, {
          provider,
          service,
          lifetime,
          characters: [...(requirement.characters ?? [])],
        })
        session.external ||= Object.values(provider.methods).some(method => method.effect === 'external')
      }
      return session
    } catch (error) {
      await session.close()
      throw error
    }
  }
  get externalEffects(): boolean {
    return this.external
  }
  get resultUnknown(): boolean {
    return this.uncertain
  }
  markUncertain(): void {
    this.uncertain = true
  }
  isExternal(id: string, method: string): boolean {
    return this.bindings.get(id)?.provider.methods[method]?.effect === 'external'
  }
  cancelPending(): void {
    for (const controller of this.active) controller.abort()
  }
  has(id: string, method: string): boolean {
    return (
      !this.closed &&
      !!this.bindings.get(id)?.provider.methods[method] &&
      !this.bindings.get(id)!.lifetime.signal.aborted
    )
  }
  async cancelProvider(id: string): Promise<void> {
    const binding = this.bindings.get(id)
    if (!binding) return
    this.bindings.delete(id)
    binding.lifetime.abort()
    await binding.service.close()
  }
  async invoke(
    id: string,
    method: string,
    args: WorldJsonObject,
    actorId: string,
    signal?: AbortSignal,
  ): Promise<CapabilityOutcome> {
    const binding = this.bindings.get(id),
      spec = binding?.provider.methods[method]
    if (!binding || !spec || !this.has(id, method))
      throw new TypeError('Capability method unavailable: ' + id + '/' + method)
    if (!binding.characters.includes(actorId)) throw new TypeError('Actor is not bound to this capability session')
    if (this.uncertain) throw new Error('EXTERNAL_RESULT_UNKNOWN: inspect the external game before continuing')
    const ajv = new Ajv({ strict: true })
    if (!ajv.compile(spec.arguments)(args)) throw new TypeError('Capability arguments do not match the declared schema')
    const controller = new AbortController()
    const abort = AbortSignal.any([
      controller.signal,
      this.lifetime.signal,
      binding.lifetime.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(10000),
    ])
    abort.throwIfAborted()
    this.active.add(controller)
    let onAbort!: () => void
    try {
      const outcome = await Promise.race([
        binding.service.invoke(method, structuredClone(args), actorId, abort),
        new Promise<never>((_resolve, reject) => {
          onAbort = () =>
            reject(
              new Error(
                spec.effect === 'external'
                  ? 'EXTERNAL_RESULT_UNKNOWN: do not retry automatically'
                  : 'Capability request cancelled',
              ),
            )
          abort.addEventListener('abort', onAbort, { once: true })
          if (abort.aborted) onAbort()
        }),
      ])
      abort.throwIfAborted()
      if (
        !outcome ||
        !['completed', 'queued'].includes(outcome.completion) ||
        !ajv.compile(spec.result)(outcome.data) ||
        JSON.stringify(outcome).length > 65536
      )
        throw new TypeError('Capability returned an invalid outcome')
      return structuredClone(outcome)
    } catch (error) {
      if (spec.effect === 'external') this.uncertain = true
      throw error
    } finally {
      this.active.delete(controller)
      if (onAbort) abort.removeEventListener('abort', onAbort)
    }
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifetime.abort()
    const results = await Promise.allSettled([...this.bindings.values()].map(binding => binding.service.close()))
    this.bindings.clear()
    this.disposed()
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
}
