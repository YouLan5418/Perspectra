import {
  DRAMATIC_SIGNAL_TYPES,
  assertProtocolString,
  failWorld,
  hashDirectorContext,
  hashWorldJson,
  type ContextExclusion,
  type ContextProfileId,
  type ContextSourceRef,
  type DirectorPlanningContext,
  type DramaticSignal,
  type DramaticSignalType,
  type InteractionRoundId,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import type { CharacterSceneContext } from './context-v2.ts'

const DIRECTOR_SOURCE_KINDS = Object.freeze([
  'scene_public_event', 'director_visible', 'runtime_health', 'runtime_availability',
] as const)

const FORBIDDEN_DIRECTOR_KEYS = new Set([
  'authorTruth', 'latentGuidance', 'rawMemory', 'memoryRecall',
  'privateClaim', 'privateAffect', 'privateTension', 'secret',
])

export interface DirectorVisibleEntry extends WorldJsonObject {
  readonly entryId: string
  readonly value: WorldJsonValue
  readonly sourceRef: ContextSourceRef
}

export interface DirectorDirectiveTargetInput extends WorldJsonObject {
  readonly targetId: string
  readonly sourceRef: ContextSourceRef
}

export interface DirectorSignalInput extends WorldJsonObject {
  readonly signalType: DramaticSignalType
  readonly sourceRefs: readonly ContextSourceRef[]
}

export interface DirectorContextRequest {
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly participantId: string
  readonly controllerId: string
  readonly controllerEpoch: number
  readonly baseHeadSeq: number
  readonly asOfWorldSeq: number
  readonly tick: number
  readonly manifestHash: WorldHash
  readonly contextProfileId: ContextProfileId
  readonly sceneDecision: CharacterSceneContext
  readonly publicEntries: readonly DirectorVisibleEntry[]
  readonly dramaticSignals: readonly DirectorSignalInput[]
  readonly environmentAffordances: readonly string[]
  readonly directiveTargets: readonly DirectorDirectiveTargetInput[]
  readonly correlationId: string
}

export interface DirectorContextAssembly {
  readonly context: DirectorPlanningContext
  readonly includedSourceRefs: readonly ContextSourceRef[]
  readonly exclusions: readonly ContextExclusion[]
  readonly sceneDecisionHash: WorldHash
}

function compareText(left: string, right: string): number {
  return Number(left > right) - Number(left < right)
}

function assertSafeValue(value: WorldJsonValue, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeValue(entry, `${path}[${index}]`))
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_DIRECTOR_KEYS.has(key)) throw new TypeError(`${path}.${key} is forbidden in Director Context`)
    assertSafeValue(child, `${path}.${key}`)
  }
}

function refHash(ref: ContextSourceRef): WorldHash {
  return hashWorldJson('context-source-ref/v1', ref)
}

function validateSource(request: DirectorContextRequest, ref: ContextSourceRef): void {
  if (!(DIRECTOR_SOURCE_KINDS as readonly string[]).includes(ref.sourceKind) || ref.sourceSeq > request.asOfWorldSeq) {
    failWorld({
      errorCode: 'CONTEXT_SOURCE_UNVERIFIED', category: 'integrity',
      message: 'Director Context source is private, unknown, or later than as-of', retryable: false,
      correlationId: request.correlationId, address: request.address, roundId: request.roundId,
      details: { sourceKind: ref.sourceKind, sourceSeq: ref.sourceSeq },
    })
  }
}

function uniqueSorted(values: readonly string[], name: string): string[] {
  values.forEach(value => assertProtocolString(value, name))
  const sorted = [...values].sort(compareText)
  if (new Set(sorted).size !== sorted.length) throw new TypeError(`${name} values must be unique`)
  return sorted
}

function uniqueSources(sources: readonly ContextSourceRef[]): ContextSourceRef[] {
  const values = new Map<WorldHash, ContextSourceRef>()
  for (const source of sources) values.set(refHash(source), source)
  return [...values.values()].sort((left, right) => left.sourceSeq - right.sourceSeq
    || compareText(left.sourceKind, right.sourceKind) || compareText(left.sourceId, right.sourceId))
}

/** Assemble a focal-Scene Director input after public/director-visible filtering, never before it. */
export class DirectorContextAssembler {
  assemble(request: DirectorContextRequest): DirectorPlanningContext {
    return this.assembleDetailed(request).context
  }

  assembleDetailed(request: DirectorContextRequest): DirectorContextAssembly {
    assertProtocolString(request.participantId, 'participantId')
    assertProtocolString(request.controllerId, 'controllerId')
    for (const [name, value] of [
      ['controllerEpoch', request.controllerEpoch], ['baseHeadSeq', request.baseHeadSeq],
      ['asOfWorldSeq', request.asOfWorldSeq], ['tick', request.tick],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`)
    }
    if (request.baseHeadSeq > request.asOfWorldSeq) throw new RangeError('baseHeadSeq cannot be later than asOfWorldSeq')
    if (request.sceneDecision.schemaVersion !== 'scene-decision/v2'
      || request.sceneDecision.sceneId === null || !request.sceneDecision.directorEligible
      || request.sceneDecision.asOfSeq !== request.asOfWorldSeq) {
      failWorld({
        errorCode: 'CONTEXT_SOURCE_UNVERIFIED', category: 'integrity',
        message: 'Director Context requires one eligible focal Scene at the exact watermark', retryable: false,
        correlationId: request.correlationId, address: request.address, roundId: request.roundId,
      })
    }
    const { decisionHash: _decisionHash, ...sceneInput } = request.sceneDecision
    if (request.sceneDecision.decisionHash !== hashWorldJson('scene-decision/v2', sceneInput)) {
      failWorld({
        errorCode: 'CONTEXT_SOURCE_UNVERIFIED', category: 'integrity',
        message: 'Director focal Scene decision Hash is divergent', retryable: false,
        correlationId: request.correlationId, address: request.address, roundId: request.roundId,
      })
    }
    const entries = [...request.publicEntries].sort((left, right) => compareText(left.entryId, right.entryId))
    if (new Set(entries.map(entry => entry.entryId)).size !== entries.length) {
      throw new TypeError('Director public entryId values must be unique')
    }
    for (const [index, entry] of entries.entries()) {
      assertProtocolString(entry.entryId, `publicEntries[${index}].entryId`)
      validateSource(request, entry.sourceRef)
      assertSafeValue(entry.value, `publicEntries[${index}].value`)
    }
    const signals: DramaticSignal[] = request.dramaticSignals.map((signal, index) => {
      if (!(DRAMATIC_SIGNAL_TYPES as readonly string[]).includes(signal.signalType)) {
        throw new TypeError(`dramaticSignals[${index}] has an unknown type`)
      }
      signal.sourceRefs.forEach(ref => validateSource(request, ref))
      return { signalType: signal.signalType, sourceRefs: uniqueSources(signal.sourceRefs) }
    }).sort((left, right) => compareText(left.signalType, right.signalType)
      || compareText(
        hashWorldJson('director-dramatic-signal/v1', left),
        hashWorldJson('director-dramatic-signal/v1', right),
      ))
    const signalKeys = signals.map(signal => hashWorldJson('director-dramatic-signal/v1', signal))
    if (new Set(signalKeys).size !== signalKeys.length) throw new TypeError('Director dramatic signals must be unique')
    const environmentAffordances = uniqueSorted(request.environmentAffordances, 'environmentAffordance')
    const targets = [...request.directiveTargets].sort((left, right) => compareText(left.targetId, right.targetId))
    if (new Set(targets.map(target => target.targetId)).size !== targets.length) {
      throw new TypeError('Director directive targetId values must be unique')
    }
    for (const [index, target] of targets.entries()) {
      assertProtocolString(target.targetId, `directiveTargets[${index}].targetId`)
      validateSource(request, target.sourceRef)
    }
    const base = {
      schemaVersion: 'director-planning/v1' as const,
      address: request.address,
      roundId: request.roundId,
      participantId: request.participantId,
      controllerId: request.controllerId,
      controllerEpoch: request.controllerEpoch,
      baseHeadSeq: request.baseHeadSeq,
      asOfWorldSeq: request.asOfWorldSeq,
      tick: request.tick,
      manifestHash: request.manifestHash,
      focalSceneId: request.sceneDecision.sceneId,
      publicContext: entries,
      dramaticSignals: signals,
      environmentAffordances,
      directiveTargets: targets.map(target => target.targetId),
    }
    const context = { ...base, contextHash: hashDirectorContext(base) }
    return {
      context,
      includedSourceRefs: uniqueSources([
        ...entries.map(entry => entry.sourceRef),
        ...signals.flatMap(signal => signal.sourceRefs),
        ...targets.map(target => target.sourceRef),
      ]),
      exclusions: [],
      sceneDecisionHash: request.sceneDecision.decisionHash,
    }
  }
}
