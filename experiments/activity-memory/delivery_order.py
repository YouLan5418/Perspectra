"""Offline Delivery-order comparison: frozen admission, bodies and budgets."""
import copy
import json
import math
import sys
from pathlib import Path
from unittest.mock import patch
import lineage_retrieval as exp

MODES=('fusion','related_probability')

def order(candidates, decision):
    """Reorder judged RELATED slots only; unjudged evidence keeps its slots."""
    answers=decision['answers']
    judged=[]
    for candidate in candidates:
        ident=candidate['id']
        if ident not in answers:
            continue
        answer=answers[ident]
        if answer['choice']!='RELATED' or answer['related'] is not True:
            raise ValueError('sorting cannot admit a non-RELATED candidate')
        probability=answer['probabilities']['RELATED']
        if type(probability) not in (int,float) or not math.isfinite(probability) or not 0<=probability<=1:
            raise ValueError('invalid applicability sorting probability')
        judged.append(candidate)
    judged.sort(key=lambda c:(-answers[c['id']]['probabilities']['RELATED'],
                             -c['relevance'],-c['score'],c['id']))
    iterator=iter(judged)
    output=[copy.deepcopy(next(iterator) if c['id'] in answers else c) for c in candidates]
    for rank,candidate in enumerate(output,1):
        candidate['rank']=rank
    return output

def scope_check(prepared,request):
    scope=prepared['archive']['scope'];context=request['context']
    if context.get('character',{}).get('characterId')!=scope['characterId'] or context.get(
            'cognition',{}).get('address',scope['worldAddress'])!=scope['worldAddress']:
        raise ValueError('Delivery request crosses character or world')

def metrics(delivery,required,irrelevant,target):
    ids={m['memoryId'] for m in delivery['memories']}
    return {'readIds':[m['memoryId'] for m in delivery['memories']],
            'requiredRead':sorted(required & ids),'requiredReadMisses':sorted(required-ids),
            'irrelevantRead':sorted(irrelevant & ids),'targetRead':target in ids,
            'bothCurrentBranchesRead':{target,'bank:10'}<=ids,
            'jsonChars':delivery['trace']['jsonChars']}

def replay(prepared,request,baseline,query,scores,row,call):
    scope_check(prepared,request)
    observations={o['id']:o for o in prepared['archive']['observations']}
    entries={e['memoryId']:e for e in prepared['entries']}
    if set(row['decision']['answers'])!=set(row['sentIds']):
        raise ValueError('stored decisions do not cover frozen candidates')
    for answer in row['decision']['answers'].values():
        exp.bank.jev.validate_decision(answer)
    related=[i for i in row['sentIds'] if row['decision']['answers'][i]['related']]
    if related!=row['relatedIds']:
        raise ValueError('frozen admission changed')
    native=exp.bank.jev.many_request(row['stimulus'],[
        {'memoryId':i,'understanding':observations[i]['text'],'applicability':entries[i]['facets']}
        for i in row['sentIds']])
    if call['request']!=native or call['result']!=row['decision'] or call['status']!='returned':
        raise ValueError('stored JEV request/result changed')
    candidates,original=exp.bank.deliver(prepared,{**baseline,'query':copy.deepcopy(query)},request,
                                        55,related,scores,'lineage')
    if [c['id'] for c in candidates]!=row['rankedIds'] or original!=row['delivery']:
        raise ValueError('original Delivery could not be reproduced')
    ranked=order(candidates,row['decision'])
    modified=exp.bank.bridge.activity.deliver(prepared['archive'],ranked,request,55,copy.deepcopy(query),
                                              max_items=3,max_json_chars=4500)
    if {c['id'] for c in ranked}!={c['id'] for c in candidates}:
        raise ValueError('sort changed candidate set')
    for delivery in (original,modified):
        if len(delivery['memories'])>3 or delivery['trace']['jsonChars']>4500:
            raise ValueError('frozen budget changed')
        for memory in delivery['memories']:
            if memory['memoryLevel']=='observation' and memory['text']!=observations[memory['memoryId']]['text']:
                raise ValueError('original understanding body changed')
    return {'fusionRankedIds':[c['id'] for c in candidates],
            'probabilityRankedIds':[c['id'] for c in ranked],
            'sortingInputs':[{'memoryId':c['id'],'relatedProbability':row['decision']['answers'][c['id']]['probabilities']['RELATED']
                 if c['id'] in row['decision']['answers'] else None,
                 'rrfScore':c['relevance'],'semanticSimilarity':c['score']} for c in candidates],
            'delivery':{'fusion':original,'related_probability':modified}}

def summarize(rows):
    summaries=[]
    for stage in exp.STAGES:
        selected=[r for r in rows if r['stage']==stage]
        for mode in MODES:
            def m(r):return r['metrics'][mode]
            pos=[r for r in selected if r['probe'] in ('new-task','new-stop','familiar-control')]
            neg=[r for r in selected if r['probe'] in ('same-person-unrelated','other-person-navigation')]
            nav=[r for r in selected if r['probe'] in ('new-task','new-stop')]
            summaries.append({'stage':stage,'mode':mode,'draws':len(selected),
                'requiredCount':sum(len(r['required']) for r in selected),
                'requiredReadMisses':sum(len(m(r)['requiredReadMisses']) for r in selected),
                'irrelevantRead':sum(len(m(r)['irrelevantRead']) for r in selected),
                'targetPositiveRead':sum(m(r)['targetRead'] for r in pos),
                'targetNegativeRead':sum(m(r)['targetRead'] for r in neg),
                'navigationBothRead':sum(m(r)['bothCurrentBranchesRead'] for r in nav),
                'nonempty':sum(bool(m(r)['readIds']) for r in selected),
                'relatedNotRead':sum(len(set(r['relatedIds'])-set(m(r)['readIds'])) for r in selected)})
    return summaries

def run(output,input_root):
    output=Path(output);input_root=Path(input_root)
    if output.exists():
        raise ValueError('fresh output directory required')
    protocol=exp.load(input_root/'protocol.json')
    frozen_paths=[input_root,Path(protocol['bankRoot']),Path(protocol['lineageRoot'])]
    frozen={str(p.resolve()):exp.hashes(p) for p in frozen_paths}
    if any(frozen[str(Path(p).resolve())]!=v for p,v in protocol['frozenInputs'].items()):
        raise ValueError('upstream frozen evidence changed')
    prepared=exp.load(input_root/'prepared.json')
    for value in prepared.values():
        exp.check(value)
    original=exp.load(Path(protocol['bankRoot'])/'facet-projection.json')
    revision=exp.load(Path(protocol['lineageRoot'])/'bank-update.json')
    target=revision['current'][0]['id'];old=revision['revisedFrom'][0]
    expected={e['memoryId']:e['expected'] for e in original['fixture']['entries']}
    rankings={(r['probe'],r['stage']):r for r in exp.load(input_root/'rankings.json')}
    frozen_rows=exp.load(input_root/'results.json')
    frozen_history=exp.load(input_root/'historical-results.json')
    calls=[json.loads(l) for l in (input_root/'jev-calls.jsonl').read_text(encoding='utf-8').splitlines()]
    if len(frozen_rows)!=60 or len(frozen_history)!=3 or len(calls)!=63:
        raise ValueError('frozen experiment incomplete')
    output.mkdir(parents=True)
    exp.lineage.save(output/'protocol.json',{'inputRoot':str(input_root.resolve()),
        'modes':list(MODES),'deliveryBudget':3,'maxJsonChars':4500,'newModelCalls':0,
        'sortingKey':'RELATED probability descending, original RRF, cosine, memoryId',
        'scope':'only reorder already RELATED observations; unjudged evidence slots unchanged',
        'labels':'predeclared original-bank exploratory labels; not gold',
        'fixed':['all 63 native JEV results','admission','queries','retrieval','bodies','evidence','activity anchors','budgets'],
        'notImplemented':['family reading groups','history-specific ordering','new thresholds','formal runtime integration'],
        'frozenInputs':frozen})
    results=[];history=[]
    with patch.object(exp.bank.jev,'send',side_effect=AssertionError('offline replay must not call a model')), \
         patch.object(exp.bank.bridge,'utility_llm',side_effect=AssertionError('offline replay must not generate projection')):
        for row,call in zip(frozen_rows+frozen_history,calls):
            if 'stage' in row:
                data=prepared[row['stage']]
                ranking=rankings[(row['probe'],row['stage'])]
                request=exp.load(Path(protocol['bankRoot'])/(row['probe']+'-preview-request.json'))
                baseline=exp.load(Path(protocol['bankRoot'])/(row['probe']+'-baseline-recall.json'))
                query=ranking['query'];scored=ranking['rows']
                if row['sentIds']!=ranking['sentIds']:
                    raise ValueError('frozen shortlist changed')
                labels={e['memoryId']:expected[old if e['memoryId']==target else e['memoryId']].get(row['probe'],'irrelevant')
                        for e in data['entries']}
                required={i for i,label in labels.items() if label=='required'}
                irrelevant={i for i,label in labels.items() if label=='irrelevant'}
                identity={'stage':row['stage'],'probe':row['probe'],'repeat':row['repeat']}
            else:
                data=copy.deepcopy(prepared['D-families'])
                data['entries'].append(next(e for e in original['entries'] if e['memoryId']==old))
                data['contentHash']=exp.lineage.digest({k:v for k,v in data.items() if k!='contentHash'})
                exp.check(data)
                query=row['query'];scored=row['rows']
                request=exp.load(Path(protocol['bankRoot'])/'new-task-preview-request.json')
                request['context']['stimulus'][0]['content']['speech']['text']=query['originalText']
                baseline=exp.load(Path(protocol['bankRoot'])/'new-task-baseline-recall.json')
                if any(query[k]!=v for k,v in exp.bank.bridge.queries.project(
                        request,data['index']['retrievalAliases']).items()):
                    raise ValueError('historical stimulus changed')
                required={old,target};irrelevant=set()
                identity={'stage':'historical','probe':'historical','repeat':row['repeat']}
            scores={i:r for r in scored for i in r['readingIds']}
            pair=replay(data,request,baseline,query,scores,row,call)
            assessed={mode:metrics(pair['delivery'][mode],required,irrelevant,target) for mode in MODES}
            before=set(assessed['fusion']['readIds']);after=set(assessed['related_probability']['readIds'])
            result={**identity,'stimulus':row['stimulus'],'sentIds':row['sentIds'],'relatedIds':row['relatedIds'],
                    'required':sorted(required),'irrelevant':sorted(irrelevant),**pair,'metrics':assessed,
                    'delta':{'added':sorted(after-before),'removed':sorted(before-after),
                        'requiredRecovered':sorted(required & (after-before)),
                        'requiredLost':sorted(required & (before-after)),
                        'irrelevantAdded':sorted(irrelevant & (after-before)),
                        'irrelevantRemoved':sorted(irrelevant & (before-after))}}
            (results if 'stage' in row else history).append(result)
    after={str(p.resolve()):exp.hashes(p) for p in frozen_paths}
    if after!=frozen:
        raise ValueError('offline replay mutated frozen inputs')
    assessment={'artifactRoot':str(output),'summaries':summarize(results),
        'history':[{'repeat':r['repeat'],**{mode:{
            'oldRead':old in r['metrics'][mode]['readIds'],'currentRead':target in r['metrics'][mode]['readIds'],
            'opposedBranchRead':'bank:10' in r['metrics'][mode]['readIds'],'readIds':r['metrics'][mode]['readIds']}
            for mode in MODES}} for r in history],
        'deltas':[{'stage':r['stage'],'probe':r['probe'],'repeat':r['repeat'],**r['delta']}
                  for r in results+history if r['delta']['added'] or r['delta']['removed']],
        'frozenInputsUnchanged':True,'allOriginalDeliveriesExactlyReproduced':True,
        'nativeRequestsAndAnswersVerified':63,'newModelCalls':0,
        'mixedLayerCandidates':sum(any(i['relatedProbability'] is None for i in r['sortingInputs']) for r in results+history),
        'limits':['five probes repeated, no independent gold','only frozen RELATED candidates can be reordered',
            'probabilities uncalibrated, not cognition truth confidence','no Character Turn or live integration',
            'family/counterevidence grouping and historical policy unchanged']}
    exp.lineage.save(output/'results.json',results)
    exp.lineage.save(output/'historical-results.json',history)
    exp.lineage.save(output/'assessment.json',assessment)
    exp.lineage.save(Path(__file__).with_name('delivery-order-assessment.json'),assessment)
    print(json.dumps({'summaries':assessment['summaries'],'history':assessment['history'],
                      'frozenInputsUnchanged':True,'newModelCalls':0},ensure_ascii=True))

if __name__=='__main__':
    run(*sys.argv[1:3])
