"""Offline replay and exploratory labels for lineage retrieval experiments."""
import copy
import json
import statistics
import sys
from pathlib import Path
from unittest.mock import Mock, patch
import lineage_retrieval as exp

def audit(root):
    root=Path(root);protocol=exp.load(root/'protocol.json')
    original=exp.load(Path(protocol['bankRoot'])/'facet-projection.json')
    active=exp.load(Path(protocol['lineageRoot'])/'bank-current-projection.json')
    family=exp.load(Path(protocol['lineageRoot'])/'bank-family.json')
    revision=exp.load(Path(protocol['lineageRoot'])/'bank-update.json')
    saved=exp.load(root/'prepared.json');generation=exp.load(root/'projection-generation.json')
    calls=[json.loads(l) for l in (root/'utility-calls.jsonl').read_text(encoding='utf-8').splitlines()]
    assert len(calls)==len(generation)==5
    for call,g in zip(calls,generation):
        assert call['status']=='returned'
        assert json.loads(call['responseText'].strip().removeprefix(chr(96)*3+'json').removesuffix(chr(96)*3).strip())==g['answer']
        assert 'stimulus' not in g['input'] and 'expected' not in g['input']
    mocked=Mock(side_effect=[g['answer'] for g in generation])
    with patch.object(exp.bank.bridge,'utility_llm',mocked):
        replay,replay_generation=exp.prepare(copy.deepcopy(active),copy.deepcopy(original),family,revision)
    assert replay==saved and replay_generation==generation
    observations={o['id']:o for o in active['archive']['observations']}
    for stage,data in saved.items():
        assert data['archive']==active['archive'] and data['index']==active['index']
        assert len(data['entries'])==19
        for e in data['entries']:
            assert e['sourceRefs']==observations[e['memoryId']]['sourceRefs']
            assert e['bodyText']==exp.bank.retrieval_text.clean(observations[e['memoryId']]['text'],active['index']['retrievalAliases'])
    rows=exp.load(root/'results.json');history=exp.load(root/'historical-results.json')
    ranks=exp.load(root/'rankings.json')
    assert len(rows)==60 and len(history)==3
    by_rank={(r['probe'],r['stage']):r for r in ranks}
    target=revision['current'][0]['id'];old=revision['revisedFrom'][0]
    for ranking in ranks:
        stage=ranking['stage']
        if stage in exp.STAGES[:2]:
            raw,_=exp.bank.trigger(saved[stage],ranking['query'])
            computed=[{**r,'groupId':r['memoryId'],'readingIds':[r['memoryId']]} for r in raw]
        else:
            computed=exp.rank(saved[stage],ranking['query'],family,stage=='D-families',True)
        assert computed==ranking['rows']
        assert exp.shortlist(computed)==(ranking['sentIds'],ranking['selectedGroups'],ranking['budgetRejected'])
    jev_calls=[json.loads(l) for l in (root/'jev-calls.jsonl').read_text(encoding='utf-8').splitlines()]
    assert len(jev_calls)==63
    metrics=[]
    expected={e['memoryId']:e['expected'] for e in original['fixture']['entries']}
    frozen_observations={o['id']:o for o in active['archive']['observations']}
    for row,call in zip(rows+history,jev_calls):
        if 'stage' in row:
            prepared=saved[row['stage']]
            ranking=by_rank[(row['probe'],row['stage'])]
            request=exp.load(Path(protocol['bankRoot'])/(row['probe']+'-preview-request.json'))
            baseline=exp.load(Path(protocol['bankRoot'])/(row['probe']+'-baseline-recall.json'))
            query=ranking['query'];scored=ranking['rows']
            assert row['sentIds']==ranking['sentIds']
            assert old not in row['sentIds'] and 'bank:04' not in row['sentIds']
        else:
            prepared=copy.deepcopy(saved['D-families'])
            prepared['entries'].append(next(e for e in original['entries'] if e['memoryId']==old))
            prepared['contentHash']=exp.lineage.digest({k:v for k,v in prepared.items() if k!='contentHash'})
            query=row['query'];scored=row['rows']
            request=exp.load(Path(protocol['bankRoot'])/'new-task-preview-request.json')
            request['context']['stimulus'][0]['content']['speech']['text']=query['originalText']
            baseline=exp.load(Path(protocol['bankRoot'])/'new-task-baseline-recall.json')
            assert row['sentIds']==exp.shortlist(scored)[0]
            check=exp.bank.bridge.queries.project(request,active['index']['retrievalAliases'])
            assert all(query[k]==check[k] for k in check)
        assert len(row['sentIds'])<=7
        for ident in row['sentIds']:assert ident in frozen_observations
        entries={e['memoryId']:e for e in prepared['entries']}
        native=exp.bank.jev.many_request(row['stimulus'],[{
            'memoryId':i,'understanding':frozen_observations[i]['text'],'applicability':entries[i]['facets']} for i in row['sentIds']])
        assert native==call['request'] and row['decision']==call['result'] and call['status']=='returned'
        with patch.object(exp.bank.jev,'assess_many',return_value=row['decision']):
            replay=exp.evaluate(prepared,query,request,baseline,scored,row['sentIds'])
        assert all(replay[k]==row[k] for k in replay)
        assert len(row['delivery']['memories'])<=3
        for memory in row['delivery']['memories']:
            if memory['memoryLevel']=='observation':
                assert memory['text']==frozen_observations[memory['memoryId']]['text']
        if 'stage' in row:
            labels={e['memoryId']:expected[old if e['memoryId']==target else e['memoryId']].get(row['probe'],'irrelevant')
                    for e in prepared['entries']}
            required={i for i,l in labels.items() if l=='required'}
            irrelevant={i for i,l in labels.items() if l=='irrelevant'}
            sent=set(row['sentIds']);related=set(row['relatedIds'])
            read={m['memoryId'] for m in row['delivery']['memories']}
            metrics.append({'probe':row['probe'],'stage':row['stage'],'repeat':row['repeat'],
                  'required':sorted(required),'requiredShortlistMisses':sorted(required-sent),
                  'requiredAdmissionMisses':sorted(required-related),'requiredReadMisses':sorted(required-read),
                  'irrelevantRelated':sorted(irrelevant&related),'irrelevantRead':sorted(irrelevant&read),
                  'targetSent':target in sent,'targetRelated':target in related,'targetRead':target in read,
                  'conflictBothRead':{target,'bank:10'}<=read,
                  'inputTokens':row['decision']['usage'].get('input_tokens',0),
                  'outputTokens':row['decision']['usage'].get('output_tokens',0),
                  'sentCount':len(sent),'costUsd':row['decision']['usage'].get('cost',0),
                  'latencyMs':row['decision']['latencyMs']})
    summaries=[]
    for stage in exp.STAGES:
        selected=[r for r in metrics if r['stage']==stage]
        positives=[r for r in selected if r['probe'] in ('new-task','new-stop','familiar-control')]
        negatives=[r for r in selected if r['probe'] in ('same-person-unrelated','other-person-navigation')]
        navigation=[r for r in selected if r['probe'] in ('new-task','new-stop')]
        summaries.append({'stage':stage,'calls':len(selected),'sent':sum(r['sentCount'] for r in selected),
            'targetPositiveSent':sum(r['targetSent'] for r in positives),'targetPositiveRelated':sum(r['targetRelated'] for r in positives),
            'targetPositiveRead':sum(r['targetRead'] for r in positives),
            'targetNegativeRelated':sum(r['targetRelated'] for r in negatives),'targetNegativeRead':sum(r['targetRead'] for r in negatives),
            'navigationBothBranchesRead':sum(r['conflictBothRead'] for r in navigation),
            'requiredCount':sum(len(r['required']) for r in selected),
            'requiredAdmissionMisses':sum(len(r['requiredAdmissionMisses']) for r in selected),
            'requiredReadMisses':sum(len(r['requiredReadMisses']) for r in selected),
            'irrelevantRelated':sum(len(r['irrelevantRelated']) for r in selected),
            'irrelevantRead':sum(len(r['irrelevantRead']) for r in selected),
            'inputTokens':sum(r['inputTokens'] for r in selected),
            'outputTokens':sum(r['outputTokens'] for r in selected),
            'costUsd':sum(r['costUsd'] for r in selected),
            'medianLatencyMs':statistics.median(r['latencyMs'] for r in selected)})
    decomposition=[]
    for probe in ('new-task','new-stop','familiar-control','same-person-unrelated','other-person-navigation'):
        query=by_rank[(probe,'B-continuity')]['query']
        binary=exp.rank(saved['B-continuity'],query,family,False,False)
        decomposition.append({'probe':probe,'comparison':'continuity fields + binary TF, without split scenarios or family grouping',
                              'rows':binary,'sentIds':exp.shortlist(binary)[0]})
    frozen={path:exp.hashes(path) for path in protocol['frozenInputs']}
    assert frozen==protocol['frozenInputs']
    identical={}
    for call in jev_calls:
        key=exp.lineage.digest(call['request'])
        identical.setdefault(key,[]).append(call['result'])
    flips=[]
    for key,values in identical.items():
        if len(values)<2:continue
        ids=set(values[0]['answers'])
        for ident in ids:
            choices=[v['answers'][ident]['choice'] for v in values]
            if len(set(choices))>1:flips.append({'requestHash':key,'memoryId':ident,'choices':choices})
    summary={'artifactRoot':str(root),'stages':summaries,'perDraw':metrics,
             'history':[{'repeat':r['repeat'],'oldSent':old in r['sentIds'],'oldRelated':old in r['relatedIds'],
                         'oldRead':old in {m['memoryId'] for m in r['delivery']['memories']},
                         'currentRead':target in {m['memoryId'] for m in r['delivery']['memories']},
                         'opposedBranchRead':'bank:10' in {m['memoryId'] for m in r['delivery']['memories']}} for r in history],
             'frozenInputsUnchanged':True,'allCanonicalBodiesAndEvidenceUnchanged':True,
             'calls':{'gemini':len(calls),'jev':len(jev_calls)},
             'jevInputTokens':sum(c['result']['usage'].get('input_tokens',0) for c in jev_calls),
             'jevOutputTokens':sum(c['result']['usage'].get('output_tokens',0) for c in jev_calls),
             'jevCostUsd':sum(c['result']['usage'].get('cost',0) for c in jev_calls),
             'identicalRequestChoiceFlips':flips,
             'limits':['five frozen probes, nonblind exploratory labels, no generalization',
                       'family identity controlled, not discovered','C changes scenarios and lexical TF; binary-only cheap diagnostic separately saved',
                       'existing strict counterevidence Delivery unchanged; bank branches have empty counterAtom lists',
                       'historical query mode explicit; no Character Turns or temporal-understanding test']}
    exp.lineage.save(root/'binary-only-diagnostic.json',decomposition)
    exp.lineage.save(root/'audit.json',summary)
    exp.lineage.save(Path(__file__).with_name('lineage-retrieval-assessment.json'),summary)
    print(json.dumps({'calls':summary['calls'],'frozen':True,'stages':summaries,'history':summary['history']}))

if __name__=='__main__':
    audit(sys.argv[1])
