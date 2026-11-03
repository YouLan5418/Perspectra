import type { CharacterTurnRequest } from '@harness-world/application'
import type { StoredWorldEvent } from '@harness-world/contracts'
import type { DecisionInstance, SeamProvider, WorldServices } from '@harness-world/plugin-sdk'
import { auditBeforePublication, type InterventionOptions } from './jev-publication-intervention.ts'
import { JevShadow, type ShadowOptions } from './jev-shadow.ts'

export { createClaimClassifier } from './jev-shadow-claims-client.ts'
export { parseAuditItems, type ShadowOptions } from './jev-shadow.ts'
export type { InterventionOptions } from './jev-publication-intervention.ts'

const eventsThrough = (world: WorldServices, seq: number) =>
  world.world.readEvents(0, seq) as unknown as readonly StoredWorldEvent[]

/** Takes the classifier's key out of the environment so that no plugin can read it there. */
export function takeClaimKey(environment: NodeJS.ProcessEnv): string {
  const key = environment.OPENROUTER_JEV_KEY ?? ''
  delete environment.OPENROUTER_JEV_KEY
  return key
}

/** Checks each publication before it commits and corrects claims about tracked items. An experiment, so it runs
 * characters one at a time and refuses regeneration, whose candidates would send the same text out again. */
export function jevPublicationAudit(options: InterventionOptions): SeamProvider<DecisionInstance> {
  return {
    id: 'official-jev-publication-audit',
    version: '1.0.0',
    open: async world => {
      if (world.candidate) throw new TypeError('外部审计实验不支持隔离候选。')
      return {
        serial: true,
        decide: async (request, next, signal) =>
          auditBeforePublication({
            request: request as unknown as CharacterTurnRequest,
            raw: await next(request),
            history: eventsThrough(world, world.world.head().headSeq),
            options,
            signal,
            decide: revised => next(revised as unknown as typeof request),
          }),
      }
    },
  }
}

/** Audits what was published after the fact and writes a log; it never changes a decision. Only the world the
 * player is on is audited, so a candidate opens with nothing to do. */
export function jevShadowAudit(options: ShadowOptions): SeamProvider<DecisionInstance> {
  return {
    id: 'official-jev-shadow-audit',
    version: '1.0.0',
    open: async world => {
      if (world.candidate) return {}
      if (options.items.some(item => !world.cast.entityIds.includes(item.entityId)))
        throw new TypeError('shadow item is not declared in this Pack')
      let shadow: JevShadow | undefined
      return {
        committed: headSeq => {
          if (shadow) shadow.observe(headSeq)
          else
            shadow = new JevShadow({
              ...options,
              address: world.address,
              characters: [...world.cast.characterNames].map(([characterId, name]) => ({ characterId, name })),
              initialSeq: headSeq,
              readEvents: asOfSeq => eventsThrough(world, asOfSeq),
            })
        },
        debug: () => (shadow ? { shadowAudit: shadow.stats() } : {}),
        close: () => shadow?.close(),
      }
    },
  }
}
