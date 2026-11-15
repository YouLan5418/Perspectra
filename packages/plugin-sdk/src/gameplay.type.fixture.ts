import type { JSONSchemaType } from 'ajv'
import type { ActionAffordance, WorldJsonObject } from '@harness-world/contracts'
import {
  defineGameplay,
  defineOperation,
  type GameplayDefinition,
  type OperationDefinition,
  type OperationOfferInput,
  type OperationResolveInput,
  type OperationResultProjection,
} from './gameplay.ts'
import {
  exampleActorId,
  investigationGameplay,
  searchOperation,
  type InvestigationActivityOutcome,
  type InvestigationConfig,
  type InvestigationState,
  type SearchOutcome,
  type SearchParams,
} from './gameplay.example.ts'

interface ProjectionState extends WorldJsonObject {
  readonly energy: number
}

interface NarrowState extends WorldJsonObject {
  readonly energy: number
  readonly requiredSecret: string
}

const candidate: ActionAffordance = { actionType: 'interact', actionVersion: 1 }
const offerInput: OperationOfferInput<InvestigationState> = {
  actorId: exampleActorId,
  state: { energy: 2, clues: [] },
  candidates: [candidate],
}
const resolveInput: OperationResolveInput<SearchParams, InvestigationState> = {
  compute: () => {
    throw new Error('no registered method in a type fixture')
  },
  actorId: exampleActorId,
  parameters: { locationId: 'location:archive', effort: 1 },
  state: { energy: 2, clues: [] },
}
const recipientInput: OperationResultProjection<SearchOutcome> = {
  actorId: exampleActorId,
  recipientId: exampleActorId,
  outcome: { found: false, clueId: null, remainingEnergy: 1 },
}

// @ts-expect-error resolve input is trusted and cannot stand in for the authorized offer input
searchOperation.offer?.(resolveInput)
// @ts-expect-error offer input has no validated parameters and cannot enter resolve
searchOperation.resolve(offerInput)
// @ts-expect-error the result formatter receives only the recipient projection
searchOperation.npc?.formatResult(resolveInput)
searchOperation.npc?.formatResult(recipientInput)

const compatibleProjectionOperation = defineOperation<ProjectionState>()({
  id: 'fixture:compatible-projection',
  argumentSchema: searchOperation.argumentSchema,
  resultSchema: searchOperation.resultSchema,
  resolve: input => ({
    status: 'accepted',
    outcome: { found: input.state.energy > 0, clueId: null, remainingEnergy: input.state.energy },
    effects: [],
  }),
})

const compatibleProjectionCollection: GameplayDefinition<
  InvestigationState,
  readonly [typeof compatibleProjectionOperation],
  InvestigationConfig,
  InvestigationActivityOutcome
> = {
  ...investigationGameplay,
  operations: [compatibleProjectionOperation],
}

const narrowStateOperation = defineOperation<NarrowState>()({
  id: 'fixture:other-state',
  argumentSchema: searchOperation.argumentSchema,
  resultSchema: searchOperation.resultSchema,
  resolve: input => ({
    status: 'accepted',
    outcome: { found: input.state.energy > 0, clueId: null, remainingEnergy: input.state.energy },
    effects: [],
  }),
})

const wrongStateCollection: GameplayDefinition<
  InvestigationState,
  readonly [typeof narrowStateOperation],
  InvestigationConfig,
  InvestigationActivityOutcome
> = {
  ...investigationGameplay,
  // @ts-expect-error the operation requires a field absent from the gameplay state
  operations: [narrowStateOperation],
}

const wrongResult: OperationDefinition<SearchParams, InvestigationState, SearchOutcome> = {
  ...searchOperation,
  id: 'fixture:wrong-result',
  resolve: () => ({
    status: 'accepted',
    // @ts-expect-error an inspect result is not a search result
    outcome: { description: 'not a search outcome' },
    effects: [],
  }),
}

// @ts-expect-error clueId is a string, not a number
const wrongSchema: JSONSchemaType<{ readonly clueId: string }> = {
  type: 'object',
  properties: { clueId: { type: 'number' } },
  required: ['clueId'],
  additionalProperties: false,
}

const wrongOperationCollection = defineGameplay<
  InvestigationState,
  InvestigationConfig,
  InvestigationActivityOutcome
>()({
  ...investigationGameplay,
  // @ts-expect-error the inspect schema cannot satisfy the search operation slot
  operations: [searchOperation, { ...searchOperation, argumentSchema: wrongSchema }],
})

const collectionSearch = investigationGameplay.operations[0]
const collectionInspect = investigationGameplay.operations[1]
collectionSearch.resolve({
  compute: resolveInput.compute,
  actorId: exampleActorId,
  // @ts-expect-error the first heterogeneous tuple slot keeps SearchParams after joining gameplay
  parameters: { clueId: 'clue:archive-letter' },
  state: { energy: 2, clues: [] },
})
collectionInspect.resolve({
  compute: resolveInput.compute,
  actorId: exampleActorId,
  // @ts-expect-error the second heterogeneous tuple slot keeps InspectParams after joining gameplay
  parameters: { locationId: 'location:archive', effort: 1 },
  state: { energy: 2, clues: [] },
})

function narrowResolveFixture(): void {
  const narrowResolve: OperationDefinition<SearchParams, InvestigationState, SearchOutcome> = {
    ...searchOperation,
    id: 'fixture:narrow-resolve',
    // @ts-expect-error the trusted callback cannot require a field the host does not supply
    resolve: (input: OperationResolveInput<SearchParams, InvestigationState> & { readonly internal: string }) => ({
      status: 'accepted',
      outcome: {
        found: input.internal.length > 0,
        clueId: null,
        remainingEnergy: input.state.energy,
      },
      effects: [],
    }),
  }
  void narrowResolve
}

void narrowResolveFixture
void offerInput
void compatibleProjectionCollection
void wrongStateCollection
void wrongResult
void wrongSchema
void wrongOperationCollection
