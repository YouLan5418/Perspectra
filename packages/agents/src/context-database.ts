import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase } from '@harness-world/store-sqlite'

export const CONTEXT_APPLICATION_ID = 0x48435743
export const CONTEXT_SCHEMA_VERSION = 6

const CONTINUITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS continuity_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  namespace_key TEXT NOT NULL,
  as_of_seq INTEGER NOT NULL,
  checkpoint_json TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  UNIQUE(namespace_key, as_of_seq)
);
CREATE INDEX IF NOT EXISTS continuity_checkpoints_prefix
  ON continuity_checkpoints(namespace_key, as_of_seq);
`

const RECEIPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS context_receipts (
  receipt_id TEXT PRIMARY KEY,
  namespace_key TEXT NOT NULL,
  round_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  UNIQUE(namespace_key, round_id, participant_id)
);
CREATE INDEX IF NOT EXISTS context_receipts_round
  ON context_receipts(namespace_key, round_id, participant_id);
`

const PROVIDER_CALL_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_calls (
  model_call_id TEXT PRIMARY KEY,
  namespace_key TEXT NOT NULL,
  round_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  controller_epoch INTEGER NOT NULL CHECK(controller_epoch >= 0),
  context_hash TEXT NOT NULL,
  provider_request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'prepared', 'dispatch_started', 'response_received', 'validated', 'committed',
    'failed_before_dispatch', 'provider_rejected', 'timed_out_ambiguous',
    'invalid_response', 'budget_exhausted', 'discarded_after_quarantine'
  )),
  response_json TEXT,
  response_hash TEXT,
  proposal_json TEXT,
  proposal_hash TEXT,
  terminal_json TEXT,
  transaction_id TEXT,
  authority_hash TEXT,
  UNIQUE(namespace_key, round_id, participant_id),
  CHECK((response_json IS NULL) = (response_hash IS NULL)),
  CHECK((proposal_json IS NULL) = (proposal_hash IS NULL)),
  CHECK((transaction_id IS NULL) = (authority_hash IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS provider_calls_round
  ON provider_calls(namespace_key, round_id, participant_id);
`

const QUALITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_quality_state (
  namespace_key TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  eligible_ticks INTEGER NOT NULL CHECK(eligible_ticks >= 0),
  response_invalid_streak INTEGER NOT NULL CHECK(response_invalid_streak >= 0),
  response_backoff_level INTEGER NOT NULL CHECK(response_backoff_level BETWEEN 0 AND 4),
  response_backoff_remaining INTEGER NOT NULL CHECK(response_backoff_remaining >= 0),
  reflection_invalid_streak INTEGER NOT NULL CHECK(reflection_invalid_streak >= 0),
  reflection_suspension_remaining INTEGER NOT NULL CHECK(reflection_suspension_remaining >= 0),
  state_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, participant_id)
) STRICT;
CREATE TABLE IF NOT EXISTS provider_quality_audit (
  audit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace_key TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  details_json TEXT NOT NULL,
  operational_time_ms INTEGER NOT NULL,
  previous_hash TEXT NOT NULL,
  record_hash TEXT NOT NULL UNIQUE
) STRICT;
CREATE TABLE IF NOT EXISTS provider_quality_outcomes (
  namespace_key TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  outcome_kind TEXT NOT NULL CHECK(outcome_kind IN ('response', 'reflection')),
  outcome_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('valid', 'invalid')),
  PRIMARY KEY(namespace_key, participant_id, outcome_kind, outcome_id)
) STRICT;
CREATE TABLE IF NOT EXISTS provider_quality_ticks (
  namespace_key TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  response_mode TEXT NOT NULL CHECK(response_mode IN ('normal', 'skip', 'probe')),
  reflection_mode TEXT NOT NULL CHECK(reflection_mode IN ('normal', 'suspended', 'probe')),
  PRIMARY KEY(namespace_key, participant_id, round_id)
) STRICT;
`

const COMPLETE_CONTEXT_SCHEMA = [
  CONTINUITY_SCHEMA,
  RECEIPT_SCHEMA,
  PROVIDER_CALL_SCHEMA,
  QUALITY_SCHEMA,
].join('\n')

const PROVIDER_CALL_V2_SCHEMA = `
ALTER TABLE provider_calls RENAME TO provider_calls_legacy;
DROP INDEX provider_calls_round;
${PROVIDER_CALL_SCHEMA.replace('round_id TEXT NOT NULL', 'round_id TEXT')
  .replace('participant_id TEXT NOT NULL', 'participant_id TEXT')
  .replace('receipt_id TEXT NOT NULL', 'receipt_id TEXT')
  .replace('model_call_id TEXT PRIMARY KEY,', `model_call_id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL DEFAULT 'round_participant' CHECK(purpose IN ('round_participant','player_intent')),
    work_id TEXT,
    request_json TEXT,`)}
INSERT INTO provider_calls SELECT model_call_id, 'round_participant', model_call_id, NULL,
  namespace_key,round_id,participant_id,receipt_id,receipt_hash,controller_epoch,context_hash,provider_request_hash,
  state,response_json,response_hash,proposal_json,proposal_hash,terminal_json,transaction_id,authority_hash FROM provider_calls_legacy;
DROP TABLE provider_calls_legacy;
CREATE UNIQUE INDEX provider_calls_work ON provider_calls(namespace_key,purpose,work_id);
CREATE TABLE player_intent_late_responses(model_call_id TEXT NOT NULL,response_hash TEXT NOT NULL,
  PRIMARY KEY(model_call_id,response_hash)) STRICT;
`

/**
 * Open the rebuildable Context database through one forward-only schema axis.
 *
 * Version 5 deliberately repeats every CREATE IF NOT EXISTS statement. Before this
 * catalog existed, opening one component in isolation could advance user_version
 * while leaving earlier component tables absent. The repair migration preserves
 * existing rows and makes every legacy 0.3.0 layout structurally complete.
 */
export function openContextDatabase(path: string): DatabaseSync {
  return openMigratedDatabase(path, CONTEXT_APPLICATION_ID, [
    { version: 1, sql: CONTINUITY_SCHEMA },
    { version: 2, sql: RECEIPT_SCHEMA },
    { version: 3, sql: PROVIDER_CALL_SCHEMA },
    { version: 4, sql: QUALITY_SCHEMA },
    { version: 5, sql: COMPLETE_CONTEXT_SCHEMA },
    { version: CONTEXT_SCHEMA_VERSION, sql: PROVIDER_CALL_V2_SCHEMA },
  ])
}
