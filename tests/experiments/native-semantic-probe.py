"""Offline semantic retrieval probe over Cordis-owned, character-visible sources.

Usage: python native-semantic-probe.py BASELINE_DIR MODEL_SNAPSHOT_DIR
Requires numpy, tokenizers and onnxruntime; does not import Hindsight.
"""
import json

import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

baseline_dir = Path(sys.argv[1]).resolve()
snapshot = Path(sys.argv[2]).resolve()
report = json.loads((baseline_dir / "report.json").read_text(encoding="utf-8"))
sources = json.loads((baseline_dir / "sources.json").read_text(encoding="utf-8"))
tokenizer = Tokenizer.from_file(str(snapshot / "tokenizer.json"))
tokenizer.enable_truncation(max_length=512)
session = ort.InferenceSession(str(snapshot / "onnx" / "model.onnx"),
                               providers=["CPUExecutionProvider"])


def embed(texts: list[str], prefix: str) -> np.ndarray:
    vectors = []
    for text in texts:
        encoded = tokenizer.encode(prefix + text)
        ids = np.asarray([encoded.ids], dtype=np.int64)
        mask = np.asarray([encoded.attention_mask], dtype=np.int64)
        types = np.asarray([encoded.type_ids], dtype=np.int64)
        states = session.run(None, {"input_ids": ids, "attention_mask": mask,
                                    "token_type_ids": types})[0]
        pooled = (states * mask[:, :, None]).sum(axis=1) / mask.sum(axis=1)[:, None]
        length = np.linalg.norm(pooled, axis=1, keepdims=True)
        vectors.append((pooled / np.maximum(length, 1e-12))[0])
    return np.asarray(vectors)


embeddings = {
    role: embed([item["text_value"] for item in rows], "passage: ")
    for role, rows in sources.items()
}
results = []
for case in report["results"]:
    role = case["characterId"]
    rows = sources[role]
    query = embed([case["question"]], "query: ")[0]
    scores = embeddings[role] @ query
    ordered = sorted(range(len(rows)), key=lambda i: (-float(scores[i]),
                                                        rows[i]["source_id"]))
    candidates = [
        {"sourceId": rows[i]["source_id"], "sourceHash": rows[i]["source_hash"], "score": round(float(scores[i]), 6),
         "epistemicKind": rows[i]["epistemic_kind"]}
        for i in ordered[:5]
    ]
    if role == "character:npc" and any("深海灯" in rows[i]["text_value"] for i in ordered):
        raise RuntimeError("private observation leaked into NPC semantic corpus")
    expected = case["expected"]
    results.append({
        "id": case["id"], "question": case["question"], "expected": expected,
        "expectedRank": None if expected is None else next(
            (rank + 1 for rank, i in enumerate(ordered)
             if rows[i]["source_id"] == expected), None),
        "candidates": candidates,
    })
output = {"mode": "native-offline-e5-probe", "model": "intfloat/multilingual-e5-small",
          "hindsightImported": False, "results": results}
(baseline_dir / "semantic-probe.json").write_text(
    json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps([
    {"id": item["id"], "expectedRank": item["expectedRank"],
     "top": item["candidates"][0] if item["candidates"] else None}
    for item in results
], ensure_ascii=False))
