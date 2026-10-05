"""Read-only regression replay for activity counterevidence allocation."""
import copy
import json
import sys
from pathlib import Path
from unittest.mock import patch
import delivery_order as order_exp
import delivery_groups as groups
import lineage_retrieval as exp

def run(output, order_root, groups_root):
    output, order_root, groups_root = map(Path, (output, order_root, groups_root))
    if output.exists():
        raise ValueError('fresh output directory required')
    op = exp.load(order_root/'protocol.json')
    root = Path(op['inputRoot'])
    paths = list(dict.fromkeys([order_root, groups_root, *map(Path, op['frozenInputs'])]))
    before = {str(p.resolve()):exp.hashes(p) for p in paths}
    for p, expected in op['frozenInputs'].items():
        if before[str(Path(p).resolve())] != expected:
            raise ValueError('frozen upstream inputs changed')
    protocol = exp.load(root/'protocol.json')
    bank_root = Path(protocol['bankRoot'])
    prepared = exp.load(root/'prepared.json')
    for value in prepared.values():
        exp.check(value)
    original = exp.load(bank_root/'facet-projection.json')
    old = exp.load(Path(protocol['lineageRoot'])/'bank-update.json')['revisedFrom'][0]
    rankings = {(r['probe'],r['stage']):r for r in exp.load(root/'rankings.json')}
    normal = exp.load(root/'results.json')
    history = exp.load(root/'historical-results.json')
    saved = exp.load(order_root/'results.json') + exp.load(order_root/'historical-results.json')
    calls = [json.loads(s) for s in (root/'jev-calls.jsonl').read_text(encoding='utf-8').splitlines()]
    if (len(normal),len(history),len(saved),len(calls)) != (60,3,63,63):
        raise ValueError('frozen replay is incomplete')
    results = []
    def no_model(*args, **kwargs):
        raise AssertionError('deterministic regression must not call models')
    with patch.object(exp.bank.jev,'send',side_effect=no_model), \
         patch.object(exp.bank.bridge,'utility_llm',side_effect=no_model), \
         patch.object(exp.bank.bridge.core,'llm',side_effect=no_model):
        for row, call, prior in zip(normal+history,calls,saved):
            if 'stage' in row:
                data = prepared[row['stage']]
                ranking = rankings[(row['probe'],row['stage'])]
                request = exp.load(bank_root/(row['probe']+'-preview-request.json'))
                baseline = exp.load(bank_root/(row['probe']+'-baseline-recall.json'))
                query, scored = ranking['query'], ranking['rows']
                if row['sentIds'] != ranking['sentIds']:
                    raise ValueError('frozen shortlist changed')
                identity = {k:row[k] for k in ('stage','probe','repeat')}
            else:
                data = copy.deepcopy(prepared['D-families'])
                data['entries'].append(next(e for e in original['entries'] if e['memoryId']==old))
                data['contentHash'] = exp.lineage.digest({k:v for k,v in data.items() if k!='contentHash'})
                exp.check(data)
                query, scored = row['query'], row['rows']
                request = exp.load(bank_root/'new-task-preview-request.json')
                request['context']['stimulus'][0]['content']['speech']['text'] = query['originalText']
                baseline = exp.load(bank_root/'new-task-baseline-recall.json')
                identity = {'stage':'historical','probe':'historical','repeat':row['repeat']}
            scores = {i:r for r in scored for i in r['readingIds']}
            pair = order_exp.replay(data,request,baseline,query,scores,row,call)
            for key,value in pair.items():
                if value != prior[key]:
                    raise ValueError('frozen replay changed '+key+' '+str(identity))
            results.append({**identity,'exactMatch':True,**pair})
        prior_anchor = exp.load(groups_root/'anchor-control.json')
        fixed = groups.anchor_control()
        if fixed['archive'] != prior_anchor['archive']:
            raise ValueError('anchor control evidence changed')
        counter, summary = fixed['counterAtomId'],fixed['summaryId']
        def status(delivery):
            return {'itemCount':len(delivery['memories']),
                    'jsonChars':delivery['trace']['jsonChars'],
                    'summaryIncluded':summary in {m['memoryId'] for m in delivery['memories']},
                    'counterIncluded':any(counter in t['coveredAtomIds'] for t in delivery['trace']['delivered']),
                    **{k:delivery['trace']['activityCoverage'][0][k] for k in ('endingIncluded','openingIncluded')}}
        old_status, new_status = status(prior_anchor['oldDelivery']),status(fixed['runtimeDelivery'])
        if not (old_status['summaryIncluded'] and not old_status['counterIncluded']):
            raise ValueError('historical failure snapshot changed')
        if not (new_status['itemCount']==3 and new_status['jsonChars']<=4500
                and new_status['summaryIncluded'] and new_status['counterIncluded']
                and new_status['endingIncluded'] and not new_status['openingIncluded']):
            raise ValueError('repaired allocation failed boundary control')
    if {str(p.resolve()):exp.hashes(p) for p in paths} != before:
        raise ValueError('regression mutated frozen inputs')
    assessment = {'artifactRoot':str(output.resolve()),'exactFrozenReplays':len(results),
                  'nativeJevRequestsAndAnswersVerified':len(calls),'newModelCalls':0,
                  'frozenInputsUnchanged':True,'anchorBefore':old_status,'anchorAfter':new_status,
                  'budgets':{'maxItems':3,'maxJsonChars':4500},
                  'limits':['synthetic anchor control','no new Character Turn','no global conflict grouping']}
    output.mkdir(parents=True)
    exp.lineage.save(output/'protocol.json',{'orderRoot':str(order_root.resolve()),
        'groupsRoot':str(groups_root.resolve()),'frozenInputs':before,'newModelCalls':0})
    exp.lineage.save(output/'results.json',results)
    exp.lineage.save(output/'anchor-control.json',fixed)
    exp.lineage.save(output/'assessment.json',assessment)
    exp.lineage.save(Path(__file__).with_name('delivery-counter-fix-assessment.json'),assessment)
    print(json.dumps(assessment,ensure_ascii=True))

if __name__=='__main__':
    run(*sys.argv[1:4])
