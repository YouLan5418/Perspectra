"""Human-first evaluation; explicit model mode is exploratory. Pool recall is not full-archive recall."""
import argparse
import math
from pathlib import Path
import numpy as np
from embedding_study import read, write, auc, percentiles

LABELS = {"useful","background","irrelevant","harmful","uncertain"}
NEEDS = {"none","some","missing","uncertain"}


def validate(private, labels, reviewer="human"):
    if labels.get("datasetId") != private["datasetId"] or labels.get("reviewer") != reviewer or reviewer not in {"human","model"}:
        raise ValueError("expected "+reviewer+" labels for this pool")
    if not isinstance(labels.get("queries"),dict):
        raise ValueError("missing query labels")
    complete = {}
    for qid, answer in labels["queries"].items():
        if qid not in private["queries"]:
            raise ValueError("unknown labeled query")
        pool = private["queries"][qid]["candidates"]
        given = answer.get("labels")
        if not isinstance(given,dict) or any(k not in pool or v not in LABELS for k,v in given.items()):
            raise ValueError("unknown candidate or label")
        if answer.get("need") not in NEEDS and answer.get("need") is not None:
            raise ValueError("unknown query need")
        if set(given)==set(pool) and answer.get("need") in {"none","some"} and "uncertain" not in given.values():
            useful = {k for k,v in given.items() if v=="useful"}
            if (answer["need"]=="some") != bool(useful):
                raise ValueError("query need conflicts with useful labels")
            complete[qid] = answer
    return complete


def metrics(ranking, candidate_map, labels, k):
    reverse = {value["memoryId"]:key for key,value in candidate_map.items()}
    relevant = {key for key,label in labels.items() if label=="useful"}
    top = ranking[:k]
    if any(row["memoryId"] not in reverse for row in top):
        raise ValueError("unjudged top-K; enlarge the pool")
    hits = [1 if labels[reverse[row["memoryId"]]]=="useful" else 0 for row in top]
    dcg = sum(gain/math.log2(i+2) for i,gain in enumerate(hits))
    ideal = sum(1/math.log2(i+2) for i in range(min(k,len(relevant))))
    return {"precision":sum(hits)/k,"poolRecall":sum(hits)/len(relevant) if relevant else None,
            "ndcg":dcg/ideal if ideal else None, "anyIrrelevant":any(not h for h in hits),
            "empty":not top}


def interval(values, draws=5000, seed=20261001, clusters=None):
    if not values:
        return {"nQueries":0,"nClusters":0,"mean":None,"interval95":None}
    rng = np.random.default_rng(seed)
    groups={}
    for cluster,value in zip(clusters or list(range(len(values))),values):
        groups.setdefault(cluster,[]).append(value)
    group_sums=np.asarray([sum(v) for v in groups.values()])
    group_counts=np.asarray([len(v) for v in groups.values()])
    idx=rng.integers(0,len(groups),size=(draws,len(groups)))
    boot=group_sums[idx].sum(axis=1)/group_counts[idx].sum(axis=1)
    return {"nQueries":len(values),"nClusters":len(groups),"mean":float(np.mean(values)),
            "interval95":[float(x) for x in np.percentile(boot,[2.5,97.5])],
            "method":"player-turn cluster percentile bootstrap; same turn character requests resampled together"}


def evaluate(private, labels, reviewer="human"):
    judged = validate(private,labels,reviewer=reviewer)
    if not judged:
        raise ValueError("no fully reviewed, determinate "+reviewer+"-labeled queries")
    k=private["topK"]
    results, per_query = {}, {}
    for system in private["systems"]:
        rows=[]
        for qid,answer in judged.items():
            query=private["queries"][qid]
            row=metrics(query["rankings"][system],query["candidates"],answer["labels"],k)
            # Only within this query; no cross-query pooled AUC.
            scores={r["memoryId"]:r["score"] for r in query["rankings"][system]}
            pos=[scores.get(query["candidates"][cid]["memoryId"],0) for cid,label in answer["labels"].items() if label=="useful"]
            neg=[scores.get(query["candidates"][cid]["memoryId"],0) for cid,label in answer["labels"].items() if label in {"irrelevant","harmful"}]
            row["withinQueryAuc"]=auc(pos,neg)
            rows.append((qid,row))
        per_query[system]=dict(rows)
        results[system]={key:interval([r[key] for _,r in rows if r[key] is not None],
                                     clusters=[private["queries"][qid].get("clusterId",qid) for qid,r in rows if r[key] is not None])
                         for key in ("precision","poolRecall","ndcg","withinQueryAuc")}
    differences={}
    for left,right in [("qwen-clean","e5-clean"),("e5-clean+bm25","e5-clean"),("qwen-clean+bm25","qwen-clean")]:
        differences[left+" minus "+right]={}
        for key in ("precision","poolRecall","ndcg","withinQueryAuc"):
            values=[per_query[left][qid][key]-per_query[right][qid][key] for qid in judged
                    if per_query[left][qid][key] is not None and per_query[right][qid][key] is not None]
            clusters=[private["queries"][qid].get("clusterId",qid) for qid in judged
                      if per_query[left][qid][key] is not None and per_query[right][qid][key] is not None]
            differences[left+" minus "+right][key]=interval(values,clusters=clusters)
    none=[qid for qid,a in judged.items() if a["need"]=="none"]
    none_top={}
    for system in ("e5-raw","e5-clean","qwen-clean","bm25-clean"):
        values=[private["queries"][qid]["rankings"][system][0]["score"] for qid in none
                if private["queries"][qid]["rankings"][system]]
        none_top[system]={"nNoUsefulQueries":len(none),"nonemptyWithoutGate":len(values),
                          "topScore":percentiles(values)}
    # A diagnostic threshold curve from same-domain labels, no threshold chosen or applied.
    curve={}
    for system in ("e5-clean","qwen-clean"):
        samples=[]
        for qid,a in judged.items():
            q=private["queries"][qid]
            scores={r["memoryId"]:r["score"] for r in q["rankings"][system]}
            samples.extend((scores.get(q["candidates"][cid]["memoryId"],float("-inf")),label,qid)
                           for cid,label in a["labels"].items())
        thresholds=sorted({score for score,_,_ in samples if math.isfinite(score)})
        points=[]
        for threshold in thresholds:
            tp=sum(score>=threshold and label=="useful" for score,label,_ in samples)
            fp=sum(score>=threshold and label!="useful" for score,label,_ in samples)
            fn=sum(score<threshold and label=="useful" for score,label,_ in samples)
            false_empty=sum(bool(private["queries"][qid]["rankings"][system]) and private["queries"][qid]["rankings"][system][0]["score"]>=threshold for qid in none)
            points.append({"threshold":threshold,"tp":tp,"fp":fp,"fn":fn,
                           "precision":tp/(tp+fp) if tp+fp else None,"poolPositiveRecall":tp/(tp+fn) if tp+fn else None,
                           "noUsefulQueryAdmission":false_empty/len(none) if none else None})
        curve[system]=points
    return {"datasetId":private["datasetId"],"reviewer":reviewer,"humanGold":reviewer=="human","judgedQueries":len(judged),"totalQueries":len(private["queries"]),
            "rankingAtK":k,"systems":results,"pairedDifferences":differences,
            "noUsefulQueries":none_top,"thresholdCurves":curve,"thresholdSelected":False,"holdoutEvaluated":False,
            "limits":["pool recall denominator is useful items found in this pool, not all relevant archive memories",
                      "missing/uncertain/partial queries are excluded and must be reported, not converted to negatives",
                      "same-turn clusters remove duplicate current stimulus correlation; long experiences spanning turns may remain correlated; intervals exploratory",
                      "partial completed queries can have completion-order selection bias; no model choice from partial reviews"],
            "excludedQueries":len(private["queries"])-len(judged),"perQuery":per_query}


if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("pool",type=Path);p.add_argument("labels",type=Path);p.add_argument("output",type=Path)
    a=p.parse_args()
    if a.output.exists():
        p.error("use a fresh evaluation output")
    write(a.output,evaluate(read(a.pool/"private-pool.json"),read(a.labels)))
