"""Frozen encoder comparison, never recalls held-out queries or changes runtime gates."""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import json
import math
import re
import time
import urllib.request
from collections import Counter
from pathlib import Path
import numpy as np
import core
import projections
import queries
from hindsight_api.engine.onnx_slices import OnnxEmbeddings

BASE = Path(__file__).resolve().parents[2]
TASK = "Given the current situation, retrieve relevant past experiences of this character."
BACKGROUND = [
    "刚才那道几何题我还是没想明白，你能再讲讲三角形的面积吗？",
    "这台冰箱的温度是不是调得太低了，冷冻室都结霜了。",
    "那份合同的违约金条款，你仔细核对过了吗？",
    "这次足球赛的裁判判了越位，我觉得有点意外。",
    "新安装的操作系统总蓝屏，我想先把显卡驱动重装一遍。",
    "昨晚我梦到了火星基地，里面还有会说话的机器人。",
    "听说那家博物馆展出了古埃及的石棺，铭文挺难看懂。",
    "这组围棋死活题我想了半天，还是找不到活棋的方法。",
    "这个季度的股票分红到账了，我得核对一下银行账单。",
    "儿童疫苗接种记录要怎么填写，你能帮我解释栏目吗？",
    "钢琴这几个和弦按起来有点别扭，我想重新练习指法。",
    "刚才烤蛋糕时忘了加酵母，成品为什么没有膨胀？",
]


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def auc(positive, negative):
    if not positive or not negative:
        return None
    return sum((p > n) + .5 * (p == n) for p in positive for n in negative) / (len(positive) * len(negative))


def percentiles(values):
    if not values:
        return {"count": 0}
    result = {str(p): float(np.percentile(values, p)) for p in (5, 25, 50, 75, 95)}
    return {"count": len(values), "mean": float(np.mean(values)), "stdPopulation": float(np.std(values)),
            "percentiles": result, "p95MinusP5": result["95"] - result["5"]}


def normalized(matrix):
    value = np.asarray(matrix, dtype=np.float32)
    if value.ndim != 2 or not np.isfinite(value).all() or np.any(np.linalg.norm(value, axis=1) == 0):
        raise ValueError("invalid embedding matrix")
    return value / np.linalg.norm(value, axis=1, keepdims=True)


def aliases(request):
    context = request["context"]
    objects = [context.get("character", {}), *context.get("scene", {}).get("people", [])]
    # Only names/IDs explicitly supplied in this character's authorized context.
    return sorted({name for o in objects for name in [o.get("name"), str(o.get("characterId", "")).split(":")[-1]]
                   if isinstance(name, str) and name}, key=lambda n: (-len(n), n))


def clean_text(text, names):
    for name in names:
        if name.isascii():
            text = re.sub(r"(?<![a-zA-Z0-9_])" + re.escape(name) + r"(?![a-zA-Z0-9_])", " ", text)
        else:
            text = text.replace(name, " ")
    # Remove prose boilerplate, preserve failure and unknown-result qualifiers.
    text = text.replace("观察到行动结果：", "").replace("尝试未成功：", "未成功：")
    text = text.replace("结果未提供的行动记录：", "结果未提供：")
    while text.startswith("【主观认识，可修正】"):
        text = text[len("【主观认识，可修正】"):]
    return re.sub(r"\s+", " ", text).strip()


def coverage_scores(texts, query):
    terms = set(queries.lexical_terms(query))
    bags = [Counter(queries.lexical_terms(t)) for t in texts]
    for term in terms:
        if len(term) == 1 and "\u3400" <= term <= "\u9fff":
            for bag, text in zip(bags, texts):
                bag[term] = text.count(term)
    df = Counter(term for bag in bags for term in bag)
    idf = {t: math.log(1 + (len(bags) - df[t] + .5) / (df[t] + .5)) for t in terms}
    total = sum(idf.values())
    return [sum(idf[t] for t in terms if bag[t]) / total if total else 0.0 for bag in bags]


class Encoder:
    def __init__(self, kind, model, onnx=None, prefixes=True):
        self.kind, self.model, self.onnx, self.prefixes = kind, model, onnx, prefixes
        self.pending = {}
        self.vectors = {}
        self.seconds = 0.0
        self.calls = 0
        self.dimension = None
        self.ollama_timings = []
        self.metadata = {}

    def add(self, scope, text, query=False):
        # Character namespace protects vector sharing even if texts happen to coincide.
        core.check_scope({"scope": scope})
        owner = json.dumps([scope["worldAddress"], scope["characterId"]], sort_keys=True)
        key = (owner, query, text)
        self.pending[key] = scope
        return key

    def fill(self, output):
        start = time.monotonic()
        if self.kind == "onnx":
            prefix = ("query: ", "passage: ") if self.prefixes else ("", "")
            model = OnnxEmbeddings("Xenova/multilingual-e5-small",
                model_path=str(self.onnx), tokenizer_name_or_path=str(BASE / ".tmp/hindsight-e5-small"),
                max_tokens=256, batch_size=8, query_prefix=prefix[0], passage_prefix=prefix[1])
            asyncio.run(model.initialize())
            self.metadata = {"file": str(self.onnx), "sha256": file_hash(self.onnx),
                             "revision": "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
                             "maxTokens": 256, "prefixes": list(prefix)}
        else:
            tags = self.http("/api/tags")
            found = next((m for m in tags["models"] if m["name"] == self.model), None)
            if found is None:
                raise ValueError("Ollama model not installed")
            self.metadata = {"model": self.model, "digest": found["digest"], "details": found["details"],
                             "queryInstruction": TASK, "documentPrefix": "", "numCtx": 2048}
        groups = {}
        for key, scope in self.pending.items():
            groups.setdefault((key[0], key[1]), []).append(key)
        for (owner, query), keys in sorted(groups.items()):
            keys.sort(key=lambda k: k[2])
            values = []
            for offset in range(0, len(keys), 8):
                batch = keys[offset:offset + 8]
                texts = [k[2] for k in batch]
                if self.kind == "onnx":
                    vectors = asyncio.run((model.encode_query if query else model.encode_documents)(texts))
                else:
                    texts = [f"Instruct: {TASK}\nQuery: {t}" for t in texts] if query else texts
                    answer = self.http("/api/embed", {"model": self.model, "input": texts, "truncate": False,
                        "keep_alive": "15m", "options": {"num_ctx": 2048}})
                    vectors = answer["embeddings"]
                    self.ollama_timings.append({k: answer.get(k) for k in ("total_duration", "load_duration", "prompt_eval_count")})
                if len(vectors) != len(batch):
                    raise ValueError("encoder silently changed batch count")
                array = normalized(vectors)
                if self.dimension is not None and array.shape[1] != self.dimension:
                    raise ValueError("encoder dimension changed")
                self.dimension = int(array.shape[1])
                for key, vector in zip(batch, array):
                    self.vectors[key] = vector
                values.extend(array)
                self.calls += 1
                if self.calls % 25 == 0:
                    print(json.dumps({"encoder": self.model, "batches": self.calls}), flush=True)
            namespace = hashlib.sha256(owner.encode()).hexdigest()[:16]
            folder = output / re.sub(r"[^a-zA-Z0-9_.-]", "-", self.model) / namespace
            folder.mkdir(parents=True, exist_ok=True)
            np.save(folder / ("query.npy" if query else "document.npy"), np.asarray(values))
            write(folder / ("query-texts.json" if query else "document-texts.json"), [k[2] for k in keys])
        self.seconds = time.monotonic() - start
        if self.kind == "ollama":
            self.metadata["loadedModels"] = self.http("/api/ps")["models"]
            self.metadata["batchDurationsSeconds"] = percentiles([t["total_duration"] / 1e9 for t in self.ollama_timings])
        self.metadata["uniqueInputs"] = len(self.pending)
        self.metadata["batches"] = self.calls
        print(json.dumps({"encoderComplete": self.model, "uniqueInputs": len(self.pending),
                          "dimension": self.dimension, "seconds": self.seconds}), flush=True)

    @staticmethod
    def http(path, data=None):
        body = None if data is None else json.dumps(data, ensure_ascii=False).encode()
        req = urllib.request.Request("http://127.0.0.1:11434" + path, data=body,
                                     headers={"Content-Type": "application/json"})
        return json.load(urllib.request.urlopen(req, timeout=120))

    def score(self, query, documents):
        return np.asarray([self.vectors[d] for d in documents]) @ self.vectors[query]


def ranking_auc(rows):
    result = {}
    for key in ("cosine", "lift", "coverage"):
        positive = [r[key] for r in rows if r["label"] == "useful"]
        negative = [r[key] for r in rows if r["label"] == "noise"]
        groups = {}
        for row in rows:
            groups.setdefault(row["traceId"], []).append(row)
        within = [auc([r[key] for r in group if r["label"] == "useful"],
                      [r[key] for r in group if r["label"] == "noise"]) for group in groups.values()]
        within = [v for v in within if v is not None]
        result[key] = {"pooledAuc": auc(positive, negative), "positive": len(positive), "negative": len(negative),
                      "withinQueryMacroAuc": float(np.mean(within)) if within else None, "mixedLabelQueries": len(within)}
    return result


def run(study, bank, output, qwen_model):
    if output.exists():
        raise ValueError("use a fresh independent output")
    output.mkdir(parents=True)
    assessment = read(Path(__file__).with_name("recall-quality-assessment.json"))
    holdout = read(Path(__file__).with_name("recall-holdout.json"))
    excluded = set(holdout["traceIds"])
    selected = {s["traceId"] for s in assessment["samples"]}
    if selected & excluded:
        raise ValueError("evaluation would consume held-out queries")
    frozen = read(study / "protocol.json")["frozenInputs"]
    protocol = {"queries": sorted(selected), "heldoutExcluded": sorted(excluded), "background": BACKGROUND,
        "qwenModel": qwen_model, "backgroundLimits": "Synthetic out-of-topic probes, not a certified irrelevant gold set or deployed background profile.",
        "inputHashes": {str(p): file_hash(p) for p in [Path(__file__), Path(__file__).with_name("recall-quality-assessment.json"),
                      Path(__file__).with_name("recall-holdout.json"), Path(core.__file__), Path(projections.__file__),
                      Path(queries.__file__), BASE / ".tmp/hindsight-e5-small/tokenizer.json",
                      BASE / ".tmp/hindsight-e5-small/config.json"]},
        "limits": "Same frozen selected windows, no world actions, no retain, no runtime switch or threshold reuse."}
    write(output / "protocol.json", protocol)
    documents, samples = {}, []
    for sample in assessment["samples"]:
        record = read(study / "retrieval" / (sample["traceId"] + ".json"))
        archive_path = (bank / record["snapshot"]).with_name("prepared.json")
        if archive_path not in documents:
            data = read(archive_path)
            views = projections.retrieval_projection(data)
            all_views = [v for key in ("facts", "episodes", "observations") for v in views[key]]
            documents[archive_path] = (data, all_views)
            protocol["inputHashes"][str(archive_path)] = file_hash(archive_path)
        data, all_views = documents[archive_path]
        active = {r["id"] for r in record["projectedRecall"].get("rawScores", [])}
        if not active:
            continue
        views = [v for v in all_views if v["id"] in active]
        delivered_trace = record["projected"]["trace"]["delivered"]
        labels = []
        for i, item in enumerate(sample["newReading"]):
            trace = delivered_trace[i]
            assert trace["memoryId"] == item["memoryId"]
            target = {trace["memoryId"]} if item["memoryId"].startswith("obs:") else set(trace["coveredAtomIds"])
            positions = [j for j, v in enumerate(views) if v["memoryId"] in target]
            if not positions:
                raise ValueError("labeled delivery lacks an exact evidence-level search view")
            labels.append({"id": sample["traceId"] + "/" + str(i), "traceId": sample["traceId"], "label": item["label"],
                           "memoryId": item["memoryId"], "targetPositions": positions, "sourceRefs": trace["sourceRefs"]})
        samples.append({"record": record, "scope": data["scope"], "views": views, "labels": labels,
                        "names": aliases(record["requests"]["new"]), "query": record["queryProjection"]["semanticQuery"]})
        protocol["inputHashes"][str(study / "retrieval" / (sample["traceId"] + ".json"))] = file_hash(study / "retrieval" / (sample["traceId"] + ".json"))
    # Fixed final authorized banks for passage-passage distributions and unrelated-topic probes.
    backgrounds = []
    for path in sorted(bank.glob("snapshots/turn-0120/*/prepared.json")):
        data = read(path)
        all_views = projections.retrieval_projection(data)
        units = [v for key in ("facts", "episodes", "observations") for v in all_views[key]]
        owned = [s for s in samples if s["scope"]["characterId"] == data["scope"]["characterId"]]
        names = list(owned[-1]["names"]) if owned else []
        # One deterministic window per memory, then at most 64 memories per level.
        representative = {}
        for v in sorted(units, key=lambda v: hashlib.sha256(v["id"].encode()).hexdigest()):
            representative.setdefault(v["memoryId"], v)
        chosen = []
        for level in ("event_atom", "episode", "observation"):
            pool = [v for v in representative.values() if v["projectionLevel"] == level]
            chosen.extend(sorted(pool, key=lambda v: hashlib.sha256(v["memoryId"].encode()).hexdigest())[:64])
        backgrounds.append({"scope": data["scope"], "allViews": units, "views": chosen, "names": names})
        protocol["inputHashes"][str(path)] = file_hash(path)
    write(output / "protocol.json", protocol)
    encoders = {
        "e5-int8": Encoder("onnx", "e5-int8", BASE / ".tmp/hindsight-e5-small/onnx/model_quantized.onnx"),
        "e5-fp32": Encoder("onnx", "e5-fp32", BASE / ".tmp/hindsight-e5-fp32-761b726/model.onnx"),
        "e5-int8-no-prefix": Encoder("onnx", "e5-int8-no-prefix", BASE / ".tmp/hindsight-e5-small/onnx/model_quantized.onnx", prefixes=False),
        "qwen3": Encoder("ollama", qwen_model),
    }
    variants = [("e5-int8", "e5-int8", False), ("e5-fp32", "e5-fp32", False),
                ("e5-clean", "e5-int8", True), ("e5-clean-no-prefix", "e5-int8-no-prefix", True),
                ("qwen3", "qwen3", False), ("qwen3-clean", "qwen3", True)]
    tasks = {}
    for name, backend, clean in variants:
        enc = encoders[backend]
        prepared = []
        for sample in samples:
            query = clean_text(sample["query"], sample["names"]) if clean else sample["query"]
            texts = [clean_text(v["text"], sample["names"]) if clean else v["text"] for v in sample["views"]]
            prepared.append((sample, enc.add(sample["scope"], query, True),
                             [enc.add(sample["scope"], t) for t in texts], texts, query))
        bg = []
        for value in backgrounds:
            texts = [clean_text(v["text"], value["names"]) if clean else v["text"] for v in value["views"]]
            bg.append((value, [enc.add(value["scope"], t) for t in texts],
                       [enc.add(value["scope"], q, True) for q in BACKGROUND]))
            # Rebuild every final-bank window for the new encoder; never use E5 vectors.
            if name == "qwen3":
                value["fullKeys"] = [enc.add(value["scope"], v["text"]) for v in value["allViews"]]
        tasks[name] = (prepared, bg)
    # Match full input sets and sorted batches for a fair precision comparison.
    encoders["e5-fp32"].pending = dict(encoders["e5-int8"].pending)
    for encoder in encoders.values():
        encoder.fill(output / "vectors")
    if list(encoders["e5-int8"].pending) != list(encoders["e5-fp32"].pending):
        raise ValueError("precision input sets diverged")
    results, scores = {}, {}
    for name, backend, clean in variants:
        enc = encoders[backend]
        readings, distributions, arrays, all_values = [], {}, {}, []
        for sample, query_key, doc_keys, texts, query in tasks[name][0]:
            cosine = enc.score(query_key, doc_keys)
            median = float(np.median(cosine))
            lift = np.maximum(0, (cosine - median) / max(1 - median, 1e-9))
            keyword_query = sample["record"]["queryProjection"]["keywordText"]
            if clean:
                keyword_query = clean_text(keyword_query, sample["names"])
            coverage = coverage_scores(texts, keyword_query)
            arrays[sample["record"]["traceId"]] = cosine
            all_values.extend(cosine.tolist())
            for label in sample["labels"]:
                positions = label["targetPositions"]
                readings.append({**label, "cosine": float(max(cosine[p] for p in positions)),
                                 "lift": float(max(lift[p] for p in positions)),
                                 "coverage": float(max(coverage[p] for p in positions))})
        bg_values, edges, background_by_character = [], {}, {}
        for value, doc_keys, query_keys in tasks[name][1]:
            matrix = np.asarray([enc.vectors[k] for k in doc_keys])
            character_values = []
            for qkey in query_keys:
                character_values.extend((matrix @ enc.vectors[qkey]).tolist())
            bg_values.extend(character_values)
            background_by_character[value["scope"]["characterId"]] = percentiles(character_values)
            for level in ("event_atom", "episode", "observation"):
                positions = [i for i, v in enumerate(value["views"]) if v["projectionLevel"] == level]
                vecs = matrix[positions]
                pair_values = []
                for i in range(len(positions)):
                    for j in range(i + 1, len(positions)):
                        if value["views"][positions[i]]["text"] != value["views"][positions[j]]["text"]:
                            pair_values.append(float(vecs[i] @ vecs[j]))
                edges.setdefault(level, []).extend(pair_values)
        distributions["currentQueryAllWindows"] = percentiles(all_values)
        distributions["syntheticBackground"] = percentiles(bg_values)
        distributions["labelNoise"] = percentiles([r["cosine"] for r in readings if r["label"] == "noise"])
        distributions["labelUseful"] = percentiles([r["cosine"] for r in readings if r["label"] == "useful"])
        results[name] = {"auc": ranking_auc(readings), "distributions": distributions,
            "syntheticBackgroundByCharacter": background_by_character,
            "sameLevelPassagePairs": {k: {**percentiles(v), "fractionAtLeast080": sum(x >= .8 for x in v) / len(v) if v else None}
                                     for k, v in edges.items()},
            "metadata": enc.metadata, "encodeSecondsIncludingLoad": enc.seconds}
        scores[name] = (readings, arrays)
        write(output / (name + "-scores.json"), readings)
    # Paired numeric/ordering/gate sensitivity, no behavioral interpretation.
    recorded_rows = []
    for sample in samples:
        raw_by_id = {r["id"]: r for r in sample["record"]["projectedRecall"]["rawScores"]}
        for label in sample["labels"]:
            raw = [raw_by_id[sample["views"][i]["id"]] for i in label["targetPositions"]]
            recorded_rows.append({**label, "cosine": max(r["semanticSimilarity"] for r in raw),
                                  "lift": max(r["semanticLift"] for r in raw),
                                  "coverage": max(r["keywordCoverage"] for r in raw)})
    differences, inversions, comparisons, gate_flips, near_flips, near_count = [], 0, 0, 0, 0, 0
    recorded_differences = []
    for sample in samples:
        ident = sample["record"]["traceId"]
        low, high = scores["e5-int8"][1][ident], scores["e5-fp32"][1][ident]
        differences.extend((high - low).tolist())
        old = {r["id"]: r["semanticSimilarity"] for r in sample["record"]["projectedRecall"]["rawScores"]}
        recorded_differences.extend(abs(float(v) - old[unit["id"]]) for unit, v in zip(sample["views"], low))
        median = [float(np.median(v)) for v in (low, high)]
        coverage = coverage_scores([v["text"] for v in sample["views"]], sample["record"]["queryProjection"]["keywordText"])
        for i in range(len(low)):
            lifts = [max(0, (float(v[i]) - m) / max(1 - m, 1e-9)) for v, m in zip((low, high), median)]
            gates = [float(v[i]) >= .3 and x >= .3 or coverage[i] >= .15 for v, x in zip((low, high), lifts)]
            flipped = gates[0] != gates[1]
            gate_flips += flipped
            near = abs(lifts[0] - .3) <= .05 or abs(coverage[i] - .15) <= .02
            near_count += near
            near_flips += near and flipped
            for j in range(i + 1, len(low)):
                if sample["views"][i]["memoryId"] == sample["views"][j]["memoryId"]:
                    continue
                # Ignore effectively tied vectors.
                if abs(float(low[i] - low[j])) < 1e-7 or abs(float(high[i] - high[j])) < 1e-7:
                    continue
                comparisons += 1
                inversions += (low[i] > low[j]) != (high[i] > high[j])
    quantization = {"signedFp32MinusInt8": percentiles(differences),
        "absoluteCosineDifference": percentiles([abs(v) for v in differences]),
        "maximumAbsoluteDifference": max(abs(v) for v in differences),
        "pairwiseOrderFlips": int(inversions), "comparablePairs": comparisons,
        "gateFlips": int(gate_flips), "nearGateWindows": int(near_count), "nearGateFlips": int(near_flips),
        "reencodedInt8VersusRecorded": percentiles(recorded_differences),
        "limits": "Both precisions use identical sorted batches of 8; historical int8 cache used different batch groupings. Gates are sensitivity probes only."}
    for value in backgrounds:
        enc = encoders["qwen3"]
        actor = value["scope"]["characterId"].split(":")[-1]
        path = output / "qwen3-rebuilt" / actor
        write(path / "mapping.json", {"scope": value["scope"], "units": value["allViews"], "embedding": enc.metadata,
                                     "dimensions": enc.dimension, "recallThresholds": None, "semanticEdgeThreshold": None})
        np.save(path / "vectors.npy", np.asarray([enc.vectors[k] for k in value["fullKeys"]]))
    for path, expected in {**frozen, **protocol["inputHashes"]}.items():
        if file_hash(Path(path)) != expected:
            raise ValueError("frozen evidence changed")
    summary = {"variants": results, "quantization": quantization, "selectedQueries": len(selected),
        "nonSkippedQueries": len(samples), "recordedBaselineAuc": ranking_auc(recorded_rows), "labeledItems": len(scores["e5-int8"][0]), "holdoutEvaluated": False,
        "frozenFilesVerified": len(frozen), "aucUnit": "Exact delivered evidence views; Episode label is not applied to its unrelated windows.",
        "limitations": ["5 useful vs 10 noise is a selected-survivor development sample, not recall gold",
            "pooled AUC compares across different queries; within-query may be undefined",
            "synthetic negative stimuli are topic controls, not deployment calibration",
            "prefix removal is an intentionally unsupported E5 ablation, not the recommended protocol",
            "only aliases currently authorized in Context are removed; absent-person aliases may remain",
            "no runtime encoder or gate was switched, no Character Turn calls"]}
    write(output / "summary.json", summary)
    print(json.dumps({"completed": True, "variants": len(variants), "holdoutEvaluated": False}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--study", type=Path, default=BASE / ".tmp/hindsight-recall-quality-20261001-improved-v3")
    parser.add_argument("--bank", type=Path, default=BASE / ".tmp/hindsight-prefix-study-20260930-v2")
    parser.add_argument("--qwen-model", default="qwen3-embedding:0.6b")
    args = parser.parse_args()
    run(args.study, args.bank, args.output, args.qwen_model)
