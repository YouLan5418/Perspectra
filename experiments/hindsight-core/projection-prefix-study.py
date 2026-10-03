"""Replay frozen queries with projections; never retain, consolidate or open world stores."""
import argparse
import copy
import hashlib
import json
import statistics
from collections import Counter
from pathlib import Path
import projections as projection
import vector_core as vector
import core

p=argparse.ArgumentParser()
p.add_argument('original',type=Path);p.add_argument('bank',type=Path);p.add_argument('output',type=Path)
a=p.parse_args();original,bank,out=(v.resolve() for v in (a.original,a.bank,a.output))
if out in (original,bank) or original in out.parents or bank in out.parents:
    raise ValueError('output must be independent of frozen inputs')
out.mkdir(parents=True,exist_ok=True)
read=lambda path:json.loads(path.read_text(encoding='utf-8'))
def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
protocol_path=out/'protocol.json'
if protocol_path.exists():protocol=read(protocol_path)
else:
    frozen={str(path):digest(path) for path in bank.rglob('*.json')}
    frozen.update({str(original/rel):h for rel,h in read(bank/'protocol.json')['originalHashes'].items()})
    protocol={'model':read(bank/'protocol.json')['model'],'original':str(original),'bank':str(bank),
              'expectedReturnedCalls':135,'maxJsonChars':4500,'maxItems':8,
              'frozenInputs':frozen,'codeHashes':{f:digest(Path(__file__).parent/f) for f in ['projections.py','vector_core.py','projection-prefix-study.py']},
              'limits':'immutable cognitive bank; query replay plus independent first decisions, not a new world trajectory'}
    write(protocol_path,protocol)
if any(digest(Path(path))!=h for path,h in protocol['frozenInputs'].items()):
    raise ValueError('frozen input changed')
if any(digest(Path(__file__).parent/f)!=h for f,h in protocol['codeHashes'].items()):
    raise ValueError('projection code changed; use a new output directory')
count=projection.token_counter()
indexes={}
for path in sorted((bank/'snapshots').glob('*/*/prepared.json')):
    rel=path.relative_to(bank);data=read(path)
    indexpath=out/rel.parent/'retrieval-index.json'
    if indexpath.exists():idx=read(indexpath)
    else:
        views=projection.retrieval_projection(data,count)
        idx=vector.index(views)
        write(indexpath,idx)
    indexes[str(rel.parent/'index.json')]=idx
    print(json.dumps({'indexed':str(rel),'views':len(idx['units'])}),flush=True)

def delivery_metrics(result):
    trace=result['trace'];memories=result['memories']
    evidence=[i for row in trace['delivered'] for i in row.get('coveredAtomIds',[])]
    refs=[r for row in trace['delivered'] if 'coveredAtomIds' in row for r in row['sourceRefs']]
    return {'jsonChars':projection.chars(memories),'textChars':sum(len(m['text']) for m in memories),
        'units':len(memories),'levels':dict(Counter(m['memoryLevel'] for m in memories)),
        'distinctEvidenceSegments':trace['distinctEvidenceSegments'],
        'coveredAtomCount':len(set(evidence)),
        'evidenceSourceCount':len({r['sourceId'] for r in refs}),
        'omitted':dict(Counter(row['reason'] for row in trace['omitted']))}

measurements=[]
for path in sorted((original/'traces').glob('*.json')):
    trace=read(path);destination=out/'retrieval'/(trace['id']+'.json')
    if destination.exists():
        measurements.append(read(destination)['metrics']);continue
    prior=read(bank/'retrieval'/(trace['id']+'.json'));data=read((bank/trace['snapshot']).with_name('prepared.json'))
    assert prior['requests']['native']==trace['hostRequest']
    assert data['scope']['characterId']==trace['actorId']
    assert data['scope']['asOfWorldSeq']<=trace['headSeq']
    by_id,sources=projection.archive(data)
    recent={int(o['sourceSeq']) for o in trace['hostRequest']['context'].get('observations',[])+trace['hostRequest']['context'].get('selfObservations',[])}
    recalled=projection.search(indexes[trace['snapshot']],data['scope'],trace['query'],recent)
    delivered=projection.delivery_projection(data,recalled['results'],trace['hostRequest'],trace['tick'])
    delivery_only=projection.delivery_projection(data,prior['new']['results'],trace['hostRequest'],trace['tick'])
    for result in (delivered,delivery_only):
        assert result['trace']['jsonChars']<=protocol['maxJsonChars']
        for row in result['trace']['delivered']:
            for ref in row['sourceRefs']:assert core.source_ref(sources[ref['sourceId']])==ref
    baseline=prior['requests']['new']
    def request(memories):
        value=copy.deepcopy(baseline);value['context']['memories']=memories
        if 'recallEvidence' in value:value['recallEvidence']['memories']=memories
        return value
    new=request(delivered['memories']);shadow=request(delivery_only['memories'])
    old_rest=copy.deepcopy(baseline);new_rest=copy.deepcopy(new)
    old_rest['context'].pop('memories',None);new_rest['context'].pop('memories',None)
    if 'recallEvidence' in old_rest:
        old_rest['recallEvidence'].pop('memories',None);new_rest['recallEvidence'].pop('memories',None)
    assert old_rest==new_rest
    metrics={'traceId':trace['id'],'playerTurn':trace['playerTurn'],'actorId':trace['actorId'],
        'baselineJsonChars':projection.chars(baseline['context']['memories']),
        'deliveryOnly':delivery_metrics(delivery_only),'projected':delivery_metrics(delivered),
        'observationIds':[m['memoryId'] for m in delivered['memories'] if m['memoryLevel']=='observation'],
        'oldNewSameMemories':baseline['context']['memories']==delivered['memories'],
        'candidateCount':len(recalled['results']),'clusterCount':len(delivered['trace']['clusters'])}
    comparison={'traceId':trace['id'],'query':trace['query'],'snapshot':trace['snapshot'],
        'tick':trace['tick'],'headSeq':trace['headSeq'],'originalResponse':trace['modelResponse'],
        'baselineRecall':prior['new'],'projectedRecall':recalled,'deliveryOnly':delivery_only,'projected':delivered,
        'metrics':metrics,'requests':{'native':trace['hostRequest'],'old':baseline,'new':new,'delivery':shadow}}
    write(destination,comparison);measurements.append(metrics)
    print(json.dumps({'retrieved':trace['id'],'baselineChars':metrics['baselineJsonChars'],
                      'projectedChars':metrics['projected']['jsonChars']}),flush=True)
final_indexes=[idx for rel,idx in indexes.items() if 'turn-0120' in rel]
summary={'calls':len(measurements),'meanBaselineJsonChars':statistics.mean(m['baselineJsonChars'] for m in measurements),
    'meanDeliveryOnlyJsonChars':statistics.mean(m['deliveryOnly']['jsonChars'] for m in measurements),
    'meanProjectedJsonChars':statistics.mean(m['projected']['jsonChars'] for m in measurements),
    'maxProjectedJsonChars':max(m['projected']['jsonChars'] for m in measurements),
    'nonemptyBaseline':sum(m['baselineJsonChars']>2 for m in measurements),
    'nonemptyProjected':sum(m['projected']['units']>0 for m in measurements),
    'observationCalls':sum(bool(m['observationIds']) for m in measurements),
    'observationUnits':sum(len(m['observationIds']) for m in measurements),
    'finalSearchViews':sum(len(idx['units']) for idx in final_indexes),
    'maxSearchTokens':max(u['searchTokens'] for idx in indexes.values() for u in idx['units']),
    'changedNonMemoryFields':0,'retainCalls':0,'consolidateCalls':0,
    'callsMetrics':measurements}
summary['payloadReduction']=1-summary['meanProjectedJsonChars']/summary['meanBaselineJsonChars']
changed=[path for path,h in protocol['frozenInputs'].items() if digest(Path(path))!=h]
assert not changed,changed
write(out/'retrieval-summary.json',summary)
write(out/'integrity.json',{'frozenFiles':len(protocol['frozenInputs']),'changedFiles':changed})
print(json.dumps({k:v for k,v in summary.items() if k!='callsMetrics'}),flush=True)
