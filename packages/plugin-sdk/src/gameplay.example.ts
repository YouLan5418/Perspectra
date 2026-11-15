import type { JSONSchemaType } from 'ajv'
import type { ActivityOperation, StatusDefinition } from '@harness-world/contracts'
import { brandId } from '@harness-world/contracts'
import { defineGameplay, defineOperation, type GameplayActivityDefinition } from './gameplay.ts'

export type InvestigationState = {
  readonly energy: number
  readonly clues: readonly string[]
}

export type InvestigationConfig = {
  readonly cluePrefix: string
  readonly maxEnergy: number
}

export type SearchParams = {
  readonly locationId: string
  readonly effort: number
}

export type SearchOutcome = {
  readonly found: boolean
  readonly clueId: string | null
  readonly remainingEnergy: number
}

export type InspectParams = {
  readonly clueId: string
}

export type InspectOutcome = {
  readonly description: string
}

export type InvestigationActivityOutcome =
  | {
      readonly kind: 'search'
      readonly clueId: string | null
    }
  | {
      readonly kind: 'inspect'
      readonly clueId: string
    }

const PLAYER = brandId('character:player', 'CharacterId')

const searchSchema: JSONSchemaType<SearchParams> = {
  type: 'object',
  properties: {
    locationId: { type: 'string', minLength: 1 },
    effort: { type: 'integer', minimum: 1, maximum: 3 },
  },
  required: ['locationId', 'effort'],
  additionalProperties: false,
}

const searchResultSchema: JSONSchemaType<SearchOutcome> = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    clueId: { anyOf: [{ type: 'string' }, { type: 'null', nullable: true }] },
    remainingEnergy: { type: 'integer', minimum: 0 },
  },
  required: ['found', 'clueId', 'remainingEnergy'],
  additionalProperties: false,
}

export const searchOperation = defineOperation<InvestigationState>()({
  id: 'investigation:search',
  argumentSchema: searchSchema,
  resultSchema: searchResultSchema,
  offer: input => {
    const locationId = input.locationId
    // Offers identify authorized targets; resource refusals belong to resolve.
    return !locationId
      ? []
      : [
          {
            id: 'investigation:search:' + locationId,
            label: '搜查当前位置',
            targetId: locationId,
            parameters: { locationId, effort: 1 },
          },
        ]
  },
  resolve: input => {
    if (input.locationId !== undefined && input.locationId !== input.parameters.locationId)
      return { status: 'rejected', rejection: { code: 'NOT_AT_LOCATION', message: '只能搜查当前位置。' } }
    if (input.state.energy < input.parameters.effort) {
      return {
        status: 'rejected',
        rejection: { code: 'INSUFFICIENT_ENERGY', message: '精力不足。' },
      }
    }
    const found = input.parameters.locationId.includes('archive')
    const clueId = found ? 'clue:archive-letter' : null
    const remainingEnergy = input.state.energy - input.parameters.effort
    return {
      status: 'accepted',
      outcome: { found, clueId, remainingEnergy },
      effects: [
        {
          kind: 'status',
          changes: [
            { holderId: input.actorId, key: 'energy', value: remainingEnergy },
            {
              holderId: input.actorId,
              key: 'clues',
              value: [...new Set([...input.state.clues, ...(clueId ? [clueId] : [])])],
            },
          ],
          reveals: [],
          description: '进行了一次搜查。',
        },
      ],
    }
  },
  npc: {
    whenToUse: '需要消耗精力检查当前地点时使用。',
    formatResult: result => (result.outcome.found ? '发现线索 ' + String(result.outcome.clueId) : '没有发现线索。'),
  },
  ui: { label: '搜查', group: '调查', targetKind: 'location' },
})

const inspectSchema: JSONSchemaType<InspectParams> = {
  type: 'object',
  properties: { clueId: { type: 'string', minLength: 1 } },
  required: ['clueId'],
  additionalProperties: false,
}

const inspectResultSchema: JSONSchemaType<InspectOutcome> = {
  type: 'object',
  properties: { description: { type: 'string', minLength: 1 } },
  required: ['description'],
  additionalProperties: false,
}

export const inspectOperation = defineOperation<InvestigationState>()({
  id: 'investigation:inspect',
  argumentSchema: inspectSchema,
  resultSchema: inspectResultSchema,
  offer: input =>
    (input.state.clues ?? []).map(clueId => ({
      id: 'investigation:inspect:' + clueId,
      label: '查看线索',
      targetId: clueId,
      parameters: { clueId },
    })),
  resolve: input =>
    !input.state.clues.includes(input.parameters.clueId)
      ? { status: 'rejected', rejection: { code: 'CLUE_NOT_KNOWN', message: '你没有这条线索。' } }
      : {
          status: 'accepted',
          outcome: { description: '线索 ' + input.parameters.clueId + ' 指向书房。' },
          effects: [],
        },
  npc: {
    whenToUse: '已有线索需要进一步判断时使用。',
    formatResult: result => result.outcome.description,
  },
  ui: { label: '查看线索', group: '调查', targetKind: 'clue' },
})

const configSchema: JSONSchemaType<InvestigationConfig> = {
  type: 'object',
  properties: {
    cluePrefix: { type: 'string', minLength: 1 },
    maxEnergy: { type: 'integer', minimum: 1 },
  },
  required: ['cluePrefix', 'maxEnergy'],
  additionalProperties: false,
}

const activityOperation: ActivityOperation = {
  id: 'search',
  label: '调查现场',
  requiresTurn: true,
  schema: searchSchema,
  quick: false,
}

const investigationActivity: GameplayActivityDefinition<InvestigationActivityOutcome> = {
  key: 'investigation-site',
  title: '现场调查',
  opening: '房间里的灰尘被移动过。',
  operations: [activityOperation],
  resultSchema: {
    anyOf: [
      {
        type: 'object',
        properties: {
          kind: { type: 'string', const: 'search' },
          clueId: { anyOf: [{ type: 'string' }, { type: 'null', nullable: true }] },
        },
        required: ['kind', 'clueId'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { kind: { type: 'string', const: 'inspect' }, clueId: { type: 'string' } },
        required: ['kind', 'clueId'],
        additionalProperties: false,
      },
    ],
  },
  projectResult: input => {
    if (
      input.recipientId !== input.actorId ||
      !input.outcome ||
      typeof input.outcome !== 'object' ||
      Array.isArray(input.outcome)
    )
      return undefined
    const clueId = 'clueId' in input.outcome && typeof input.outcome.clueId === 'string' ? input.outcome.clueId : null
    return input.operationId === 'investigation:search'
      ? { kind: 'search', clueId }
      : clueId
        ? { kind: 'inspect', clueId }
        : undefined
  },
  initialize: input => ({
    id: 'activity:investigation:' + input.random(),
    revision: 1,
    participants: [input.playerId, ...input.participantIds],
    game: {
      active: true,
      phase: 'searching',
      turn: input.playerId,
      round: 1,
      public: { site: 'archive' },
      private: Object.fromEntries([input.playerId, ...input.participantIds].map(characterId => [characterId, {}])),
      internal: {},
    },
  }),
  formatResult: result =>
    result.outcome.kind === 'search'
      ? result.outcome.clueId === null
        ? '这次搜查没有收获。'
        : '发现线索 ' + result.outcome.clueId
      : '查看了线索 ' + result.outcome.clueId,
}

const energyStatus: StatusDefinition = {
  key: 'energy',
  label: '精力',
  type: 'number',
  schema: { type: 'number', minimum: 0 },
  owner: 'character',
  alwaysKnown: true,
  playerTruth: true,
  bar: true,
}

export const investigationGameplay = defineGameplay<
  InvestigationState,
  InvestigationConfig,
  InvestigationActivityOutcome
>()({
  id: 'example:investigation',
  version: '1.0.0',
  requiredServices: ['status', 'activities'],
  dataVersion: 1,
  states: [
    energyStatus,
    {
      key: 'clues',
      label: '已获线索',
      type: 'array',
      schema: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      owner: 'character',
      alwaysKnown: false,
      playerTruth: false,
      bar: false,
    },
  ],
  activities: [investigationActivity],
  operations: [searchOperation, inspectOperation],
  initializeState: input => ({
    public: {},
    characters: Object.fromEntries(input.characterIds.map(id => [id, { energy: input.config.maxEnergy, clues: [] }])),
  }),
  configSchema,
  validateConfig: input =>
    input.entities.some(entity => entity.kind === 'location')
      ? []
      : [{ path: '/locations', message: 'Gameplay requires at least one location.' }],
  playerView: input => ({
    panels: [
      {
        kind: 'property-table',
        id: 'investigation:resources',
        title: '调查状态',
        properties: [
          { key: 'energy', label: '精力', value: input.state.energy ?? 0 },
          { key: 'clueCount', label: '已获线索', value: (input.state.clues ?? []).length },
        ],
      },
      {
        kind: 'entry-list',
        id: 'investigation:clues',
        title: '线索',
        entries: (input.state.clues ?? []).map(clueId => ({
          id: clueId,
          title: '已发现线索',
          content: clueId,
        })),
      },
    ],
  }),
  onCycleEnd: () => [],
})

export const exampleActorId = PLAYER
