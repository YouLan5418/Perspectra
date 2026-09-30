"""Rank real PrototypeCharacterTurn recall observations without changing Character requests.

Usage: python native-memory-shadow-rank.py PLAYTEST_DATA_DIR MODEL_SNAPSHOT_DIR
The playtest data directory contains memory-shadow.jsonl and memory.sqlite.
"""
import json
import sqlite3
import sys
from pathlib import Path
from time import perf_counter

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

data_dir = Path(sys.argv[1]).resolve()
snapshot = Path(sys.argv[2]).resolve()
observations = [
    json.loads(line)
    for line in (data_dir / "memory-shadow.jsonl").read_text(encoding="utf-8").splitlines()
    if line.strip()
]
tokenizer = Tokenizer.from_file(str(snapshot / "tokenizer.json"))
tokenizer.enable_truncation(max_length=512)
session = ort.InferenceSession(str(snapshot / "onnx" / "model.onnx"),
                               providers=["CPUExecutionProvider"])
database = sqlite3.connect((data_dir / "memory.sqlite").as_uri() + "?mode=ro", uri=True)


def embed(text: str, prefix: str) -> np.ndarray:
    encoded = tokenizer.encode(prefix + text)
    mask = np.asarray([encoded.attention_mask], dtype=np.int64)
    states = session.run(None, {
        "input_ids": np.asarray([encoded.ids], dtype=np.int64),
        "attention_mask": mask,
        "token_type_ids": np.asarray([encoded.type_ids], dtype=np.int64),
    })[0]
    pooled = (states * mask[:, :, None]).sum(axis=1) / mask.sum(axis=1)[:, None]
    vector = pooled[0]
    return vector / max(float(np.linalg.norm(vector)), 1e-12)


def visible_sources(observation: dict) -> list[dict]:
    address = observation["address"]
    key = "\x1f".join([address["tenantId"], address["worldId"],
                       address["branchId"], observation["characterId"]])
    as_of = observation["asOfWorldSeq"]
    if not isinstance(as_of, int) or as_of < 0:
        raise ValueError("invalid as-of sequence")
    rows = database.execute("""
        SELECT source_id, source_seq, source_hash, epistemic_kind, text_value, metadata_json
        FROM cognitive_memory_v2_sources
        WHERE namespace_key = ? AND source_seq <= ?
        ORDER BY source_seq, source_id
    """, (key, as_of)).fetchall()
    return [
        {"sourceId": row[0], "sourceSeq": row[1], "sourceHash": row[2],
         "epistemicKind": row[3], "text": row[4], "metadata": json.loads(row[5])}
        for row in rows
    ]


started = perf_counter()
results = []
vector_cache: dict[tuple[str, str], np.ndarray] = {}
try:
    for index, observation in enumerate(observations):
        rows = visible_sources(observation)
        visible_ids = {row["sourceId"] for row in rows}
        keyword_ids = observation["keywordSourceIds"]
        delivered_ids = observation["deliveredSourceIds"]
        if any(source_id not in visible_ids for source_id in keyword_ids):
            raise ValueError(f"keyword source outside character prefix at row {index}")
        if any(source_id not in keyword_ids for source_id in delivered_ids):
            raise ValueError(f"delivered source was not in keyword result at row {index}")
        excluded = set(observation["excludedSourceSeqs"])
        eligible = [row for row in rows if row["sourceSeq"] not in excluded
                    and (observation["phase"] != "automatic"
                         or "projectionId" not in row["metadata"])]
        query = observation["query"].strip()
        candidates = []
        if query and eligible:
            query_vector = embed(query, "query: ")
            scored = []
            for row in eligible:
                cache_key = (row["sourceHash"], row["text"])
                vector = vector_cache.get(cache_key)
                if vector is None:
                    vector = embed(row["text"], "passage: ")
                    vector_cache[cache_key] = vector
                scored.append((float(vector @ query_vector), row))
            scored.sort(key=lambda pair: (-pair[0], pair[1]["sourceId"]))
            candidates = [
                {"sourceId": row["sourceId"], "sourceSeq": row["sourceSeq"],
                 "sourceHash": row["sourceHash"], "epistemicKind": row["epistemicKind"],
                 "score": round(score, 6)}
                for score, row in scored[:5]
            ]
        results.append({
            "characterId": observation["characterId"], "asOfWorldSeq": observation["asOfWorldSeq"],
            "phase": observation["phase"], "query": query, "visibleSourceCount": len(rows),
            "eligibleSourceCount": len(eligible), "keywordSourceIds": keyword_ids,
            "deliveredSourceIds": delivered_ids, "semanticCandidates": candidates,
            "newCandidateIds": [row["sourceId"] for row in candidates
                                if row["sourceId"] not in delivered_ids],
        })
finally:
    database.close()
output = {"mode": "native-character-turn-semantic-shadow",
          "model": "intfloat/multilingual-e5-small",
          "elapsedSeconds": round(perf_counter() - started, 3), "results": results}
(data_dir / "memory-shadow-semantic.json").write_text(
    json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"observations": len(results),
                  "queries": sum(bool(row["query"]) for row in results),
                  "withNewCandidates": sum(bool(row["newCandidateIds"]) for row in results),
                  "elapsedSeconds": output["elapsedSeconds"]}, ensure_ascii=False))
