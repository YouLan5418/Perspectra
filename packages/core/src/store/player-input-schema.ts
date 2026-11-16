export const PLAYER_INPUT_SCHEMA = `
CREATE TABLE player_input_jobs (
  address_key TEXT NOT NULL,
  input_seq INTEGER NOT NULL CHECK(input_seq >= 1),
  idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('received','prepared','dispatch_started','response_received','validated','round_enqueued','completed','clarification_required','invalid_response','timed_out','timed_out_ambiguous','cancelled')),
  job_json TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  claim_owner_id TEXT,
  claim_fencing_token INTEGER,
  PRIMARY KEY(address_key,input_seq),
  UNIQUE(address_key,idempotency_key),
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  CHECK((claim_owner_id IS NULL AND claim_fencing_token IS NULL) OR (claim_owner_id IS NOT NULL AND claim_fencing_token >= 1))
) STRICT;
`

/** An input whose preparation/adjudication faults must be terminal without claiming a world commit. */
export const PLAYER_INPUT_FAULT_SCHEMA = `
${PLAYER_INPUT_SCHEMA.replace(
  'CREATE TABLE player_input_jobs (',
  'CREATE TABLE player_input_jobs_with_faults (',
).replace("'timed_out_ambiguous','cancelled'", "'timed_out_ambiguous','cancelled','failed'")}
INSERT INTO player_input_jobs_with_faults SELECT * FROM player_input_jobs;
DROP TABLE player_input_jobs;
ALTER TABLE player_input_jobs_with_faults RENAME TO player_input_jobs;
`
