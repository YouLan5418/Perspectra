import { assertProtocolString, compareWorldText, type WorldJsonObject } from '@harness-world/contracts'
import type { PlayerActionInput } from '@harness-world/kernel'

export interface IntentReference extends WorldJsonObject {
  readonly id: string
  readonly aliases: readonly string[]
}

export interface InvestigationIntentCatalog {
  readonly characters: readonly IntentReference[]
  readonly entities: readonly IntentReference[]
  readonly evidence: readonly IntentReference[]
}

export interface InvestigationIntentAuthorization {
  readonly characterIds: readonly string[]
  readonly entityIds: readonly string[]
  readonly evidenceIds: readonly string[]
}

export type InvestigationIntentResult =
  | { readonly status: 'resolved'; readonly action: PlayerActionInput }
  | { readonly status: 'clarification_required'; readonly reason: string; readonly candidates: readonly string[] }

type ResolvedReference =
  | { readonly status: 'resolved'; readonly id: string }
  | Extract<InvestigationIntentResult, { readonly status: 'clarification_required' }>

function normalized(value: string): string {
  return value.toLocaleLowerCase('en-US')
}

function naturalTokens(text: string): string[] {
  const inspect = /^检查(?:一下)?\s*(.+)$/u.exec(text)
  if (inspect !== null) return ['inspect', inspect[1]!]
  const ask = /^(?:询问|问)\s*(.+?)\s*(?:关于)\s*(.+)$/u.exec(text)
  if (ask !== null) return ['ask', ask[1]!, ask[2]!]
  const present = /^向\s*(.+?)\s*出示\s*(.+)$/u.exec(text)
  if (present !== null) return ['present', present[2]!, present[1]!]
  const accuse = /^指控\s*(.+?)[，,：:]\s*(.+)$/u.exec(text)
  if (accuse !== null) return ['accuse', accuse[1]!, ...accuse[2]!.split(/[、，,\s]+/u)]
  const command = text.startsWith('/') ? text.slice(1) : text
  return command.split(/\s+/u)
}

/** Whether the input explicitly selects the Demo-owned investigation grammar. */
export function isExplicitInvestigationIntent(text: string): boolean {
  assertProtocolString(text, 'player text')
  const verb = normalized(naturalTokens(text)[0]!)
  return verb === 'inspect' || verb === '检查'
    || verb === 'ask' || verb === '询问' || verb === '问'
    || verb === 'present' || verb === 'present_evidence' || verb === '出示'
    || verb === 'accuse' || verb === '指控'
}

/** Deterministic, no-model adapter from a deliberately narrow text grammar to candidate domain Actions. */
export class DeterministicInvestigationIntentParser {
  constructor(private readonly catalog: InvestigationIntentCatalog) {
    for (const group of [catalog.characters, catalog.entities, catalog.evidence]) {
      const ids = new Set<string>()
      for (const reference of group) {
        assertProtocolString(reference.id, 'intent reference id')
        if (ids.has(reference.id)) throw new TypeError('intent reference ids must be unique within a category')
        ids.add(reference.id)
        if (reference.aliases.length === 0) throw new TypeError('intent reference requires at least one alias')
        for (const alias of reference.aliases) assertProtocolString(alias, 'intent reference alias')
      }
    }
  }

  parse(text: string, authorization?: InvestigationIntentAuthorization): InvestigationIntentResult {
    assertProtocolString(text, 'player text')
    const characters = this.#authorizedReferences(authorization?.characterIds ?? [], this.catalog.characters, 'characterIds')
    const entities = this.#authorizedReferences(authorization?.entityIds ?? [], this.catalog.entities, 'entityIds')
    const evidenceCatalog = this.#authorizedReferences(authorization?.evidenceIds ?? [], this.catalog.evidence, 'evidenceIds')
    const tokens = naturalTokens(text)
    const verb = normalized(tokens[0]!)
    if (verb === 'say' || verb === 'speak' || verb === '说') {
      if (tokens.length < 2) return this.#clarify('speak requires text', [])
      return { status: 'resolved', action: { actionType: 'speak', parameters: { text: tokens.slice(1).join(' ') } } }
    }
    if (verb === 'inspect' || verb === '检查') {
      if (tokens.length !== 2) return this.#clarify('inspect requires exactly one target', entities.map(value => value.id))
      const entity = this.#resolve(tokens[1]!, entities, 'inspection target')
      return entity.status === 'resolved'
        ? { status: 'resolved', action: { actionType: 'inspect', parameters: { entityId: entity.id } } }
        : entity
    }
    if (verb === 'ask' || verb === '询问' || verb === '问') {
      if (tokens.length !== 3) return this.#clarify('ask requires one character and one topic', characters.map(value => value.id))
      const character = this.#resolve(tokens[1]!, characters, 'question target')
      if (character.status !== 'resolved') return character
      const topic = this.#resolve(tokens[2]!, [...entities, ...evidenceCatalog], 'question topic')
      return topic.status === 'resolved'
        ? { status: 'resolved', action: { actionType: 'ask', parameters: { targetCharacterId: character.id, topicId: topic.id } } }
        : topic
    }
    if (verb === 'present' || verb === 'present_evidence' || verb === '出示') {
      if (tokens.length !== 3) return this.#clarify('present requires one evidence and one character', evidenceCatalog.map(value => value.id))
      const evidence = this.#resolve(tokens[1]!, evidenceCatalog, 'evidence')
      if (evidence.status !== 'resolved') return evidence
      const character = this.#resolve(tokens[2]!, characters, 'evidence target')
      return character.status === 'resolved'
        ? { status: 'resolved', action: { actionType: 'present_evidence', parameters: { evidenceId: evidence.id, targetCharacterId: character.id } } }
        : character
    }
    if (verb === 'accuse' || verb === '指控') {
      if (tokens.length < 3) return this.#clarify('accuse requires one suspect and at least one evidence', evidenceCatalog.map(value => value.id))
      const suspect = this.#resolve(tokens[1]!, characters, 'suspect')
      if (suspect.status !== 'resolved') return suspect
      const evidenceIds: string[] = []
      for (const token of tokens.slice(2)) {
        const evidence = this.#resolve(token, evidenceCatalog, 'evidence')
        if (evidence.status !== 'resolved') return evidence
        if (evidenceIds.includes(evidence.id)) return this.#clarify('accuse evidence must be unique', evidenceIds)
        evidenceIds.push(evidence.id)
      }
      return { status: 'resolved', action: { actionType: 'accuse', parameters: { suspectId: suspect.id, evidenceIds } } }
    }
    return this.#clarify('unsupported player intent', ['speak', 'inspect', 'ask', 'present_evidence', 'accuse'])
  }

  #authorizedReferences(
    ids: readonly string[],
    catalog: readonly IntentReference[],
    label: string,
  ): readonly IntentReference[] {
    if (new Set(ids).size !== ids.length) throw new TypeError(`authorized ${label} must be unique`)
    const requested = new Set(ids)
    return catalog.filter(value => requested.has(value.id))
  }

  #resolve(token: string, references: readonly IntentReference[], label: string): ResolvedReference {
    const key = normalized(token)
    const matches = references.filter(reference =>
      normalized(reference.id) === key || reference.aliases.some(alias => normalized(alias) === key))
    if (matches.length === 1) return { status: 'resolved', id: matches[0]!.id }
    return this.#clarify(
      matches.length === 0 ? `${label} is unknown` : `${label} is ambiguous`,
      (matches.length === 0 ? references : matches).map(value => value.id).sort(compareWorldText),
    )
  }

  #clarify(reason: string, candidates: readonly string[]): Extract<InvestigationIntentResult, { status: 'clarification_required' }> {
    return { status: 'clarification_required', reason, candidates: [...candidates].sort(compareWorldText) }
  }
}
