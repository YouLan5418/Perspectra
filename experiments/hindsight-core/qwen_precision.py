"""Same Qwen GGUF revision Q8_0/F16 comparison, repetition and batch-size sensitivity."""
import argparse
from pathlib import Path
import numpy as np
from embedding_study import Encoder, read, write, normalized, percentiles, TASK, file_hash


def difference(samples, left, right, tasks):
    values, flips, pairs = [],0,0
    for sample in samples:
        qkey,dkeys=tasks[sample["id"]]
        if qkey is None or not dkeys:
            continue
        a=left.score(qkey,dkeys);b=right.score(qkey,dkeys)
        values.extend((b-a).tolist())
        memories=[v["memoryId"] for v in sample["views"]]
        for i in range(len(a)):
            for j in range(i+1,len(a)):
                if memories[i]==memories[j] or abs(float(a[i]-a[j]))<1e-7 or abs(float(b[i]-b[j]))<1e-7:
                    continue
                pairs+=1;flips+=bool((a[i]>a[j])!=(b[i]>b[j]))
    return {"signedRightMinusLeft":percentiles(values),"absoluteDifference":percentiles([abs(v) for v in values]),
            "maximumAbsoluteDifference":max([abs(v) for v in values],default=0),
            "comparableDifferentMemoryWindowPairs":pairs,"pairwiseOrderFlips":flips,
            "flipFraction":flips/pairs if pairs else None}


def singles(original):
    clone=Encoder("ollama",original.model)
    clone.pending=dict(original.pending)
    for i,key in enumerate(sorted(original.pending)):
        text=f"Instruct: {TASK}\nQuery: {key[2]}" if key[1] else key[2]
        answer=clone.http("/api/embed",{"model":clone.model,"input":[text],"truncate":False,
                                      "keep_alive":"15m","options":{"num_ctx":2048}})
        if len(answer["embeddings"])!=1:
            raise ValueError("singleton count changed")
        arr=normalized(answer["embeddings"])
        if arr.shape!=(1,original.dimension):
            raise ValueError("singleton dimension changed")
        clone.vectors[key]=arr[0]
        if (i+1)%100==0:
            print('{"singleInputs":'+str(i+1)+'}',flush=True)
    return clone


def run(pool,output,fp16):
    if output.exists():
        raise ValueError("use new independent output")
    output.mkdir(parents=True)
    private=read(pool/"private-pool.json")
    samples=[{"id":ident,**value} for ident,value in private["queries"].items()]
    runs={}
    tasks={}
    for name,model in [("q8-first","qwen3-embedding:0.6b"),("q8-repeat","qwen3-embedding:0.6b"),
                       ("f16-first",fp16),("f16-repeat",fp16)]:
        encoder=Encoder("ollama",model)
        for sample in samples:
            qkey=encoder.add(sample["scope"],sample["cleanedQuery"],True) if sample["cleanedQuery"] else None
            dkeys=[encoder.add(sample["scope"],v["retrievalText"]) for v in sample["views"]]
            tasks[sample["id"]]=(qkey,dkeys)
        encoder.fill(output/name)
        runs[name]=encoder
    q8show=Encoder.http("/api/show",{"model":"qwen3-embedding:0.6b"})
    f16show=Encoder.http("/api/show",{"model":fp16})
    q8hash="06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439"
    f16hash="421a27e58d165478cc7acb984a688c2aa41404968b0203e7cd743ece44c54340"
    if q8hash not in q8show["modelfile"] or f16hash not in f16show["modelfile"]:
        raise ValueError("model blobs are not the verified paired official GGUFs")
    q8single=singles(runs["q8-first"])
    f16single=singles(runs["f16-first"])
    result={"poolDatasetId":private["datasetId"],"poolFileHash":file_hash(pool/"private-pool.json"),
        "models":{k:enc.metadata for k,enc in runs.items()},
        "officialRepo":"Qwen/Qwen3-Embedding-0.6B-GGUF",
        "officialRevision":"370f27d7550e0def9b39c1f16d3fbaa13aa67728","verifiedBlobs":{"Q8_0":q8hash,"F16":f16hash},
        "q8Repeat":difference(samples,runs["q8-first"],runs["q8-repeat"],tasks),
        "f16Repeat":difference(samples,runs["f16-first"],runs["f16-repeat"],tasks),
        "q8Batch8VersusSingle":difference(samples,runs["q8-first"],q8single,tasks),
        "f16Batch8VersusSingle":difference(samples,runs["f16-first"],f16single,tasks),
        "q8VersusF16":difference(samples,runs["q8-first"],runs["f16-first"],tasks),
        "holdoutEvaluated":False,"thresholdApplied":False,
        "limits":"Numeric and rank sensitivity only, no relevance labels, frozen E5 windows; no model-quality or Character Turn conclusion."}
    write(output/"summary.json",result)
    print('{"precisionStudyComplete":true}',flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("pool",type=Path);parser.add_argument("output",type=Path)
    parser.add_argument("--fp16-model",default="perspectra-qwen3-embedding-0.6b-fp16:latest")
    a=parser.parse_args();run(a.pool,a.output,a.fp16_model)
