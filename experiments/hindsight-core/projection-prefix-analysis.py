"""Audit frozen-input projection replay and completed paired model decisions."""
import argparse
import copy
import hashlib
import json
from collections import Counter
from pathlib import Path
import core
import projections as projection

p=argparse.ArgumentParser();p.add_argument('output',type=Path);a=p.parse_args()
out=a.output.resolve()
read=lambda path:json.loads(path.read_text(encoding='utf-8'))
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
protocol=read(out/'protocol.json');bank=Path(protocol['bank'])
comparisons=[read(path) for path in sorted((out/'retrieval').glob('*.json'))]
audit={'calls':len(comparisons),'sourceRefsChecked':0,'recentEvidenceDelivered':0,
       'repeatedEvidenceDelivered':0,'baselineRepeatedEvidenceSegments':0,
       'baselineRecentEvidenceSegments':0,'baselineDistinctEvidenceSegments':0,
       'projectedDistinctEvidenceSegments':0,'changedNonMemoryFields':[],'baselineModelCallMismatches':[],
       'changedFrozenFiles':[]}
counts={mode:Counter() for mode in ('old','new')}
decision_differences=[];action_differences=[];response_differences=[]
same_input=[];same_input_decision_differences=[];invalid=[];responses=0
observation_samples=[]
for comparison in comparisons:
    ident=comparison['traceId']
    data=read((bank/comparison['snapshot']).with_name('prepared.json'))
    by_id,sources=projection.archive(data)
    recent={int(o['sourceSeq']) for o in comparison['requests']['native']['context'].get('observations',[])+
            comparison['requests']['native']['context'].get('selfObservations',[])}
    baseline_keys=[]
    for unit in comparison['baselineRecall']['results']:
        atoms=[unit] if unit['memoryLevel']=='event_atom' else unit['eventAtoms']
        baseline_keys.extend(projection.evidence_key(atom,sources) for atom in atoms)
    audit['baselineRepeatedEvidenceSegments']+=len(baseline_keys)-len(set(baseline_keys))
    audit['baselineDistinctEvidenceSegments']+=len(set(baseline_keys))
    audit['baselineRecentEvidenceSegments']+=sum(sources[key[0]]['worldSeq'] in recent for key in baseline_keys)
    delivered_keys=[]
    for memory,row in zip(comparison['projected']['memories'],comparison['projected']['trace']['delivered'],strict=True):
        assert memory['memoryId']==row['memoryId']
        assert memory['sourceIds']==[r['sourceId'] for r in row['sourceRefs']]
        for ref in row['sourceRefs']:
            assert ref==core.source_ref(sources[ref['sourceId']])
            assert sources[ref['sourceId']]['knownTick']<=comparison['tick']
            audit['sourceRefsChecked']+=1
        if memory['memoryLevel']=='observation':
            assert memory['text']==by_id[memory['memoryId']]['text']
            assert memory['epistemicKind']=='subjective_inference'
            continue
        ids=row['coveredAtomIds'];assert ids
        keys={projection.evidence_key(by_id[i],sources) for i in ids}
        assert len(keys)==1
        key=next(iter(keys));delivered_keys.append(key)
        assert memory['text'].endswith(key[3])  # Complete original segment; no rewritten search excerpt.
        assert memory['sourceAgeTicks']==comparison['tick']-sources[key[0]]['knownTick']
        audit['recentEvidenceDelivered']+=sources[key[0]]['worldSeq'] in recent
    audit['repeatedEvidenceDelivered']+=len(delivered_keys)-len(set(delivered_keys))
    audit['projectedDistinctEvidenceSegments']+=len(set(delivered_keys))
    old_request,new_request=(copy.deepcopy(comparison['requests'][mode]) for mode in ('old','new'))
    old_request['context'].pop('memories');new_request['context'].pop('memories')
    if 'recallEvidence' in old_request:
        old_request['recallEvidence'].pop('memories');new_request['recallEvidence'].pop('memories')
    if old_request!=new_request:audit['changedNonMemoryFields'].append(ident)
    if comparison['originalResponse'] is None:continue
    records={mode:read(out/'behavior'/(ident+'-'+mode+'.json')) for mode in ('old','new')}
    for mode,record in records.items():
        assert record['response'] is not None and 'error' not in record
        responses+=1;counts[mode][record['response']['decision']]+=1
        if not record['validation']['wireSchemaValid'] or not record['validation']['structureValid']:
            invalid.append({'traceId':ident,'mode':mode})
    prior=read(bank/'behavior'/(ident+'-new.json'))
    if records['old']['modelCall']!=prior['modelCall']:audit['baselineModelCallMismatches'].append(ident)
    old,new=records['old']['response'],records['new']['response']
    if old!=new:response_differences.append(ident)
    if old['decision']!=new['decision']:decision_differences.append({'traceId':ident,'old':old,'new':new})
    if (old.get('actionType'),old.get('parameters'))!=(new.get('actionType'),new.get('parameters')):
        action_differences.append({'traceId':ident,'old':old,'new':new,'observationIds':comparison['metrics']['observationIds']})
    if records['old']['inputHash']==records['new']['inputHash']:
        same_input.append(ident)
        if old['decision']!=new['decision']:same_input_decision_differences.append(ident)
    if comparison['metrics']['observationIds'] and old!=new:
        observation_samples.append({'traceId':ident,'observationIds':comparison['metrics']['observationIds'],'old':old,'new':new})
audit['changedFrozenFiles']=[path for path,h in protocol['frozenInputs'].items() if digest(Path(path))!=h]
assert not audit['recentEvidenceDelivered'] and not audit['repeatedEvidenceDelivered']
assert not audit['changedNonMemoryFields'] and not audit['changedFrozenFiles'] and not audit['baselineModelCallMismatches']
summary={'retrieval':{k:v for k,v in read(out/'retrieval-summary.json').items() if k!='callsMetrics'},
    'audit':audit,'behavior':{'freshCalls':responses,'returnedDecisionPoints':responses//2,
        'decisions':{mode:dict(c) for mode,c in counts.items()},'invalidOutputs':invalid,
        'decisionDifferences':decision_differences,'actionDifferences':action_differences,
        'responseDifferenceCount':len(response_differences),'identicalInputPairs':len(same_input),
        'identicalInputDecisionDifferences':same_input_decision_differences,
        'observationResponseDifferenceSamples':observation_samples}}
(out/'analysis-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'audit':audit,'behavior':{k:v for k,v in summary['behavior'].items()
    if k not in ('observationResponseDifferenceSamples','decisionDifferences','actionDifferences')}},ensure_ascii=False))
print(json.dumps({'decisionDifferences':decision_differences,'actionDifferences':action_differences},ensure_ascii=False))
