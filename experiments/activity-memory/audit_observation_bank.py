"""Read-only bank audit and predeclared exploratory metrics; no live classifiers."""
import copy
import json
import sqlite3
import sys
from pathlib import Path
import observation_bank as bank

def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def audit(root):
    protocol = load(root/'protocol.json');fixture = load(root/'bank-fixture.json')
    prepared = load(root/'facet-projection.json');built = load(root/'bank-build.json')
    original = load(root/'build.json');projection = load(root/'applicability.json')
    authorized = load(root/'authorized-at-probe.json')
    assert built['archive'] == prepared['archive'] and built['index'] == prepared['index']
    assert built['archive']['sources'] == authorized['sources']
    target_id = fixture['targetId']
    target = next(o for o in built['archive']['observations'] if o['id'] == target_id)
    assert target == next(o for o in original['archive']['observations'] if o['id'] == target_id)
    assert len(built['archive']['observations']) == 20
    records = {r['memoryId']:r for r in fixture['entries']}
    observations = {o['id']:o for o in built['archive']['observations']}
    distinct_sources = []
    for ident,row in records.items():
        if ident == target_id:continue
        memory = observations[ident]
        assert memory['text'] == row['text'] and len(memory['sourceRefs']) == 1
        source = next(s for s in authorized['sources'] if s['sourceId'] == memory['sourceRefs'][0]['sourceId'])
        assert source['text'] == row['evidence'] and source['knownTick'] == row['tick']
        distinct_sources.append(source['sourceId'])
    assert len(set(distinct_sources)) == 19
    assert projection == load(Path(protocol['reusedArchiveFrom'])/'applicability.json')
    for generated in prepared['generationInputs']:
        assert set(generated) == {'items','allowedPeople'}
        assert all(set(item) == {'memoryId','observationText'} for item in generated['items'])
    calls = [json.loads(s) for s in (root/'jev-applicability-calls.jsonl').read_text(encoding='utf-8').splitlines()]
    assert all(c['status'] == 'returned' for c in calls)
    for call in calls:
        state = call['request']['state']
        assert set(state) == {'stimulus','candidates'}
        assert set(state['stimulus']) == {'text','actorIds','mentionedIds'}
        assert all(set(c) == {'understanding','applicability'} for c in state['candidates'].values())
        assert not any('Authorization' in k for k in call)
        assert chr(0x96ea) + chr(0x9752) not in json.dumps(state,ensure_ascii=False)
    all_rows = []; selections = {}; expected_jev_calls = []
    for probe in protocol['probes']:
        selected = load(root/(probe['id']+'-recall.json'))
        baseline = load(root/(probe['id']+'-baseline-recall.json'))
        assert selected['query'] == baseline['query']
        assert selected['retrieval']['rawScores'] == baseline['retrieval']['rawScores']
        assert selected['retrieval']['thresholds'] == baseline['retrieval']['thresholds']
        evaluated = selected['retrieval']['bankEvaluation']
        assert evaluated['contentHash'] == prepared['contentHash']
        assert len(evaluated['triggerScores']) == 20
        assert len(evaluated['rows']) == 18
        for row in evaluated['rows']:
            assert row['bankIds'] == [entry['memoryId'] for entry in fixture['entries'][:row['size']]]
            labels = {ident:records[ident]['expected'].get(probe['id'],'irrelevant') for ident in row['bankIds']}
            required = {i for i,k in labels.items() if k == 'required'}
            irrelevant = {i for i,k in labels.items() if k == 'irrelevant'}
            allowed = {i for i,k in labels.items() if k == 'allowed'}
            sent,related = set(row['sentIds']),set(row['relatedIds'])
            assert len(sent) == len(row['sentIds']) and related <= sent <= set(row['bankIds'])
            if row['route']=='trigger':
                assert set(row['sentIds']) == set(row['shortlistIds'])
                assert len(sent) <= 7
                assert all(next(s for s in evaluated['triggerScores'] if s['memoryId']==i)['subjectMatched'] for i in sent)
            else:assert sent == set(row['bankIds'])
            if sent:expected_jev_calls.append((evaluated['stimulus'],row))
            assert set(row['decision']['answers']) == sent
            assert related == {i for i,a in row['decision']['answers'].items() if a['related']}
            for result in row['decision']['answers'].values():bank.jev.validate_decision(result)
            assert len(row['delivery']) <= 3
            assert set(row['deliveryTrace']['delivered'][i]['memoryId'] for i in range(len(row['deliveryTrace']['delivered']))) == {m['memoryId'] for m in row['delivery']}
            delivered = {m['memoryId'] for m in row['delivery']}
            for item in row['delivery']:
                assert set(item) == {'memoryId','memoryLevel','text','epistemicKind','sourceIds','sourceAgeTicks'}
                if item['memoryLevel'] == 'observation':
                    ident = item['memoryId'];memory=observations[ident]
                    assert ident in related and item['text'] == memory['text'] and item['epistemicKind']=='subjective_inference'
                    assert item['sourceIds'] == [s['sourceId'] for s in memory['sourceRefs']]
                for sid in item['sourceIds']:
                    assert sid in {s['sourceId'] for s in authorized['sources']}
            all_rows.append({'probe':probe['id'],'size':row['size'],'repeat':row['repeat'],'route':row['route'],
                'bankIds':row['bankIds'],'sentIds':row['sentIds'],'choices':{i:a['choice'] for i,a in row['decision']['answers'].items()},
                'relatedIds':row['relatedIds'],'deliveredIds':[m['memoryId'] for m in row['delivery']],
                'targetExpected':labels[target_id], 'targetShortlisted':target_id in sent,
                'targetRelated':target_id in related,'targetDelivered':target_id in delivered,
                'requiredCount':len(required),'requiredShortlistMisses':sorted(required-sent),
                'requiredJudgeMisses':sorted((required&sent)-related),
                'requiredDeliveryMisses':sorted((required&related)-delivered),
                'requiredAdmissionMisses':sorted(required-related),
                'requiredEndToEndDeliveryMisses':sorted(required-delivered),
                'irrelevantCount':len(irrelevant),'falseRelated':sorted(related&irrelevant),
                'falseDelivered':sorted(delivered&irrelevant),'allowedRelated':sorted(related&allowed),
                'expectedEmpty':not(required|allowed),'actualEmpty':not related,
                'usage':row['decision']['usage'],'latencyMs':row['decision']['latencyMs'],
                'triggerLatencyMs':row['triggerLatencyMs']})
        chosen = next(row for row in evaluated['rows'] if row['size']==20 and row['repeat']==0 and row['route']=='trigger')
        assert selected['delivery'] == chosen['delivery']
        selections[probe['id']] = selected
    assert len(calls) == len(expected_jev_calls)
    for call,(stimulus,row) in zip(calls,expected_jev_calls):
        assert call['request']['state']['stimulus'] == stimulus
        assert list(call['request']['state']['candidates']) == row['sentIds']
        assert call['result'] == row['decision']
        for ident,candidate in call['request']['state']['candidates'].items():
            assert candidate['understanding'] == observations[ident]['text']
            assert candidate['applicability'] == next(e for e in prepared['entries'] if e['memoryId']==ident)['facets']
    groups = []
    for size in fixture['sizes']:
        for route in ('all','trigger'):
            group = [r for r in all_rows if r['size']==size and r['route']==route]
            def total(key):return sum(len(r[key]) for r in group)
            groups.append({'size':size,'route':route,'queriesTimesRepeats':len(group),'modelCalls':sum(bool(r['sentIds']) for r in group),
                'sentCandidates':sum(len(r['sentIds']) for r in group),'requiredCount':sum(r['requiredCount'] for r in group),
                'shortlistRequiredMisses':total('requiredShortlistMisses'),'judgeRequiredMisses':total('requiredJudgeMisses'),
                'admissionRequiredMisses':total('requiredAdmissionMisses'),'deliveryRequiredMisses':total('requiredDeliveryMisses'),
                'endToEndRequiredDeliveryMisses':total('requiredEndToEndDeliveryMisses'),
                'targetRequiredCount':sum(r['targetExpected']=='required' for r in group),
                'targetAdmissionMisses':sum(r['targetExpected']=='required' and not r['targetRelated'] for r in group),
                'targetDeliveryMisses':sum(r['targetExpected']=='required' and not r['targetDelivered'] for r in group),
                'targetFalseAdmissions':sum(r['targetExpected']=='irrelevant' and r['targetRelated'] for r in group),
                'deliveredCount':sum(len(r['deliveredIds']) for r in group),
                'irrelevantCount':sum(r['irrelevantCount'] for r in group),'falseRelated':total('falseRelated'),
                'falseDelivered':total('falseDelivered'),'allowedRelated':total('allowedRelated'),
                'costUsd':sum(r['usage'].get('cost',0) for r in group),
                'inputTokens':sum(r['usage'].get('input_tokens',0) for r in group),
                'outputTokens':sum(r['usage'].get('output_tokens',0) for r in group),
                'latencyMsMedian':__import__('statistics').median(r['latencyMs'] for r in group),
                'judgePlusTriggerMsMedian':__import__('statistics').median(r['latencyMs']+r['triggerLatencyMs'] for r in group),
                'expectedEmptyCount':sum(r['expectedEmpty'] for r in group),
                'emptyCasesFalseRelated':sum(r['expectedEmpty'] and not r['actualEmpty'] for r in group)})
    repetition_flips = [];scale_flips = [];route_disagreements = []
    for probe in protocol['probes']:
        for route in ('all','trigger'):
            for size in fixture['sizes']:
                group=[r for r in all_rows if r['probe']==probe['id'] and r['route']==route and r['size']==size]
                for ident in set.intersection(*(set(r['choices']) for r in group)):
                    choices=[r['choices'][ident] for r in group]
                    if len(set(choices))>1:repetition_flips.append({'probe':probe['id'],'route':route,'size':size,'memoryId':ident,'choices':choices})
            for ident in fixture['entries'][:5]:
                ident=ident['memoryId']
                group=[r for r in all_rows if r['probe']==probe['id'] and r['route']==route and ident in r['choices']]
                if len({r['choices'][ident] for r in group})>1:
                    scale_flips.append({'probe':probe['id'],'route':route,'memoryId':ident,'draws':[{'size':r['size'],'repeat':r['repeat'],'choice':r['choices'][ident]} for r in group]})
        for size in fixture['sizes']:
            for repeat in range(3):
                a=next(r for r in all_rows if r['probe']==probe['id'] and r['size']==size and r['repeat']==repeat and r['route']=='all')
                b=next(r for r in all_rows if r['probe']==probe['id'] and r['size']==size and r['repeat']==repeat and r['route']=='trigger')
                for ident in set(a['choices'])&set(b['choices']):
                    if a['choices'][ident] != b['choices'][ident]:
                        route_disagreements.append({'probe':probe['id'],'size':size,'repeat':repeat,'memoryId':ident,'all':a['choices'][ident],'trigger':b['choices'][ident]})
    summary=load(root/'summary.json')
    canonical={};trials=[]
    for file in sorted(root.glob('*/call-1.json')):
        call=load(file);row=load(file.parent/'result.json')
        assert call['status']=='returned' and row['originalWorldUnchanged']
        request=copy.deepcopy(call['request']);memories=request['context'].pop('memories')
        if call['probe'] in canonical:assert request==canonical[call['probe']]
        else:canonical[call['probe']]=request
        expected=selections[call['probe']]['delivery']
        if call['mode']!='with-observation':expected=[m for m in expected if m['memoryId']!=target_id]
        assert memories==expected and request['context']['observations']==[] and request['context']['selfObservations']==[] and not request['canRecall']
        assert all(set(m)=={'memoryId','memoryLevel','text','epistemicKind','sourceIds','sourceAgeTicks'} for m in memories)
        moved=any(e['eventType']=='character.moved' for e in row['events'])
        if moved:assert row['result']['performResult']['status']=='accepted'
        trials.append({'probe':call['probe'],'mode':call['mode'],'repetition':call['repetition'],'response':call['response'],
                       'status':row['result']['status'],'moved':moved,'deliveredIds':[m['memoryId'] for m in memories]})
    assert len(trials)==summary['trials']==len(summary['eligible'])*9
    base={**load(root/'facet-input.json'),'archive':built['archive'],'index':built['index'],'prepared':prepared,
          'operation':'recall','request':load(root/'new-task-preview-request.json'),'tick':55,'observations':True}
    def never_call(*args):raise AssertionError('audit attempted live model call')
    bank.jev.assess_many=never_call;negative=[]
    for name,mutate in [
        ('wrong-character',lambda d:d['request']['context']['character'].update(characterId='character:bob')),
        ('tampered-bank-source',lambda d:d['prepared']['archive']['sources'][0].update(sourceHash='tampered')),
        ('tampered-projection',lambda d:d['prepared']['entries'][0]['fieldVectors']['contexts'].__setitem__(0,42)),
        ('wrong-original-projection',lambda d:d['projection'].update(archiveHash='other'))]:
        bad=copy.deepcopy(base);mutate(bad)
        try:bank.recall(bad)
        except ValueError:negative.append(name)
        else:raise AssertionError('accepted '+name)
    # Replay the full first-query matrix strictly from recorded decisions.
    original_rows=selections['new-task']['retrieval']['bankEvaluation']['rows']
    cursor=iter(original_rows)
    def cached(stimulus,candidates):
        row=next(cursor);assert [c['memoryId'] for c in candidates]==row['sentIds']
        return copy.deepcopy(row['decision'])
    bank.jev.assess_many=cached
    replay=bank.recall(base)
    assert replay['delivery']==selections['new-task']['delivery']
    for database in ('world.sqlite','memory.sqlite'):
        with sqlite3.connect('file:'+(root/'history'/database).resolve().as_posix()+'?mode=ro',uri=True) as db:
            assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
    return {'syntheticBank':True,'subsetScoringCorpusSize':20,'subsetIDFAndRanksFrozen':True,'targetAndEvidenceUnchanged':True,'sourceArchiveExactlyAuthorized':True,
            'syntheticSourcesDistinct':19,'bankCount':20,'modelsNeverReceiveLabelsOrRetrievalScores':True,
            'onlyOriginalRelatedObservationsDelivered':True,'sameNonmemoryContextWithinProbe':True,
            'ablationRemovesOnlyTarget':True,'privateSourceExcluded':True,'originalWorldUnchanged':summary['originalWorldUnchanged'],
            'readOnlyCachedReplayPassed':True,'negativeChecksRejected':negative,'modelCalls':len(calls),
            'groups':groups,'rows':all_rows,'repetitionChoiceFlips':repetition_flips,'scaleChoiceFlipsForFirstFive':scale_flips,
            'routeChoiceDisagreements':route_disagreements,'trials':trials,'fixture':fixture,
            'bankMapping':[{'memoryId':o['id'],'text':o['text'],'sourceRefs':o['sourceRefs']} for o in observations.values()],
            'labelLimit':'predeclared nonblind exploratory required/allowed/irrelevant labels, not gold; no confidence intervals',
            'artifacts':str(root.resolve())}

if __name__=='__main__':
    root=Path(sys.argv[1]);result=audit(root)
    (root/'bank-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k not in ('rows','trials','fixture','bankMapping')},ensure_ascii=True))
