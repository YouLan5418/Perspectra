"""Offline audit/replay: no model calls and no writes to frozen bank data."""
import copy
import json
import sys
from pathlib import Path
from unittest.mock import Mock
import cognition_lineage as lineage

def candidates(units):
    return [{'id':u['id'],'rank':i+1,'relevance':1/(61+i),'score':.9,
             'matches':[{'atomIds':u['sourceFactIds'],'sourceRefs':u['sourceRefs']}]} for i,u in enumerate(units)]

def delivery_probe(archive, record):
    doc=copy.deepcopy(archive)
    doc['observations'].extend(record['current'])
    request={'context':{'character':{'characterId':doc['scope']['characterId']},
                        'observations':[],'selfObservations':[]}}
    output={}
    for limit in (3,12):
        delivered=lineage.bridge.projections.delivery_projection(doc,candidates(record['current']),request,55,max_items=limit)
        output[str(limit)]={'deliveredUnderstandingIds':[m['memoryId'] for m in delivered['memories']
                           if m['memoryLevel']=='observation'],
                           'itemCount':len(delivered['memories']),'trace':delivered['trace']}
    return output

def audit(root):
    root=Path(root)
    protocol=json.loads((root/'protocol.json').read_text(encoding='utf-8'))
    results=json.loads((root/'controlled-results.json').read_text(encoding='utf-8'))
    calls=[json.loads(line) for line in (root/'utility-calls.jsonl').read_text(encoding='utf-8').splitlines()]
    assert len(results)==12 and len(calls)>=12
    rows=[]
    for result,call in zip(results,calls[:12]):
        record=result['record']
        archive=json.loads((root/('case-'+result['case']+'-archive.json')).read_text(encoding='utf-8'))
        lineage.bridge.episode.validate_units(archive)
        old=record['versions'][0]
        new_ids=[a['id'] for a in record['generationInput']['newEvidence']]
        assert json.loads(call['responseText'].strip().removeprefix('```json').removesuffix('```').strip())==record['rawAnswer']
        assert call['status']=='returned'
        assert set(record['generationInput'])=={'owner','oldUnderstanding','oldEvidence','newEvidence','independentSourceCounts'}
        before=copy.deepcopy(archive)
        replay=lineage.update(archive,old,new_ids,record['familyId'],20,20,55,Mock(return_value=record['rawAnswer']))
        for key in ('relation','current','versions','firstFormedTick','lastRevisedTick','revisionSourceIds'):
            assert replay[key]==record[key]
        assert archive==before
        assert replay['current']==lineage.select(replay)
        assert lineage.select(replay,'historical')[0]==old
        assert old not in lineage.select(replay)
        all_evidence=set(old['sourceFactIds'])|set(new_ids)
        assert set(i for u in replay['current'] for i in u['sourceFactIds'])==all_evidence
        assert result['relationMatches']
        if result['case']=='C':
            assert len(replay['current'])==1
            assert set(replay['current'][0]['supportingAtomIds'])==set(old['supportingAtomIds'])
            assert set(replay['current'][0]['contradictingAtomIds'])==set(new_ids)
        if result['case']=='D':
            assert len(replay['current'])==2
            assert {frozenset(u['supportingAtomIds']) for u in replay['current']}=={
                frozenset(old['supportingAtomIds']),frozenset(new_ids)}
            for u in replay['current']:
                assert set(u['contradictingAtomIds'])==all_evidence-set(u['supportingAtomIds'])
        check=delivery_probe(archive,replay)
        rows.append({'case':result['case'],'repeat':result['repeat'],'relation':replay['relation'],
                     'firstFormedTick':replay['firstFormedTick'],'lastRevisedTick':replay['lastRevisedTick'],
                     'evidenceUpdatedTick':replay['evidenceUpdatedTick'],
                     'versionMetadata':replay['versionMetadata'],'currentCount':len(replay['current']),
                     'currentTexts':[u['text'] for u in replay['current']],
                     'supportCounts':result['independentSupportingSources'],
                     'counterCounts':result['independentCounterSources'],
                     'evidenceUnchanged':True,'existingDeliveryProbe':check})
    # One real historical query can find a version yet lose it at Delivery. Do not count admission as reading.
    summary={'controlledRows':rows,'calls':{'gemini':len(calls),'jev':0},
             'allTwelveRelationMatches':all(r['relationMatches'] for r in results),
             'allEvidenceUnchanged':True,'noNewEvidenceSkipsModel':True,
             'semanticReview':{
                 'method':'nonblind investigator reading, not independent gold or deterministic entailment proof',
                 'A':'three exact bodies, supports expanded 3 to6 distinct sources',
                 'B':'condition split retained; some bodies use unqualified reliable wording, not calibrated general truth',
                 'C':'all three retain usually reliable plus exception; six supports and one counter',
                 'D':'both opposed branches and mirrored counterevidence retained; positive branch can sound overly definite, notably repeats0/1; family conflict must not be hidden',
             }}
    no_new=Mock(side_effect=AssertionError('no evidence must not call'))
    case=protocol['fixture']['cases'][0]
    doc,old,_=lineage.fixture_archive(case)
    lineage.update(doc,old,old['sourceFactIds'],'family:A',20,20,55,no_new)
    no_new.assert_not_called()
    if (root/'bank-summary.json').exists():
        bank_summary=json.loads((root/'bank-summary.json').read_text(encoding='utf-8'))
        assert bank_summary['evidenceUnchanged'] and bank_summary['frozenFilesUnchanged']
        bank_root=Path(json.loads((root/'bank-input.json').read_text(encoding='utf-8'))['bankRoot'])
        original=json.loads((bank_root/'facet-projection.json').read_text(encoding='utf-8'))
        active=json.loads((root/'bank-current-projection.json').read_text(encoding='utf-8'))
        for key in ('sources','facts','episodes'):
            assert original['archive'][key]==active['archive'][key]
        assert active['archive']['observations'][:20]==original['archive']['observations']
        assert len(active['entries'])==19
        assert 'bank:10' in {e['memoryId'] for e in active['entries']}
        assert not {'obs:1','bank:04'} & {e['memoryId'] for e in active['entries']}
        jev_calls=[json.loads(l) for l in (root/'jev-calls.jsonl').read_text(encoding='utf-8').splitlines()]
        matrix=json.loads((root/'bank-comparison.json').read_text(encoding='utf-8'))
        expected=[r[label]['decision'] for r in matrix for label in ('flat','current')]
        history=json.loads((root/'historical-query.json').read_text(encoding='utf-8'))
        expected.append(history['decision'])
        assert [c['result'] for c in jev_calls]==expected
        for call in jev_calls:
            assert call['status']=='returned'
            assert set(call['request']['state'])=={'stimulus','candidates'}
            for candidate in call['request']['state']['candidates'].values():
                assert set(candidate)=={'understanding','applicability'}
        summary['bank']=bank_summary;summary['calls']['jev']=len(jev_calls)
        summary['jevCostUsd']=sum(c['result']['usage'].get('cost',0) for c in jev_calls)
        summary['historicalRead']=history['oldVersionRead']
    lineage.save(root/'audit.json',summary)
    lineage.save(Path(__file__).with_name('observation-lineage-assessment.json'),{
        'artifactRoot':str(root),'controlledRows':[{k:v for k,v in r.items() if k!='existingDeliveryProbe'} for r in rows],
        'controlledDeliveryCounts':[{k:r[k] for k in ('case','repeat','currentCount')}| {
             'budget3Count':len(r['existingDeliveryProbe']['3']['deliveredUnderstandingIds']),
             'budget12Count':len(r['existingDeliveryProbe']['12']['deliveredUnderstandingIds'])} for r in rows],
        **{k:v for k,v in summary.items() if k!='controlledRows'}})
    print(json.dumps({'relations':summary['allTwelveRelationMatches'],'evidenceUnchanged':True,
                     'calls':summary['calls'],'conflictBudget3':[len(r['existingDeliveryProbe']['3']['deliveredUnderstandingIds'])
                     for r in rows if r['case']=='D']}))

if __name__=='__main__':
    audit(sys.argv[1])
