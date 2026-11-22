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
  ),
  PRIMARY KEY(address_key, metadata_seq),
  UNIQUE(address_key, request_id)
) STRICT;

-- A fork freezes its parent's currently accepted prefix through the requested world event.
-- Later registrations at the same world head cannot leak into an earlier sibling.
CREATE TRIGGER experimental_fork_pending_notices AFTER INSERT ON branches
WHEN NEW.parent_address_key IS NOT NULL
BEGIN
  INSERT INTO experimental_pending_notices
    SELECT NEW.address_key, metadata_seq, world_seq, request_id, receipt_json
    FROM experimental_pending_notices WHERE address_key = NEW.parent_address_key AND world_seq <= NEW.fork_seq;
END;
COMMIT;
