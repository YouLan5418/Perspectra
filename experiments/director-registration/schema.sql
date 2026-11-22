-- Install only in a disposable world.sqlite. The shipping schema version stays at 21.
BEGIN IMMEDIATE;
CREATE TABLE experimental_pending_notices (
  address_key TEXT NOT NULL REFERENCES branches(address_key),
  metadata_seq INTEGER NOT NULL CHECK (metadata_seq > 0),
  world_seq INTEGER NOT NULL CHECK (world_seq >= 0),
  request_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (
    json_valid(receipt_json) AND json_extract(receipt_json, '$.metadataSeq') IS metadata_seq
    AND json_extract(receipt_json, '$.afterWorldSeq') IS world_seq
    AND json_extract(receipt_json, '$.requestId') IS request_id
    AND json_type(receipt_json, '$.registrationId') IS 'text'
  ),
  PRIMARY KEY(address_key, metadata_seq),
  UNIQUE(address_key, request_id)
) STRICT;

-- Distinct opt-in format. Schema-21 hosts must refuse to open these files.
PRAGMA user_version = 21001;
COMMIT;
