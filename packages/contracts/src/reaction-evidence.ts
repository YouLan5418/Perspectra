import { assertProtocolString } from './ids.ts'
import type { ReactionEvidenceV1, ReactionProfileId, ReactionRoleClass } from './reaction-cycle.ts'
import type { WorldJsonObject, WorldJsonValue } from './world-json.ts'

/**
 * The frozen class order. One table for the whole system: the budget planner ranks candidates by it,
 * v2's evidence says it per stimulus, and the persistence boundary checks a candidate against the
 * strongest of its stimuli. A second copy could drift from the class it stands for.
 */
export const REACTION_ROLE_RANK: { readonly [key in ReactionRoleClass]: number } =
  { direct: 0, addressee: 1, witness: 2, self: 3 }

/**
 * What a Character was to the action that reached them, taken as the strongest of the classes it holds
 * for it. The caller is expected to have every class - a v1 world states none, and asks nobody this.
 */
export function strongestReactionRoleClass(classes: readonly ReactionRoleClass[]): ReactionRoleClass {
  return [...classes].sort((left, right) => REACTION_ROLE_RANK[left] - REACTION_ROLE_RANK[right])[0]!
}

/** The shape both a draft stimulus and a stored stimulus share, which is what the binding is about. */
export interface ReactionEvidenceCarrier {
  readonly observerCharacterId: string
  readonly observationId: string
  readonly sourceEventOrdinal: number
  readonly roleClass?: ReactionRoleClass
  readonly evidence?: ReactionEvidenceV1
}

/**
 * Why one observer was weighed, checked where it becomes durable. The evidence travels into
 * `stimulusEntryHash` and from there into the Cycle's authority, so a self-consistent record that says
 * the wrong thing would be an authority for a reason nobody had: the profile decides whether the record
 * exists at all, and the stimulus - not the evidence - is what it has to agree with.
 *
 * A draft states the class twice, once for the stimulus and once inside the evidence, and the two have
 * to agree; a stored row states it once, inside the evidence, because that is the record this checks.
 */
export function assertReactionEvidenceBinding(input: {
  readonly profileId: ReactionProfileId
  readonly candidateRoleClass: ReactionRoleClass | undefined
  readonly stimuli: readonly ReactionEvidenceCarrier[]
}): void {
  if (input.profileId === 'responsive/v2') {
    const candidate = input.candidateRoleClass
    if (candidate === undefined) throw new TypeError('a responsive/v2 candidate states the class it was weighed by')
    assertRoleClass(candidate, 'candidate.roleClass')
    for (const stimulus of input.stimuli) {
      const evidence = stimulus.evidence
      if (evidence === undefined) throw new TypeError('a responsive/v2 stimulus states why it was weighed')
      // The record's own shape is checked before anything is read off it, and before it is held against
      // the class the stimulus states for itself.
      assertEvidence(evidence, stimulus)
      if (stimulus.roleClass !== undefined && stimulus.roleClass !== evidence.roleClass) {
        throw new TypeError('a stimulus states one class for itself and another in its evidence')
      }
    }
    const strongest = strongestReactionRoleClass(input.stimuli.map(stimulus => stimulus.evidence!.roleClass))
    if (candidate !== strongest) {
      throw new TypeError('a candidate is weighed by the strongest class among its stimuli')
    }
    return
  }
  if (input.candidateRoleClass !== undefined) throw new TypeError('a responsive/v1 candidate states no role class')
  for (const stimulus of input.stimuli) {
    if (stimulus.roleClass !== undefined || stimulus.evidence !== undefined) {
      throw new TypeError('a responsive/v1 stimulus states no role class and no evidence')
    }
  }
}

function assertRoleClass(value: string, name: string): void {
  if (!Object.hasOwn(REACTION_ROLE_RANK, value)) throw new TypeError(`${name} is not one of the frozen classes`)
}

function assertEvidence(evidence: ReactionEvidenceV1, stimulus: ReactionEvidenceCarrier): void {
  const row = object(evidence, 'Reaction evidence')
  exact(row, ['version', 'sourceEventOrdinal', 'observationId', 'observerCharacterId', 'actionId', 'entry', 'roleClass'], 'Reaction evidence')
  if (row.version !== 'reaction-evidence/v1') throw new TypeError('Reaction evidence version is unsupported')
  // The evidence describes this stimulus, not a neighbouring one: the same coordinates, the same
  // observation and the same observer, whatever the class it says it was weighed by.
  if (row.sourceEventOrdinal !== stimulus.sourceEventOrdinal) {
    throw new TypeError('Reaction evidence sourceEventOrdinal diverges from its stimulus')
  }
  if (row.observationId !== stimulus.observationId) {
    throw new TypeError('Reaction evidence observationId diverges from its stimulus')
  }
  if (row.observerCharacterId !== stimulus.observerCharacterId) {
    throw new TypeError('Reaction evidence observer diverges from its stimulus')
  }
  assertRoleClass(row.roleClass as string, 'Reaction evidence roleClass')
  assertProtocolString(row.actionId as string, 'Reaction evidence actionId')
  const entry = object(row.entry, 'Reaction evidence entry')
  if (entry.kind === 'definition') {
    exact(entry, ['kind', 'definitionRef'], 'Reaction evidence entry')
    const definitionRef = object(entry.definitionRef, 'Reaction evidence definitionRef')
    exact(definitionRef, ['id', 'version'], 'Reaction evidence definitionRef')
    assertProtocolString(definitionRef.id as string, 'Reaction evidence definitionRef.id')
    positiveInteger(definitionRef.version, 'Reaction evidence definitionRef.version')
    return
  }
  if (entry.kind !== 'action') throw new TypeError('Reaction evidence entry kind is unsupported')
  exact(entry, ['kind', 'actionType', 'actionVersion'], 'Reaction evidence entry')
  assertProtocolString(entry.actionType as string, 'Reaction evidence actionType')
  positiveInteger(entry.actionVersion, 'Reaction evidence actionVersion')
}

function positiveInteger(value: WorldJsonValue | undefined, name: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${name} must be a positive safe integer`)
}

function object(value: WorldJsonValue | undefined, name: string): WorldJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value as WorldJsonObject
}

function exact(value: WorldJsonObject, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} must have exactly ${expected.join(', ')}`)
  }
}
