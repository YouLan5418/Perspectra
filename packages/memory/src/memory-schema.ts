import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase } from '@harness-world/store-sqlite'

/** The memory database schema as forward-only migrations; each constant is what one version added. */
export const MEMORY_APPLICATION_ID = 0x4843574c
const MEMORY_SCHEMA = `
CREATE TABLE memory_source_mappings (
  namespace_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('observation', 'claim', 'goal')),
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL CHECK(source_seq >= 0),
  source_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, source_kind, source_id)
) STRICT;
CREATE TABLE memory_entries (
  namespace_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  text_value TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  capture_hash TEXT NOT NULL,
  source_max_seq INTEGER NOT NULL CHECK(source_max_seq >= 0),
  forgotten_seq INTEGER CHECK(forgotten_seq >= source_max_seq),
  PRIMARY KEY(namespace_key, memory_id)
) STRICT;
CREATE TABLE memory_sources (
  namespace_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('observation', 'claim', 'goal')),
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, memory_id, source_kind, source_id),
  FOREIGN KEY(namespace_key, memory_id) REFERENCES memory_entries(namespace_key, memory_id)
) STRICT;
CREATE VIRTUAL TABLE memory_fts USING fts5(namespace_key UNINDEXED, memory_id UNINDEXED, text_value);
`

const MEMORY_RECONCILE_SCHEMA = `
CREATE TABLE memory_namespace_watermarks (
  namespace_key TEXT PRIMARY KEY,
  as_of_seq INTEGER NOT NULL CHECK(as_of_seq >= 0),
  bundle_hash TEXT NOT NULL
) STRICT;
`

const MEMORY_COGNITIVE_JOB_SCHEMA = `
CREATE TABLE cognitive_jobs (
  namespace_key TEXT NOT NULL,
  as_of_seq INTEGER NOT NULL CHECK(as_of_seq >= 0),
  job_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
  last_error TEXT,
  PRIMARY KEY(namespace_key, as_of_seq)
) STRICT;
`

const MEMORY_GOAL_SOURCE_SCHEMA = `
ALTER TABLE memory_source_mappings RENAME TO memory_source_mappings_v3;
CREATE TABLE memory_source_mappings (
  namespace_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('observation', 'claim', 'goal')),
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL CHECK(source_seq >= 0),
  source_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, source_kind, source_id)
) STRICT;
INSERT INTO memory_source_mappings SELECT * FROM memory_source_mappings_v3;
DROP TABLE memory_source_mappings_v3;
ALTER TABLE memory_sources RENAME TO memory_sources_v3;
CREATE TABLE memory_sources (
  namespace_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('observation', 'claim', 'goal')),
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, memory_id, source_kind, source_id),
  FOREIGN KEY(namespace_key, memory_id) REFERENCES memory_entries(namespace_key, memory_id)
) STRICT;
INSERT INTO memory_sources SELECT * FROM memory_sources_v3;
DROP TABLE memory_sources_v3;
`

const MEMORY_COGNITIVE_V2_SCHEMA = `
CREATE TABLE cognitive_memory_v2_namespaces (
  namespace_key TEXT PRIMARY KEY,
  verified_through_seq INTEGER NOT NULL CHECK(verified_through_seq >= 0),
  captured_through_seq INTEGER NOT NULL CHECK(captured_through_seq >= 0),
  memory_epoch INTEGER NOT NULL CHECK(memory_epoch >= 1),
  source_map_hash TEXT NOT NULL,
  source_bundle_hash TEXT NOT NULL
) STRICT;
CREATE TABLE cognitive_memory_v2_sources (
  namespace_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('observation', 'subjective_claim', 'character_goal')),
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL CHECK(source_seq >= 0),
  source_hash TEXT NOT NULL,
  memory_kind TEXT NOT NULL CHECK(memory_kind IN ('episodic', 'communication', 'belief', 'intention')),
  epistemic_kind TEXT NOT NULL CHECK(epistemic_kind IN (
    'direct_observation', 'observed_action', 'reported_speech', 'subjective_inference', 'self_intention'
  )),
  text_value TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  capture_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, source_id),
  UNIQUE(namespace_key, memory_id)
) STRICT;
CREATE VIRTUAL TABLE cognitive_memory_v2_fts USING fts5(namespace_key UNINDEXED, memory_id UNINDEXED, text_value);
CREATE TABLE cognitive_memory_v2_summaries (
  namespace_key TEXT NOT NULL,
  summary_id TEXT NOT NULL,
  source_start_seq INTEGER NOT NULL CHECK(source_start_seq >= 0),
  source_end_seq INTEGER NOT NULL CHECK(source_end_seq >= source_start_seq),
  source_refs_json TEXT NOT NULL,
  extracts_json TEXT NOT NULL,
  summary_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, summary_id)
) STRICT;
CREATE TABLE cognitive_memory_v2_receipts (
  receipt_id TEXT PRIMARY KEY,
  namespace_key TEXT NOT NULL,
  required_as_of_seq INTEGER NOT NULL CHECK(required_as_of_seq >= 0),
  receipt_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL
) STRICT;
CREATE TABLE cognitive_memory_v2_recall_receipts (
  receipt_id TEXT PRIMARY KEY,
  namespace_key TEXT NOT NULL,
  as_of_seq INTEGER NOT NULL CHECK(as_of_seq >= 0),
  receipt_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL
) STRICT;
`

/**
 * Versioned keyword index. Terms are a pure function of a captured entry's text, so the index is
 * derived and disposable: it can always be rebuilt from the sources at the same as-of. The namespace
 * row records which tokenizer built it, so a namespace indexed by an older tokenizer is rebuilt once
 * instead of being matched with stale boundaries.
 */
const MEMORY_COGNITIVE_V2_KEYWORD_SCHEMA = `
CREATE TABLE cognitive_memory_v2_terms (
  namespace_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  token TEXT NOT NULL,
  token_kind TEXT NOT NULL CHECK(token_kind IN ('cjk-2', 'cjk-3', 'word')),
  token_weight INTEGER NOT NULL CHECK(token_weight > 0),
  source_seq INTEGER NOT NULL CHECK(source_seq >= 0),
  PRIMARY KEY(namespace_key, memory_id, token)
) STRICT;
CREATE INDEX cognitive_memory_v2_terms_lookup ON cognitive_memory_v2_terms(namespace_key, token);
ALTER TABLE cognitive_memory_v2_namespaces ADD COLUMN terms_tokenizer_id TEXT;
`

/**
 * Widens the term kinds for the segmenter-backed tokenizer and clears every marker, so each namespace
 * rebuilds once with the tokenizer it uses. Recreating the table is safe because it holds derived data
 * only: every row can be recomputed from the captured sources.
 */
const MEMORY_COGNITIVE_V2_HYBRID_SCHEMA = `
DROP TABLE cognitive_memory_v2_terms;
CREATE TABLE cognitive_memory_v2_terms (
  namespace_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  token TEXT NOT NULL,
  token_kind TEXT NOT NULL CHECK(token_kind IN ('cjk-2', 'cjk-3', 'word', 'jieba-word')),
  token_weight INTEGER NOT NULL CHECK(token_weight > 0),
  source_seq INTEGER NOT NULL CHECK(source_seq >= 0),
  PRIMARY KEY(namespace_key, memory_id, token)
) STRICT;
CREATE INDEX cognitive_memory_v2_terms_lookup ON cognitive_memory_v2_terms(namespace_key, token);
UPDATE cognitive_memory_v2_namespaces SET terms_tokenizer_id = NULL;
`

/**
 * L1 Summaries used to be grouped by record count, which cut an arbitrary line through the middle of a
 * committed Round and dropped a trailing group of one — so the newest Memories had no Summary at all.
 * Summaries are derived data rebuilt on every catch-up, so dropping the old rows is enough: the next
 * catch-up writes Round-grouped ones. Continuity Checkpoints name Summaries by identity, so they drop
 * their own derived rows the same way.
 */
const MEMORY_COGNITIVE_V2_DIGEST_SCHEMA = `
DELETE FROM cognitive_memory_v2_summaries;
`

export const MEMORY_SCHEMA_VERSION = 8

export function openMemoryDatabase(path: string): DatabaseSync {
  return openMigratedDatabase(path, MEMORY_APPLICATION_ID, [
    { version: 1, sql: MEMORY_SCHEMA },
    { version: 2, sql: MEMORY_RECONCILE_SCHEMA },
    { version: 3, sql: MEMORY_COGNITIVE_JOB_SCHEMA },
    { version: 4, sql: MEMORY_GOAL_SOURCE_SCHEMA },
    { version: 5, sql: MEMORY_COGNITIVE_V2_SCHEMA },
    { version: 6, sql: MEMORY_COGNITIVE_V2_KEYWORD_SCHEMA },
    { version: 7, sql: MEMORY_COGNITIVE_V2_HYBRID_SCHEMA },
    { version: MEMORY_SCHEMA_VERSION, sql: MEMORY_COGNITIVE_V2_DIGEST_SCHEMA },
  ])
}
