import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { canonicalizeWorldJson, type WorldJsonObject } from '@harness-world/contracts'
import type { RulebookResolution, RulebookResolutionContext } from '@harness-world/kernel'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
import {
  CAPABILITY_PENDING,
  MissingCapabilityError,
  type CapabilityCatalog,
  type CapabilityOutcome,
  type CapabilityRequirement,
  type CapabilitySession,
} from '../host-capabilities.ts'
import { actorWorldView } from '@harness-world/application'
import type { StatusRuntime } from './status-runtime.ts'
import { knownStatusView } from '@harness-world/contracts'

const object = (value: unknown): WorldJsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected pack module object')
  return value as WorldJsonObject
}
const name = (value: unknown) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,40}$/u.test(value)
interface Module {
  id: string
  source: string
  characters: string[]
  requirements: CapabilityRequirement[]
  definition: WorldJsonObject
}
interface ExternalAction {
  module: Module
  action: WorldJsonObject
  localId: string
}
export interface ExternalStatusInput {
  operation: string
  actorId: string
  parameters: WorldJsonObject
  asOfWorldSeq: number | undefined
}

/** Pack modules compose existing status rules; native code and asynchronous execution stay in the host. */
export class PackModules {
  readonly requirements: CapabilityRequirement[] = []
  readonly characters = new Set<string>()
  private readonly modules: Module[] = []
  private readonly external = new Map<string, ExternalAction>()
  private staged: (ExternalStatusInput & { outcome: CapabilityOutcome }) | undefined
  private session: CapabilitySession | undefined
  private status: StatusRuntime | undefined
  private awaitingCommit = false
  private catalog: CapabilityCatalog | undefined

  static load(packPath: string, pack: CompiledWorldPackV5, catalog?: CapabilityCatalog): PackModules | undefined {
    if (!pack.assets.some(asset => asset.path === 'plugins.json')) return undefined
    const declaration = object(JSON.parse(lockedPackAsset(packPath, pack, 'plugins.json')))
    if (
      Object.keys(declaration).join() !== 'modules' ||
      !Array.isArray(declaration.modules) ||
      declaration.modules.length > 16
    )
      throw new TypeError('Expected at most 16 pack modules')
    const result = new PackModules(),
      ids = new Set<string>(),
      requirements = new Map<string, CapabilityRequirement>()
    result.catalog = catalog
    for (const value of declaration.modules) {
      const item = object(value)
      if (
        Object.keys(item).sort().join() !== 'capabilities,characters,entry,id' ||
        !name(item.id) ||
        typeof item.entry !== 'string' ||
        !item.entry.startsWith('plugins/') ||
        !item.entry.endsWith('.js') ||
        !Array.isArray(item.characters) ||
        item.characters.some(
          id => typeof id !== 'string' || !pack.content.characters.some(character => character.characterId === id),
        ) ||
        new Set(item.characters).size !== item.characters.length ||
        !Array.isArray(item.capabilities)
      )
        throw new TypeError('Invalid pack module declaration')
      if (ids.has(String(item.id))) throw new TypeError('Duplicate pack module: ' + item.id)
      ids.add(String(item.id))
      const module: Module = {
        id: String(item.id),
        source: lockedPackAsset(packPath, pack, item.entry),
        characters: item.characters as string[],
        requirements: [],
        definition: {},
      }
      for (const value of item.capabilities) {
        const requirement = object(value)
        if (
          Object.keys(requirement).sort().join() !== 'config,id,required,version' ||
          !name(requirement.id) ||
          typeof requirement.version !== 'string' ||
          typeof requirement.required !== 'boolean'
        )
          throw new TypeError('Invalid module capability requirement')
        object(requirement.config)
        const typed = requirement as unknown as CapabilityRequirement,
          prior = requirements.get(typed.id)
        if (
          prior &&
          (prior.version !== typed.version ||
            prior.required !== typed.required ||
            !Buffer.from(canonicalizeWorldJson(prior.config)).equals(Buffer.from(canonicalizeWorldJson(typed.config))))
        )
          throw new TypeError('Conflicting module capability requirement: ' + typed.id)
        requirements.set(typed.id, typed)
        module.requirements.push(typed)
        const installed = catalog
          ?.list()
          .find(provider => provider.id === typed.id && provider.version === typed.version)
        if (!installed && typed.required) throw new MissingCapabilityError(typed.id + '@' + typed.version)
      }
      module.characters.forEach(id => result.characters.add(id))
      result.modules.push(module)
    }
    result.requirements.push(
      ...[...requirements.values()].map(requirement => ({
        ...requirement,
        characters: [
          ...new Set(
            result.modules
              .filter(module => module.requirements.some(r => r.id === requirement.id))
              .flatMap(module => module.characters),
          ),
        ],
      })),
    )
    return result
  }

  /** Locked module texts plus resolved availability; no script is executed by this adapter. */
  get sources(): readonly import('@harness-world/plugin-sdk').StatusModuleSource[] {
    return this.modules.map(module => ({
      id: module.id,
      source: module.source,
      characters: [...module.characters],
      unavailableCapabilities: module.requirements
        .filter(
          requirement =>
            !this.catalog
              ?.list()
              .some(provider => provider.id === requirement.id && provider.version === requirement.version),
        )
        .map(requirement => requirement.id),
    }))
  }
  describe(status: StatusRuntime): void {
    for (const module of this.modules) {
      module.definition = object(status.moduleDefinitions.find(row => row.id === module.id)?.definition)
      const statuses = module.definition.statuses,
        actions = module.definition.actions
      if (
        Object.keys(module.definition).sort().join() !== 'actions,statuses' ||
        !Array.isArray(statuses) ||
        !Array.isArray(actions)
      )
        throw new TypeError('Pack modules declare statuses and actions')
      for (const status of statuses)
        if (!String(object(status).key).startsWith(module.id + '-'))
          throw new TypeError('Module statuses require their module namespace')
      for (const value of actions) {
        const action = object(value),
          id = String(action.id),
          operation = module.id + '-' + id
        if (!name(action.id) || !name(operation)) throw new TypeError('Invalid module action ID')
        if ((action.capability === undefined) !== (action.method === undefined))
          throw new TypeError('Capability and method must be declared together')
        if (action.capability !== undefined) {
          const requirement = module.requirements.find(requirement => requirement.id === action.capability)
          if (!requirement || typeof action.method !== 'string')
            throw new TypeError('Module action uses an undeclared capability')
          const installed = this.catalog
            ?.list()
            .find(provider => provider.id === requirement.id && provider.version === requirement.version)
          if (installed && !installed.methods[action.method])
            throw new TypeError('Module action uses an undeclared capability method')
          this.external.set(operation, { module, action, localId: id })
        }
      }
    }
    this.status = status
  }
  bind(status: StatusRuntime, session: CapabilitySession): void {
    if (this.status !== status) this.describe(status)
    this.session = session
  }
  has(operation: string): boolean {
    return this.external.has(operation)
  }
  committed(): void {
    this.awaitingCommit = false
  }
  failed(): void {
    if (this.awaitingCommit) this.session?.markUncertain()
    this.awaitingCommit = false
  }
  outcome(input: ExternalStatusInput): CapabilityOutcome | undefined {
    return this.staged &&
      this.staged.operation === input.operation &&
      this.staged.actorId === input.actorId &&
      this.staged.asOfWorldSeq === input.asOfWorldSeq &&
      JSON.stringify(this.staged.parameters) === JSON.stringify(input.parameters)
      ? this.staged.outcome
      : undefined
  }
  async execute<T>(
    input: ExternalStatusInput,
    context: RulebookResolutionContext,
    worldPath: string,
    address: import('@harness-world/contracts').WorldAddress,
    signal: AbortSignal | undefined,
    resolve: () => T,
  ): Promise<T> {
    const entry = this.external.get(input.operation)
    if (!entry || !entry.module.characters.includes(input.actorId) || !this.session || !this.status)
      throw new TypeError('Module action unavailable')
    const world = actorWorldView(
      worldPath,
      address,
      context.manifest,
      context.events,
      input.actorId,
      context.asOfWorldSeq,
    )
    const known = knownStatusView(this.status.known(context.events, input.actorId), input.actorId)
    const args = object(
      this.status.prepareModule(
        entry.module.id,
        known as unknown as WorldJsonObject,
        input.actorId,
        entry.localId,
        input.parameters,
        world,
      ),
    )
    const outcome = await this.session.invoke(
      String(entry.action.capability),
      String(entry.action.method),
      args,
      input.actorId,
      signal,
    )
    this.awaitingCommit = this.session.isExternal(String(entry.action.capability), String(entry.action.method))
    this.staged = { ...input, outcome }
    try {
      const result = resolve()
      if (result && typeof result === 'object' && 'status' in result && result.status === 'rejected') this.failed()
      return result
    } catch (error) {
      this.failed()
      throw error
    } finally {
      this.staged = undefined
    }
  }
  async resolveAction(
    context: RulebookResolutionContext,
    worldPath: string,
    address: import('@harness-world/contracts').WorldAddress,
    signal: AbortSignal,
    resolve: () => RulebookResolution,
  ): Promise<RulebookResolution> {
    if (this.session?.resultUnknown)
      throw new Error('EXTERNAL_RESULT_UNKNOWN: inspect the external game before continuing')
    const initial = resolve()
    if (initial.reason !== CAPABILITY_PENDING) return initial
    const parameters = object(context.action.parameters),
      definition = object(parameters.definitionRef)
    return this.execute(
      {
        operation: String(definition.id).slice('status:'.length),
        actorId: String(context.characterId),
        parameters: object(parameters.arguments),
        asOfWorldSeq: context.asOfWorldSeq,
      },
      context,
      worldPath,
      address,
      signal,
      resolve,
    )
  }
}

export function lockedPackAsset(packPath: string, pack: CompiledWorldPackV5, entry: string): string {
  const lock = pack.assets.find(asset => asset.path === entry)
  if (!lock) throw new TypeError('Pack plugin asset is not declared: ' + entry)
  const file = resolve(packPath, entry)
  if (!lstatSync(file).isFile() || relative(realpathSync(packPath), realpathSync(file)).replaceAll('\\', '/') !== entry)
    throw new TypeError('Pack plugin asset must be inside the pack')
  const bytes = readFileSync(file)
  if (
    bytes.length > 65536 ||
    bytes.length !== lock.size ||
    'sha256:' + createHash('sha256').update(bytes).digest('hex') !== lock.contentHash
  )
    throw new TypeError('Pack plugin asset differs from the compiled asset')
  return bytes.toString('utf8')
}
