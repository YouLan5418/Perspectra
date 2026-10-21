import type { DatabaseSync } from 'node:sqlite'
import { PLAYER_INPUT_SCHEMA } from './player-input-schema.ts'
import { openMigratedDatabase, WORLD_APPLICATION_ID } from './sqlite.ts'

/**
 * The world database schema as forward-only migrations. Each constant is the SQL one version added;
 * openWorldDatabase applies whatever an existing file has not seen yet.
 */
export const WORLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS branches (
  address_key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  parent_address_key TEXT,
  fork_seq INTEGER,
  UNIQUE(tenant_id, world_id, branch_id),
  FOREIGN KEY(parent_address_key) REFERENCES branches(address_key),
  CHECK ((parent_address_key IS NULL AND fork_seq IS NULL) OR (parent_address_key IS NOT NULL AND fork_seq >= 0))
) STRICT;
CREATE TABLE IF NOT EXISTS heads (
  address_key TEXT PRIMARY KEY,
  head_seq INTEGER NOT NULL CHECK(head_seq >= 0),
  tick INTEGER NOT NULL CHECK(tick >= 0),
  event_hash TEXT NOT NULL,
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
CREATE TABLE IF NOT EXISTS round_commits (
  transaction_id TEXT PRIMARY KEY,
  address_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  round_id TEXT NOT NULL,
  base_head_seq INTEGER NOT NULL,
  base_tick INTEGER NOT NULL,
  head_seq INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  bundle_hash TEXT NOT NULL,
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
CREATE TABLE IF NOT EXISTS events (
  address_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  event_ordinal INTEGER NOT NULL,
  PRIMARY KEY(address_key, seq),
  UNIQUE(transaction_id, event_ordinal),
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  FOREIGN KEY(transaction_id) REFERENCES round_commits(transaction_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE IF NOT EXISTS outbox (
  delivery_id TEXT PRIMARY KEY,
  address_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  world_seq INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  critical INTEGER NOT NULL CHECK(critical IN (0, 1)),
  transaction_id TEXT NOT NULL,
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  FOREIGN KEY(transaction_id) REFERENCES round_commits(transaction_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
`

const WORLD_LEASE_SCHEMA = `
CREATE TABLE writer_lease_counters (
  address_key TEXT PRIMARY KEY,
  next_fencing_token INTEGER NOT NULL CHECK(next_fencing_token >= 1),
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
CREATE TABLE writer_leases (
  address_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK(fencing_token >= 1),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
`

const WORLD_ACTIVATION_SCHEMA = `
CREATE TABLE world_manifests (
  manifest_hash TEXT PRIMARY KEY,
  manifest_json TEXT NOT NULL
) STRICT;
CREATE TABLE branch_activations (
  address_key TEXT PRIMARY KEY,
  activation_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  genesis_hash TEXT NOT NULL,
  transaction_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  FOREIGN KEY(manifest_hash) REFERENCES world_manifests(manifest_hash),
  FOREIGN KEY(transaction_id) REFERENCES round_commits(transaction_id)
) STRICT;
`

const WORLD_ROUND_INBOX_SCHEMA = `
CREATE TABLE round_inbox_counters (
  address_key TEXT PRIMARY KEY,
  next_inbox_seq INTEGER NOT NULL CHECK(next_inbox_seq >= 1),
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
CREATE TABLE round_inbox (
  address_key TEXT NOT NULL,
  inbox_seq INTEGER NOT NULL CHECK(inbox_seq >= 1),
  idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'completed')),
  claim_owner_id TEXT,
  claim_fencing_token INTEGER,
  result_hash TEXT,
  result_json TEXT,
  PRIMARY KEY(address_key, inbox_seq),
  UNIQUE(address_key, idempotency_key),
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  CHECK (
    (status = 'pending' AND claim_owner_id IS NULL AND claim_fencing_token IS NULL AND result_hash IS NULL AND result_json IS NULL)
    OR (status = 'claimed' AND claim_owner_id IS NOT NULL AND claim_fencing_token >= 1 AND result_hash IS NULL AND result_json IS NULL)
    OR (status = 'completed' AND claim_owner_id IS NOT NULL AND claim_fencing_token >= 1 AND result_hash IS NOT NULL AND result_json IS NOT NULL)
  )
) STRICT;
`

const WORLD_OUTBOX_DELIVERY_SCHEMA = `
ALTER TABLE outbox ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'
  CHECK(delivery_status IN ('pending', 'inflight', 'delivered', 'dead_letter'));
ALTER TABLE outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0);
ALTER TABLE outbox ADD COLUMN session_delivery_seq INTEGER CHECK(session_delivery_seq > 0);
ALTER TABLE outbox ADD COLUMN last_error TEXT;
CREATE TABLE outbox_session_counters (
  session_id TEXT PRIMARY KEY,
  next_delivery_seq INTEGER NOT NULL CHECK(next_delivery_seq >= 1)
) STRICT;
CREATE TABLE outbox_delivery_receipts (
  delivery_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  session_delivery_seq INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  FOREIGN KEY(delivery_id) REFERENCES outbox(delivery_id)
) STRICT;
`

const WORLD_BRANCH_ADMIN_SCHEMA = `
CREATE TABLE branch_controls (
  address_key TEXT PRIMARY KEY,
  admission_state TEXT NOT NULL CHECK(admission_state IN ('open', 'draining')),
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('active', 'archived')),
  reason TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
INSERT INTO branch_controls(address_key, admission_state, lifecycle_state, reason, revision)
SELECT address_key, 'open', 'active', NULL, 0 FROM branches;
CREATE TABLE branch_audit_events (
  audit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  address_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  operational_time_ms INTEGER NOT NULL CHECK(operational_time_ms >= 0),
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
`

const WORLD_OUTBOX_CLAIM_SCHEMA = `
ALTER TABLE outbox ADD COLUMN claim_owner_id TEXT;
ALTER TABLE outbox ADD COLUMN claim_token TEXT;
ALTER TABLE outbox ADD COLUMN claim_expires_at_ms INTEGER CHECK(claim_expires_at_ms >= 0);
CREATE UNIQUE INDEX outbox_claim_token_unique ON outbox(claim_token) WHERE claim_token IS NOT NULL;
`

const WORLD_ROUND_COMPLETION_SCHEMA = `
ALTER TABLE round_inbox ADD COLUMN commit_transaction_id TEXT;
ALTER TABLE round_inbox ADD COLUMN commit_bundle_hash TEXT;
CREATE UNIQUE INDEX round_inbox_commit_transaction_unique
  ON round_inbox(commit_transaction_id) WHERE commit_transaction_id IS NOT NULL;
`

const WORLD_QUARANTINE_SCHEMA = `
ALTER TABLE branch_controls ADD COLUMN runtime_phase TEXT NOT NULL DEFAULT 'active'
  CHECK(runtime_phase IN ('active', 'maintenance', 'quarantined', 'archived'));
ALTER TABLE branch_controls ADD COLUMN runtime_epoch INTEGER NOT NULL DEFAULT 0 CHECK(runtime_epoch >= 0);
UPDATE branch_controls SET runtime_phase = 'archived' WHERE lifecycle_state = 'archived';
CREATE TABLE branch_failures (
  failure_id TEXT PRIMARY KEY,
  address_key TEXT NOT NULL,
  error_hash TEXT NOT NULL,
  error_json TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open', 'recovered')),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  recovered_at_ms INTEGER,
  recovery_correlation_id TEXT,
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  CHECK (
    (status = 'open' AND recovered_at_ms IS NULL AND recovery_correlation_id IS NULL)
    OR (status = 'recovered' AND recovered_at_ms >= occurred_at_ms AND recovery_correlation_id IS NOT NULL)
  )
) STRICT;
CREATE INDEX branch_failures_address_status ON branch_failures(address_key, status, occurred_at_ms);
ALTER TABLE round_inbox RENAME TO round_inbox_v8;
CREATE TABLE round_inbox (
  address_key TEXT NOT NULL,
  inbox_seq INTEGER NOT NULL CHECK(inbox_seq >= 1),
  idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'completed', 'failed', 'cancelled')),
  claim_owner_id TEXT,
  claim_fencing_token INTEGER,
  result_hash TEXT,
  result_json TEXT,
  commit_transaction_id TEXT,
  commit_bundle_hash TEXT,
  PRIMARY KEY(address_key, inbox_seq),
  UNIQUE(address_key, idempotency_key),
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  CHECK (
    (status = 'pending' AND claim_owner_id IS NULL AND claim_fencing_token IS NULL
      AND result_hash IS NULL AND result_json IS NULL AND commit_transaction_id IS NULL AND commit_bundle_hash IS NULL)
    OR (status = 'claimed' AND claim_owner_id IS NOT NULL AND claim_fencing_token >= 1
      AND result_hash IS NULL AND result_json IS NULL AND commit_bundle_hash IS NULL)
    OR (status = 'completed' AND claim_owner_id IS NOT NULL AND claim_fencing_token >= 1
      AND result_hash IS NOT NULL AND result_json IS NOT NULL AND commit_transaction_id IS NOT NULL AND commit_bundle_hash IS NOT NULL)
    OR (status IN ('failed', 'cancelled') AND result_hash IS NOT NULL AND result_json IS NOT NULL
      AND commit_transaction_id IS NULL AND commit_bundle_hash IS NULL
      AND ((claim_owner_id IS NULL AND claim_fencing_token IS NULL)
        OR (claim_owner_id IS NOT NULL AND claim_fencing_token >= 1)))
  )
) STRICT;
INSERT INTO round_inbox(
  address_key, inbox_seq, idempotency_key, input_hash, principal_id, input_json, status,
  claim_owner_id, claim_fencing_token, result_hash, result_json, commit_transaction_id, commit_bundle_hash
)
SELECT address_key, inbox_seq, idempotency_key, input_hash, principal_id, input_json, status,
  claim_owner_id, claim_fencing_token, result_hash, result_json, commit_transaction_id, commit_bundle_hash
FROM round_inbox_v8;
DROP TABLE round_inbox_v8;
CREATE UNIQUE INDEX round_inbox_commit_transaction_unique
  ON round_inbox(commit_transaction_id) WHERE commit_transaction_id IS NOT NULL;
`

const WORLD_CHARACTER_RUNTIME_SCHEMA = `
CREATE TABLE character_runtime_availability (
  address_key TEXT NOT NULL,
  character_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'provisioning', 'ready', 'session_lag', 'model_unavailable', 'budget_unavailable', 'offline', 'disabled'
  )),
  reason TEXT,
  changed_at_ms INTEGER NOT NULL CHECK(changed_at_ms >= 0),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  PRIMARY KEY(address_key, character_id),
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
`

const WORLD_ROUND_AUTHORITY_SCHEMA = `
ALTER TABLE round_commits ADD COLUMN authority_hash TEXT;
CREATE TABLE round_authority (
  transaction_id TEXT PRIMARY KEY,
  address_key TEXT NOT NULL,
  round_id TEXT NOT NULL,
  authority_hash TEXT NOT NULL,
  authority_json TEXT NOT NULL,
  FOREIGN KEY(transaction_id) REFERENCES round_commits(transaction_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
CREATE INDEX round_authority_address_round ON round_authority(address_key, round_id);
`

const WORLD_COGNITIVE_JOB_SCHEMA = `
CREATE TABLE world_cognitive_jobs (
  job_id TEXT PRIMARY KEY,
  address_key TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  as_of_seq INTEGER NOT NULL CHECK(as_of_seq >= 0),
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
  last_error TEXT,
  job_hash TEXT NOT NULL,
  UNIQUE(address_key, transaction_id, character_id),
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  FOREIGN KEY(transaction_id) REFERENCES round_commits(transaction_id)
) STRICT;
CREATE INDEX world_cognitive_jobs_pending
  ON world_cognitive_jobs(address_key, status, as_of_seq, character_id);
`

const WORLD_CLARIFICATION_SCHEMA = `
CREATE TABLE round_clarifications (
  address_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  operational_time_ms INTEGER NOT NULL CHECK(operational_time_ms >= 0),
  PRIMARY KEY(address_key, idempotency_key),
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
`

const WORLD_OUTBOX_RETRY_SCHEMA = `
ALTER TABLE outbox ADD COLUMN first_attempt_at_ms INTEGER CHECK(first_attempt_at_ms >= 0);
ALTER TABLE outbox ADD COLUMN next_attempt_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(next_attempt_at_ms >= 0);
CREATE INDEX outbox_retry_schedule ON outbox(address_key, delivery_status, next_attempt_at_ms, world_seq);
`

const WORLD_PROVIDER_OUTPUT_AVAILABILITY_SCHEMA = `
ALTER TABLE character_runtime_availability RENAME TO character_runtime_availability_v14;
CREATE TABLE character_runtime_availability (
  address_key TEXT NOT NULL,
  character_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'provisioning', 'ready', 'session_lag', 'model_unavailable', 'provider_output_invalid',
    'budget_unavailable', 'offline', 'disabled'
  )),
  reason TEXT,
  changed_at_ms INTEGER NOT NULL CHECK(changed_at_ms >= 0),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  PRIMARY KEY(address_key, character_id),
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
INSERT INTO character_runtime_availability(address_key, character_id, state, reason, changed_at_ms, revision)
SELECT address_key, character_id, state, reason, changed_at_ms, revision
FROM character_runtime_availability_v14;
DROP TABLE character_runtime_availability_v14;
`

/** Migration history only: v20 drops these tables (see WORLD_RETIRE_REACTION_SCHEMA). */
const WORLD_REACTION_SCHEMA = `
CREATE TABLE world_reaction_cycles (
  cycle_id TEXT PRIMARY KEY,
  address_key TEXT NOT NULL,
  root_round_id TEXT NOT NULL,
  root_transaction_id TEXT NOT NULL UNIQUE,
  created_at_seq INTEGER NOT NULL CHECK(created_at_seq >= 0),
  policy_version TEXT NOT NULL CHECK(policy_version = 'reaction-policy/v1'),
  profile_id TEXT NOT NULL,
  max_waves INTEGER NOT NULL CHECK(max_waves BETWEEN 1 AND 3),
  max_npc_calls INTEGER NOT NULL CHECK(max_npc_calls BETWEEN 1 AND 8),
  max_calls_per_character INTEGER NOT NULL CHECK(max_calls_per_character BETWEEN 1 AND 2),
  max_actions_per_call INTEGER NOT NULL CHECK(max_actions_per_call = 1),
  allowed_action_types_json TEXT NOT NULL,
  initial_token_budget INTEGER NOT NULL CHECK(initial_token_budget >= 0),
  deadline_at_ms INTEGER NOT NULL CHECK(deadline_at_ms >= 0),
  budget_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'stop_requested', 'terminal')),
  stop_reason TEXT CHECK(stop_reason IN ('player_preempted', 'user_cancelled', 'administrative_stop', 'quarantined')),
  terminal_reason TEXT CHECK(terminal_reason IN (
    'quiescent', 'all_abstained', 'call_limit', 'wave_limit', 'token_budget_exhausted',
    'deadline_reached', 'provider_terminal', 'player_preempted', 'user_cancelled',
    'administrative_stop', 'quarantined'
  )),
  terminal_at_seq INTEGER CHECK(terminal_at_seq >= created_at_seq),
  cycle_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  UNIQUE(cycle_id, address_key),
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  FOREIGN KEY(root_transaction_id) REFERENCES round_commits(transaction_id),
  CHECK (
    (status = 'active' AND stop_reason IS NULL AND terminal_reason IS NULL AND terminal_at_seq IS NULL)
    OR (status = 'stop_requested' AND stop_reason IS NOT NULL AND terminal_reason IS NULL AND terminal_at_seq IS NULL)
    OR (status = 'terminal' AND terminal_reason IS NOT NULL AND terminal_at_seq IS NOT NULL)
  )
) STRICT;
CREATE UNIQUE INDEX world_reaction_cycles_one_open
  ON world_reaction_cycles(address_key) WHERE status <> 'terminal';
CREATE INDEX world_reaction_cycles_root_round
  ON world_reaction_cycles(address_key, root_round_id);

CREATE TABLE world_reaction_waves (
  cycle_id TEXT NOT NULL,
  address_key TEXT NOT NULL,
  wave INTEGER NOT NULL CHECK(wave >= 1),
  base_head_seq INTEGER NOT NULL CHECK(base_head_seq >= 0),
  base_head_hash TEXT NOT NULL,
  calls_before INTEGER NOT NULL CHECK(calls_before >= 0),
  tokens_before INTEGER NOT NULL CHECK(tokens_before >= 0),
  budget_plan_json TEXT NOT NULL,
  budget_plan_hash TEXT NOT NULL,
  reserved_calls INTEGER NOT NULL CHECK(reserved_calls >= 0),
  reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens >= 0),
  status TEXT NOT NULL CHECK(status IN ('frozen', 'committed', 'closed_without_dispatch')),
  reaction_round_id TEXT,
  result_transaction_id TEXT,
  authority_hash TEXT,
  wave_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  PRIMARY KEY(cycle_id, wave),
  UNIQUE(cycle_id, wave, address_key),
  FOREIGN KEY(cycle_id, address_key) REFERENCES world_reaction_cycles(cycle_id, address_key),
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  FOREIGN KEY(result_transaction_id) REFERENCES round_commits(transaction_id),
  CHECK (
    (status = 'frozen' AND reaction_round_id IS NULL AND result_transaction_id IS NULL AND authority_hash IS NULL)
    OR (status = 'committed' AND reaction_round_id IS NOT NULL AND result_transaction_id IS NOT NULL AND authority_hash IS NOT NULL)
    OR (status = 'closed_without_dispatch' AND reaction_round_id IS NULL AND result_transaction_id IS NULL AND authority_hash IS NULL)
  )
) STRICT;
CREATE UNIQUE INDEX world_reaction_waves_result_transaction
  ON world_reaction_waves(result_transaction_id) WHERE result_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX world_reaction_waves_reaction_round
  ON world_reaction_waves(address_key, reaction_round_id) WHERE reaction_round_id IS NOT NULL;

CREATE TABLE world_reaction_jobs (
  job_id TEXT PRIMARY KEY,
  address_key TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  wave INTEGER NOT NULL CHECK(wave >= 1),
  character_id TEXT NOT NULL,
  stimulus_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'settled', 'skipped')),
  budget_decision TEXT NOT NULL CHECK(budget_decision IN (
    'reserved', 'character_limit', 'call_limit', 'token_budget_exhausted'
  )),
  budget_ordinal INTEGER CHECK(budget_ordinal >= 0),
  reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens >= 0),
  claim_owner_id TEXT,
  claim_expires_at_ms INTEGER CHECK(claim_expires_at_ms >= 0),
  claim_fencing_token INTEGER CHECK(claim_fencing_token >= 1),
  attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
  outcome TEXT CHECK(outcome IN ('proposed', 'abstained', 'provider_terminal', 'runtime_unavailable', 'rejected')),
  context_receipt_id TEXT,
  context_receipt_hash TEXT,
  provider_call_id TEXT,
  provider_request_hash TEXT,
  proposal_hash TEXT,
  result_transaction_id TEXT,
  job_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  UNIQUE(job_id, address_key),
  UNIQUE(cycle_id, wave, character_id),
  FOREIGN KEY(cycle_id, wave, address_key) REFERENCES world_reaction_waves(cycle_id, wave, address_key),
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  FOREIGN KEY(result_transaction_id) REFERENCES round_commits(transaction_id),
  CHECK ((context_receipt_id IS NULL) = (context_receipt_hash IS NULL)),
  CHECK ((provider_call_id IS NULL) = (provider_request_hash IS NULL)),
  CHECK (proposal_hash IS NULL OR provider_call_id IS NOT NULL),
  CHECK (
    (status = 'skipped' AND budget_decision <> 'reserved' AND budget_ordinal IS NULL AND reserved_tokens = 0
      AND claim_owner_id IS NULL AND claim_expires_at_ms IS NULL AND claim_fencing_token IS NULL
      AND attempt_count = 0 AND outcome IS NULL AND context_receipt_id IS NULL AND provider_call_id IS NULL
      AND proposal_hash IS NULL AND result_transaction_id IS NULL)
    OR (status = 'pending' AND budget_decision = 'reserved' AND budget_ordinal IS NOT NULL AND reserved_tokens > 0
      AND claim_owner_id IS NULL AND claim_expires_at_ms IS NULL AND claim_fencing_token IS NULL
      AND outcome IS NULL AND context_receipt_id IS NULL AND provider_call_id IS NULL
      AND proposal_hash IS NULL AND result_transaction_id IS NULL)
    OR (status = 'claimed' AND budget_decision = 'reserved' AND budget_ordinal IS NOT NULL AND reserved_tokens > 0
      AND claim_owner_id IS NOT NULL AND claim_expires_at_ms IS NOT NULL AND claim_fencing_token IS NOT NULL
      AND attempt_count >= 1 AND outcome IS NULL AND result_transaction_id IS NULL)
    OR (status = 'settled' AND budget_decision = 'reserved' AND budget_ordinal IS NOT NULL AND reserved_tokens > 0
      AND claim_owner_id IS NOT NULL AND claim_expires_at_ms IS NOT NULL AND claim_fencing_token IS NOT NULL
      AND attempt_count >= 1 AND outcome IS NOT NULL)
  )
) STRICT;
CREATE INDEX world_reaction_jobs_claim_order
  ON world_reaction_jobs(address_key, status, wave, character_id, stimulus_hash, job_id);
CREATE INDEX world_reaction_jobs_cycle_wave_status
  ON world_reaction_jobs(cycle_id, wave, status);
CREATE UNIQUE INDEX world_reaction_jobs_provider_call
  ON world_reaction_jobs(provider_call_id) WHERE provider_call_id IS NOT NULL;

CREATE TABLE world_reaction_job_stimuli (
  job_id TEXT NOT NULL,
  address_key TEXT NOT NULL,
  stimulus_ordinal INTEGER NOT NULL CHECK(stimulus_ordinal >= 0),
  observer_character_id TEXT NOT NULL,
  source_round_id TEXT NOT NULL,
  source_transaction_id TEXT NOT NULL,
  source_event_seq INTEGER NOT NULL CHECK(source_event_seq >= 1),
  source_event_ordinal INTEGER NOT NULL CHECK(source_event_ordinal >= 0),
  observation_ordinal INTEGER NOT NULL CHECK(observation_ordinal >= 0),
  observation_id TEXT NOT NULL,
  source_event_hash TEXT NOT NULL,
  stimulus_entry_hash TEXT NOT NULL,
  PRIMARY KEY(job_id, stimulus_ordinal),
  FOREIGN KEY(job_id, address_key) REFERENCES world_reaction_jobs(job_id, address_key),
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  FOREIGN KEY(source_transaction_id) REFERENCES round_commits(transaction_id),
  FOREIGN KEY(address_key, source_event_seq) REFERENCES events(address_key, seq)
) STRICT;
CREATE INDEX world_reaction_job_stimuli_source
  ON world_reaction_job_stimuli(address_key, source_event_seq, source_event_ordinal, observation_ordinal);
CREATE INDEX events_type_range ON events(address_key, event_type, seq);
`

/**
 * Responsive/v2 records why an observation was weighed, on the stimulus it was admitted as. It is a
 * nullable column rather than a second table: v1 rows keep storing nothing, so their bytes and entry
 * hashes are untouched, and a reader sees the basis on the row it belongs to.
 */
export const WORLD_REACTION_EVIDENCE_SCHEMA = `
ALTER TABLE world_reaction_job_stimuli ADD COLUMN evidence_json TEXT;
`

/**
 * NPC Reaction Cycles are retired and their tables dropped. Worlds that ran a Cycle before this are not
 * maintained: their stored bundle hashes covered the dropped rows and no longer verify.
 */
export const WORLD_RETIRE_REACTION_SCHEMA = `
DROP TABLE world_reaction_job_stimuli;
DROP TABLE world_reaction_jobs;
DROP TABLE world_reaction_waves;
DROP TABLE world_reaction_cycles;
`

export const WORLD_SCHEMA_VERSION = 20

export function openWorldDatabase(path: string): DatabaseSync {
  return openMigratedDatabase(path, WORLD_APPLICATION_ID, [
    { version: 1, sql: WORLD_SCHEMA },
    { version: 2, sql: WORLD_LEASE_SCHEMA },
    { version: 3, sql: WORLD_ACTIVATION_SCHEMA },
    { version: 4, sql: WORLD_ROUND_INBOX_SCHEMA },
    { version: 5, sql: WORLD_OUTBOX_DELIVERY_SCHEMA },
    { version: 6, sql: WORLD_BRANCH_ADMIN_SCHEMA },
    { version: 7, sql: WORLD_OUTBOX_CLAIM_SCHEMA },
    { version: 8, sql: WORLD_ROUND_COMPLETION_SCHEMA },
    { version: 9, sql: WORLD_QUARANTINE_SCHEMA },
    { version: 10, sql: WORLD_CHARACTER_RUNTIME_SCHEMA },
    { version: 11, sql: WORLD_ROUND_AUTHORITY_SCHEMA },
    { version: 12, sql: WORLD_COGNITIVE_JOB_SCHEMA },
    { version: 13, sql: WORLD_CLARIFICATION_SCHEMA },
    { version: 14, sql: WORLD_OUTBOX_RETRY_SCHEMA },
    { version: 15, sql: WORLD_PROVIDER_OUTPUT_AVAILABILITY_SCHEMA },
    { version: 16, sql: WORLD_REACTION_SCHEMA },
    { version: 17, sql: 'ALTER TABLE world_reaction_cycles ADD COLUMN action_group_max_actions INTEGER CHECK(action_group_max_actions = 2);' },
    { version: 18, sql: PLAYER_INPUT_SCHEMA },
    { version: 19, sql: WORLD_REACTION_EVIDENCE_SCHEMA },
    { version: WORLD_SCHEMA_VERSION, sql: WORLD_RETIRE_REACTION_SCHEMA },
  ])
}
