"""Natural bank shortlist -> existing JEV -> existing Delivery, no utility calls."""
import copy
import json
import sys
from unittest.mock import patch
import lineage_retrieval as exp
import delivery_order as delivery_order

def recall(doc):
    prepared, request = doc['prepared'],doc['request']
    delivery_order.scope_check(prepared,request)
    exp.check(prepared)
    if prepared['archive']['sources']!=doc['authorized']['sources']:
        raise ValueError('bank source prefix is not authorized')
    if any(s['knownTick']>55 for s in prepared['archive']['sources']):
        raise ValueError('future evidence')
    with patch.object(exp.bank.bridge,'utility_llm',side_effect=AssertionError('frozen projection only')), \
         patch.object(exp.bank.bridge.core,'llm',side_effect=AssertionError('no new retain')):
        baseline=exp.bank.bridge.dispatch({'operation':'recall','archive':prepared['archive'],
            'index':prepared['index'],'request':copy.deepcopy(request),'tick':55,'observations':True})
        query=baseline['query']
        raw,elapsed=exp.bank.trigger(prepared,query)
        rows=[{**r,'groupId':r['memoryId'],'readingIds':[r['memoryId']]} for r in raw]
        ids,groups,rejected=exp.shortlist(rows,7)
        result=exp.evaluate(prepared,query,request,baseline,rows,ids)
        scores={i:r for r in rows for i in r['readingIds']}
        candidates,original=exp.bank.deliver(prepared,{**baseline,'query':copy.deepcopy(query)},request,
                                             55,result['relatedIds'],scores,'lineage')
        if original!=result['delivery']:
            raise ValueError('same input produced different Delivery')
        ranked=delivery_order.order(candidates,result['decision'])
        actual=exp.bank.bridge.activity.deliver(prepared['archive'],ranked,request,55,copy.deepcopy(query))
    target=doc['target']
    full=actual['memories']
    conditions={'natural-full':full,
        'target-removed':[m for m in full if m['memoryId']!=target],
        'no-observations':[m for m in full if m['memoryLevel']!='observation']}
    return {'query':query,'rows':rows,'candidateBudget':7,'shortlistGroups':groups,
        'shortlistRejected':rejected,'triggerLatencyMs':elapsed,**result,
        'fusionDelivery':original,'probabilityRankedIds':[c['id'] for c in ranked],
        'delivery':actual,'conditions':conditions,'target':target,
        'targetShortlisted':target in ids,'targetRelated':target in result['relatedIds'],
        'targetDelivered':target in {m['memoryId'] for m in full},
        'newUtilityCalls':0,'forcedTarget':False}

if __name__=='__main__':
    json.dump(recall(json.load(sys.stdin)),sys.stdout,ensure_ascii=False)
