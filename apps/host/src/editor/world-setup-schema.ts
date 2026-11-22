import {
  AWARENESS_LEVELS,
  CLAIM_STANCES,
  GOAL_OBJECTIVE_KINDS,
  GOAL_STATUSES,
  RELATIONSHIP_TYPES,
  RELATIONSHIP_STATUSES,
  AFFECT_TYPES,
  AFFECT_EXPRESSION_MODES,
  AFFECT_DURATIONS,
  AFFECT_STATUSES,
  TENSION_POLE_TENDENCIES,
  TENSION_STATUSES,
  COMMITMENT_ORIGINS,
  COMMITMENT_STATUSES,
  OPEN_LOOP_KINDS,
  OPEN_LOOP_STATUSES,
} from '@perspectra/sdk/contracts'
import {
  WORLD_PACK_INITIAL_OBSERVATION_EPISTEMIC_KINDS_V2,
  WORLD_PACK_MEMORY_PROFILES_V2,
} from '@perspectra/world-pack'
import type { ConfigField } from '@perspectra/world-pack/editor-config'
const text: ConfigField = { type: 'string' },
  free: ConfigField = {},
  scale: ConfigField = { type: 'integer', minimum: 0, maximum: 1000 }
const list = (items: ConfigField): ConfigField => ({ type: 'array', items })
const choices = (items: readonly string[]): ConfigField => ({ enum: [...items] })
const object = (properties: Record<string, ConfigField>, required: string[] = []): ConfigField => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const texts = list(text),
  awareness = choices(AWARENESS_LEVELS),
  basisKeys = texts,
  key = text
const terms = list(object({ key, text }, ['key', 'text']))
export const setupSchemas = {
  world: object(
    {
      title: text,
      description: text,
      roundQueueLimit: { type: 'integer', minimum: 1, maximum: 1024 },
      playerInputPolicy: object({ version: choices(['legacy-speech/v1', 'player-intent/v1']) }, ['version']),
      initialFacts: list(
        object({ factId: text, proposition: free, initialAudience: { ...texts, minItems: 1 } }, [
          'factId',
          'proposition',
          'initialAudience',
        ]),
      ),
    },
    ['title'],
  ),
  portrayal: object({ summary: text, speakingStyle: text, backgroundTextRef: text, drives: terms, principles: terms }),
  memory: object({ profile: choices(WORLD_PACK_MEMORY_PROFILES_V2), attentionTopics: texts }, ['profile']),
  cognition: object({
    observations: list(
      object(
        {
          key,
          content: free,
          epistemicKind: choices(WORLD_PACK_INITIAL_OBSERVATION_EPISTEMIC_KINDS_V2),
          saliencePermille: scale,
          basisKeys,
        },
        ['key', 'content', 'epistemicKind'],
      ),
    ),
    claims: list(
      object(
        {
          key,
          proposition: free,
          stance: choices(CLAIM_STANCES),
          confidencePermille: scale,
          saliencePermille: scale,
          awareness,
          status: { const: 'active' },
          basisKeys,
        },
        ['key', 'proposition', 'stance', 'confidencePermille'],
      ),
    ),
    goals: list(
      object(
        {
          key,
          objective: object({ kind: choices(GOAL_OBJECTIVE_KINDS), value: free }, ['kind', 'value']),
          priorityPermille: scale,
          awareness,
          status: choices(GOAL_STATUSES),
          parentGoalKey: text,
          targetKeys: texts,
          blockerKeys: texts,
          basisKeys,
        },
        ['key', 'objective'],
      ),
    ),
    relationships: list(
      object(
        {
          key,
          target: text,
          type: choices(RELATIONSHIP_TYPES),
          facet: text,
          intensityPermille: scale,
          confidencePermille: scale,
          awareness,
          status: choices(RELATIONSHIP_STATUSES),
          basisKeys,
        },
        ['key', 'target', 'type', 'facet', 'intensityPermille'],
      ),
    ),
    affects: list(
      object(
        {
          key,
          type: choices(AFFECT_TYPES),
          intensityPermille: scale,
          cause: free,
          targetKey: text,
          awareness,
          expressionMode: choices(AFFECT_EXPRESSION_MODES),
          duration: choices(AFFECT_DURATIONS),
          status: choices(AFFECT_STATUSES),
          basisKeys,
        },
        ['key', 'type', 'intensityPermille', 'cause'],
      ),
    ),
    innerTensions: list(
      object(
        {
          key,
          title: text,
          pressurePermille: scale,
          poles: {
            ...list(
              object(
                {
                  key,
                  tendency: choices(TENSION_POLE_TENDENCIES),
                  impulseText: text,
                  strengthPermille: scale,
                  awareness,
                  basisKeys,
                },
                ['key', 'tendency', 'impulseText', 'strengthPermille', 'awareness'],
              ),
            ),
            minItems: 2,
            maxItems: 4,
          },
          awareness,
          status: choices(TENSION_STATUSES),
          basisKeys,
        },
        ['key', 'title', 'pressurePermille', 'poles'],
      ),
    ),
    commitments: list(
      object(
        {
          key,
          content: free,
          origin: choices(COMMITMENT_ORIGINS),
          saliencePermille: scale,
          awareness: choices(AWARENESS_LEVELS.filter(v => v !== 'unrecognized')),
          status: choices(COMMITMENT_STATUSES),
          basisKeys,
        },
        ['key', 'content', 'origin'],
      ),
    ),
    openLoops: list(
      object(
        {
          key,
          kind: choices(OPEN_LOOP_KINDS),
          summary: text,
          saliencePermille: scale,
          status: choices(OPEN_LOOP_STATUSES),
          basisKeys,
        },
        ['key', 'kind', 'summary'],
      ),
    ),
  }),
}
