"""Ungated, character-scoped pooled retrieval; reviewer payload never contains system scores."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from collections import Counter
from pathlib import Path
import numpy as np
import core
import projections
import queries
import retrieval_text
from embedding_study import Encoder, BASE, read, write, file_hash, percentiles


SYSTEMS = ("e5-raw", "e5-clean", "qwen-clean", "bm25-clean", "e5-clean+bm25", "qwen-clean+bm25")


def collapse(views, scores, positive_only=False):
    by_memory = {}
    for view, score in zip(views, scores):
        if positive_only and score <= 0:
            continue
        row = {"memoryId": view["memoryId"], "score": float(score), "viewId": view["id"]}
        previous = by_memory.get(row["memoryId"])
        if previous is None or (row["score"], row["viewId"]) > (previous["score"], previous["viewId"]):
            by_memory[row["memoryId"]] = row
    return sorted(by_memory.values(), key=lambda r:(-r["score"], r["memoryId"]))


def bm25(texts, query):
    terms = set(queries.lexical_terms(query))
    bags = [Counter(queries.lexical_terms(t)) for t in texts]
    for term in terms:
        if len(term) == 1 and "\u3400" <= term <= "\u9fff":
            for bag, text in zip(bags, texts):
                bag[term] = text.count(term)
    df = Counter(t for bag in bags for t in bag)
    n = len(bags)
    average = sum(sum(b.values()) for b in bags) / max(n, 1)
    idf = {t:math.log(1+(n-df[t]+.5)/(df[t]+.5)) for t in terms}
    return [sum(idf[t]*bag[t]*2.5/(bag[t]+1.5*(.25+.75*sum(bag.values())/max(average,1)))
                for t in terms if bag[t]) for bag in bags]


def rrf(*rankings):
    merged = {}
    for ranking in rankings:
        for rank, row in enumerate(ranking, 1):
            ident = row["memoryId"]
            merged[ident] = merged.get(ident, 0) + 1/(60+rank)
    return sorted([{"memoryId":ident,"score":score} for ident,score in merged.items()],
                  key=lambda r:(-r["score"],r["memoryId"]))


def past_names(raw, scope):
    history = []
    actor = scope["characterId"]
    for path in sorted((raw/"traces").glob("*.json")):
        if not path.stem.endswith("-" + actor.split(":")[-1]):
            continue
        value = read(path)
        context = value["hostRequest"]["context"]
        if value["actorId"] != actor or context["character"]["characterId"] != actor:
            raise ValueError("historical Context crosses owner")
        # Only identity metadata is used, never historical stimulus, answer or holdout outcome.
        history.append({"scope":scope, "worldSeq":value["headSeq"],
                        "people":retrieval_text.context_names(context)})
    return history


def scrub(value):
    if isinstance(value, dict):
        return {k:scrub(v) for k,v in value.items()
                if k not in {"tick", "worldSeq", "sourceSeq", "sourceId", "sourceHash", "memoryId", "eventId", "asOfWorldSeq"}}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def reading(unit, by_id, sources, tick=None):
    level = unit["memoryLevel"]
    ids = [unit["id"]] if level == "event_atom" else unit.get("eventAtomIds", unit.get("sourceFactIds", []))
    segments, seen = [], set()
    if level == "observation":
        segments.append("【角色的主观认识，可修正】" + unit["text"])
    for ident in ids:
        atom = by_id[ident]
        e = atom["evidence"]
        key = (e["sourceId"], e["channel"], e["context"])
        if key in seen:
            continue
        seen.add(key)
        label = projections.episode.LABELS[e["channel"]]
        actor = (e.get("actorId") or "") + ("：" if e.get("actorId") else "")
        prefix = "【反驳认识的证据】" if ident in unit.get("contradictingAtomIds", []) else ""
        age = tick - sources[e["sourceId"]]["knownTick"] if tick is not None else None
        if age is not None and age < 0:
            raise ValueError("future knowledge in review reading")
        timing = "【" + str(age) + " tick前获知】" if age is not None else ""
        segments.append(timing + prefix + "【" + label + "】" + actor + e["context"])
    return segments


def opaque(seed, text):
    return hashlib.sha256((seed + "|" + text).encode()).hexdigest()[:20]


def run(output, study, bank, raw, top_k=5):
    if output.exists():
        raise ValueError("use a new independent output")
    output.mkdir(parents=True)
    assessment = read(Path(__file__).with_name("recall-quality-assessment.json"))
    holdout = set(read(Path(__file__).with_name("recall-holdout.json"))["traceIds"])
    selected = [s["traceId"] for s in assessment["samples"]]
    if set(selected) & holdout:
        raise ValueError("pool consumes heldout queries")
    frozen = read(study/"protocol.json")["frozenInputs"]
    protocol = {"selectedQueries":selected, "heldoutExcluded":sorted(holdout), "topK":top_k, "systems":SYSTEMS,
                "rrfK":60, "labelsGenerated":False, "thresholdsApplied":False,
                "aliasRule":retrieval_text.RULE, "windows":"unchanged E5 220-token windows",
                "metadataOnlyHistory":"Past same-owner Context names/IDs; cutoff at snapshot asOfWorldSeq; no holdout stimuli or outcomes used",
                "inputHashes":{str(p):file_hash(p) for p in [Path(__file__),Path(projections.__file__),Path(retrieval_text.__file__)]}}
    histories, archives, samples = {}, {}, []
    encoders = {"e5":Encoder("onnx","e5-pooled", BASE/".tmp/hindsight-e5-small/onnx/model_quantized.onnx"),
                "qwen":Encoder("ollama","qwen3-embedding:0.6b")}
    for ident in selected:
        path = study/"retrieval"/(ident+".json")
        record = read(path)
        archive_path = (bank/record["snapshot"]).with_name("prepared.json")
        if archive_path not in archives:
            doc = read(archive_path)
            owner = doc["scope"]["characterId"]
            if owner not in histories:
                histories[owner] = past_names(raw, doc["scope"])
            projection = projections.retrieval_projection(doc, alias_history=histories[owner])
            views = [v for k in ("facts","episodes","observations") for v in projection[k]]
            archives[archive_path] = (doc,projection,views)
            folder = output/"projections"/archive_path.parent.parent.name/archive_path.parent.name
            write(folder/"retrieval.json",projection)
            protocol["inputHashes"][str(archive_path)] = file_hash(archive_path)
        doc, projection, all_views = archives[archive_path]
        request = record["requests"]["new"]
        if request["context"]["character"]["characterId"] != doc["scope"]["characterId"]:
            raise ValueError("pool query crosses owner")
        recent = {o["sourceSeq"] for o in request["context"].get("observations",[]) + request["context"].get("selfObservations",[])}
        views = [v for v in all_views if v["projectionLevel"] == "observation"
                 or not all(r["worldSeq"] in recent for r in v["sourceRefs"])]
        query = record["queryProjection"]["semanticQuery"]
        keyword = record["queryProjection"]["keywordText"]
        cleaned = retrieval_text.query_text(query,projection)
        cleaned_keyword = retrieval_text.query_text(keyword,projection)
        e5, qwen = encoders["e5"],encoders["qwen"]
        samples.append({"traceId":ident,"tick":record["tick"],"doc":doc,"projection":projection,"views":views,"request":request,
            "query":query,"cleanedQuery":cleaned,"cleanedKeyword":cleaned_keyword,
            "e5rawQuery":e5.add(doc["scope"],query,True) if query else None,
            "e5cleanQuery":e5.add(doc["scope"],cleaned,True) if cleaned else None,
            "qwenQuery":qwen.add(doc["scope"],cleaned,True) if cleaned else None,
            "e5rawDocs":[e5.add(doc["scope"],v["text"]) for v in views],
            "e5cleanDocs":[e5.add(doc["scope"],v["retrievalText"]) for v in views],
            "qwenDocs":[qwen.add(doc["scope"],v["retrievalText"]) for v in views]})
        protocol["inputHashes"][str(path)] = file_hash(path)
    for encoder in encoders.values():
        encoder.fill(output/"vectors")
    seed = file_hash(Path(__file__)) + "|pooled-dev-20261001"
    blind, private, cases = [], {}, []
    for sample in samples:
        views, scope = sample["views"],sample["doc"]["scope"]
        ranking, arrays = {}, {}
        for name, backend, qkey, docs in [
            ("e5-raw","e5","e5rawQuery","e5rawDocs"), ("e5-clean","e5","e5cleanQuery","e5cleanDocs"),
            ("qwen-clean","qwen","qwenQuery","qwenDocs")]:
            if sample[qkey] is not None and views:
                arr = encoders[backend].score(sample[qkey],sample[docs])
                ranking[name] = collapse(views,arr)
            else:
                arr = np.zeros(len(views))
                ranking[name] = []
            arrays[name] = arr.tolist()
        bm = bm25([v["retrievalText"] for v in views],sample["cleanedKeyword"])
        ranking["bm25-clean"] = collapse(views,bm,positive_only=True)
        ranking["e5-clean+bm25"] = rrf(ranking["e5-clean"],ranking["bm25-clean"])
        ranking["qwen-clean+bm25"] = rrf(ranking["qwen-clean"],ranking["bm25-clean"])
        pool = sorted({r["memoryId"] for rows in ranking.values() for r in rows[:top_k]})
        qid = opaque(seed,sample["traceId"])
        by_id,sources = projections.archive(sample["doc"])
        items, mapping = [], {}
        for memory in pool:
            cid = opaque(seed,sample["traceId"]+"|"+memory)
            unit = by_id[memory]
            items.append({"id":cid,"segments":reading(unit,by_id,sources,sample["tick"])})
            mapping[cid] = {"memoryId":memory,"sourceRefs":unit["sourceRefs"],
                            "projectionLevel":unit["memoryLevel"]}
        items.sort(key=lambda item:opaque(seed,item["id"]))
        context = {k:v for k,v in sample["request"]["context"].items() if k != "memories"}
        blind.append({"id":qid,"context":scrub(context),"candidates":items})
        private[qid] = {"traceId":sample["traceId"],"clusterId":sample["traceId"].split("-call-")[0],"scope":scope,"candidates":mapping,"rankings":ranking,
                        "rawScores":{v["id"]:{name:arr[i] for name,arr in arrays.items()} for i,v in enumerate(views)},
                        "cleanedQuery":sample["cleanedQuery"],"queryMode":read(study/"retrieval"/(sample["traceId"]+".json"))["queryProjection"]["mode"],
                        "views":views,"aliases":sample["projection"]["retrievalAliases"]}
        if sample["traceId"] in {"turn-0063-call-001-companion","turn-0082-call-002-host","turn-0091-call-001-friend","turn-0049-call-001-friend"}:
            old = next(s for s in assessment["samples"] if s["traceId"] == sample["traceId"])
            for label in old["newReading"]:
                if label["label"] not in {"useful","noise"}:
                    continue
                original = read(study/"retrieval"/(sample["traceId"]+".json"))
                delivered = next(t for t in original["projected"]["trace"]["delivered"] if t["memoryId"]==label["memoryId"])
                target = set(delivered.get("coveredAtomIds",[delivered["memoryId"]]))
                positions = [i for i,v in enumerate(views) if v["memoryId"] in target]
                cases.append({"traceId":sample["traceId"],"memoryId":label["memoryId"],"oldLabel":label["label"],
                              "query":sample["query"],"cleanedQuery":sample["cleanedQuery"],
                              "text":label["text"],"cleanedTexts":[views[i]["retrievalText"] for i in positions],
                              "scores":{name:max(arr[i] for i in positions) for name,arr in arrays.items()},
                              "inPool":label["memoryId"] in pool or bool(target & set(pool))})
    blind.sort(key=lambda row:opaque(seed,row["id"]))
    dataset_id = hashlib.sha256(json.dumps(blind,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    payload = {"datasetId":dataset_id,"topK":top_k,"queries":blind}
    write(output/"blind-pool.json",payload)
    write(output/"private-pool.json",{"datasetId":dataset_id,"queries":private,"systems":SYSTEMS,"topK":top_k})
    write(output/"case-recheck.json",cases)
    from pool_review import page
    (output/"review.html").write_text(page(payload),encoding="utf-8")
    protocol["datasetId"] = dataset_id
    protocol["encoderMetadata"] = {k:e.metadata for k,e in encoders.items()}
    for path, expected in {**frozen,**protocol["inputHashes"]}.items():
        if file_hash(Path(path)) != expected:
            raise ValueError("frozen input changed")
    write(output/"protocol.json",protocol)
    summary = {"queries":len(blind),"candidateItems":sum(len(q["candidates"]) for q in blind),
               "emptyPools":sum(not q["candidates"] for q in blind),"heldoutEvaluated":False,
               "labelsGenerated":False,"frozenFilesVerified":len(frozen),"cases":cases}
    write(output/"summary.json",summary)
    print(json.dumps({k:v for k,v in summary.items() if k != "cases"}),flush=True)


if __name__ == "__main__":
    p=argparse.ArgumentParser()
    p.add_argument("output",type=Path)
    p.add_argument("--study",type=Path,default=BASE/".tmp/hindsight-recall-quality-20261001-improved-v3")
    p.add_argument("--bank",type=Path,default=BASE/".tmp/hindsight-prefix-study-20260930-v2")
    p.add_argument("--raw",type=Path,default=BASE/".tmp/hindsight-continuous-20260930-v3")
    p.add_argument("--top-k",type=int,default=5)
    a=p.parse_args()
    if not 1 <= a.top_k <= 32:
        p.error("top-k must be 1..32")
    run(a.output,a.study,a.bank,a.raw,a.top_k)
