"""Audit the natural-candidate/Character experiment without model calls."""
import collections
import copy
import hashlib
import json
import sqlite3
import statistics
import sys
from pathlib import Path
from unittest.mock import patch
import lineage_retrieval as exp
import natural_choice_recall as runner

def load(p):
    return json.loads(Path(p).read_text(encoding='utf-8'))

def audit(root):
    root=Path(root).resolve();protocol=load(root/'protocol.json')
    prepared=load(root/'bank.json');authorized=load(root/'authorized.json')
    exp.check(prepared)
    if prepared['archive']['sources']!=authorized['sources']:
        raise ValueError('source prefix differs')
    for path,digest in protocol['frozen'].items():
        if hashlib.sha256(Path(path).read_bytes()).hexdigest()!=digest:
            raise ValueError('frozen input changed')
    db=sqlite3.connect((root/'history/world.sqlite').as_uri()+'?mode=ro',uri=True)
    try:
        db.execute('PRAGMA query_only=ON')
        if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':
            raise ValueError('invalid world storage')
        events={seq:(tick,h,json.loads(data)) for seq,tick,h,data in db.execute('SELECT seq,tick,event_hash,data_json FROM events')}
        for source in authorized['sources']:
            tick,digest,event=events[source['worldSeq']]
            if source['sourceHash']!=digest or source['knownTick']!=tick or event.get('value',{}).get('observerId')!=source['characterId']:
                raise ValueError('source identity/permission/tick changed')
    finally:db.close()
    calls=[json.loads(s) for s in (root/'jev-calls.jsonl').read_text(encoding='utf-8').splitlines()]
    if len(calls)!=protocol['maxJevCalls']:
        raise ValueError('unexpected JEV call count')
    entries={e['memoryId']:e for e in prepared['entries']}
    observations={o['id']:o for o in prepared['archive']['observations']}
    recalls={};retrieval_metrics=[];cost=0;jev_tokens=collections.Counter()
    def no_model(*args,**kwargs):raise AssertionError('audit must not call models')
    with patch.object(exp.bank.jev,'send',side_effect=no_model):
        for probe in protocol['probes']:
            request=load(root/(probe['id']+'-request.json'))
            for repeat in range(protocol['repeats']):
                stored=load(root/(probe['id']+'-retrieval-'+str(repeat)+'.json'))
                native=calls[len(retrieval_metrics)]
                expected=exp.bank.jev.many_request(stored['stimulus'],[
                    {'memoryId':i,'understanding':observations[i]['text'],'applicability':entries[i]['facets']}
                    for i in stored['sentIds']])
                if native['status']!='returned' or native['request']!=expected or native['result']!=stored['decision']:
                    raise ValueError('native JEV decisions changed')
                for answer in stored['decision']['answers'].values():exp.bank.jev.validate_decision(answer)
                with patch.object(exp.bank.jev,'assess_many',return_value=copy.deepcopy(stored['decision'])):
                    replay=runner.recall({'prepared':prepared,'authorized':authorized,'request':request,'target':protocol['target']})
                for field in ('query','sentIds','relatedIds','rankedIds','probabilityRankedIds','conditions',
                              'targetShortlisted','targetRelated','targetDelivered'):
                    if replay[field]!=stored[field]:raise ValueError('offline replay changed '+field)
                if len(stored['delivery']['memories'])>3 or stored['delivery']['trace']['jsonChars']>4500:
                    raise ValueError('delivery budget changed')
                recalls[(probe['id'],repeat)]=stored
                retrieval_metrics.append({'probe':probe['id'],'repeat':repeat,'sentIds':stored['sentIds'],
                    'relatedIds':stored['relatedIds'],'readIds':[m['memoryId'] for m in stored['delivery']['memories']],
                    **{k:stored[k] for k in ('targetShortlisted','targetRelated','targetDelivered')}})
                usage=stored['decision'].get('usage',{});cost+=usage.get('cost',0) or 0
                for key in ('input_tokens','output_tokens'):jev_tokens[key]+=usage.get(key,0)
    trials=[json.loads(s) for s in (root/'trials.jsonl').read_text(encoding='utf-8').splitlines()]
    expected={(p['id'],c,r) for p in protocol['probes'] for c in protocol['conditions'] for r in range(protocol['repeats'])}
    if len(trials)!=len(expected) or {(r['probe'],r['condition'],r['repeat']) for r in trials}!=expected:
        raise ValueError('incomplete or repeated trials')
    contexts={};summaries={};responses=[];latencies=[];models=collections.Counter();usage=collections.Counter();failures=[]
    for row in trials:
        directory=root/(row['probe']+'-'+str(row['repeat'])+'-'+row['condition'])
        call=load(directory/'call.json')
        if call['status']!='returned' or not row['returned'] or row['calls']!=1:
            raise ValueError('call did not return once')
        request=call['request'];recall=recalls[(row['probe'],row['repeat'])]
        if request['context']['memories']!=recall['conditions'][row['condition']]:
            raise ValueError('actual reading differs from projection')
        if '雪青密码' in json.dumps(request,ensure_ascii=False):
            raise ValueError('private context leaked')
        plain={**request,'context':{**request['context'],'memories':[]}}
        if row['probe'] in contexts and contexts[row['probe']]!=plain:
            raise ValueError('nonmemory context changed')
        contexts[row['probe']]=plain
        response=call['response'];native_record=load(directory/'transport.json')
        if native_record['status']!=200:raise ValueError('unexpected HTTP status')
        native=json.loads(native_record['body'])
        if json.loads(native['choices'][0]['message']['tool_calls'][0]['function']['arguments'])!=response:
            raise ValueError('native output changed')
        models[native['model']]+=1;latencies.append(call['durationMs'])
        for key in ('prompt_tokens','completion_tokens','total_tokens'):usage[key]+=native.get('usage',{}).get(key,0)
        moves=[e for e in row['events'] if e['eventType']=='character.moved' and e['data']['characterId']=='character:npc']
        accepted=[e for e in row['events'] if e['eventType']=='action.resolved' and e['data'].get('accepted') is True and e['data']['actionType']=='move']
        if bool(moves)!=bool(accepted):raise ValueError('move fact and resolution disagree')
        identity={k:row[k] for k in ('probe','repeat','condition')}
        if row['result'].get('failure'):
            failures.append({**identity,'result':row['result'],'response':response})
            if row['events']:raise ValueError('invalid initial output committed events')
        elif response['decision']=='publish':
            published=[e for e in row['events'] if e['eventType']=='character.speak']
            if len(published)!=1 or published[0]['data']['text']!=response.get('speech',''):
                raise ValueError('publication differs from response')
        key=(row['probe'],row['condition'])
        counts=summaries.setdefault(key,collections.Counter())
        counts['draws']+=1;counts['acceptedMove']+=bool(moves)
        counts['published']+=row['result']['status']=='published';counts['invalidOutput']+=row['result'].get('failure')=='invalid_output'
        responses.append({**identity,'response':response,'result':row['result'],'acceptedMove':bool(moves)})
    result={'artifactRoot':str(root),'characterCalls':len(trials),'returned':len(trials),'legalOutputs':len(trials)-len(failures),
        'jevCalls':len(calls),'jevTokens':dict(jev_tokens),'jevReportedCostUSD':cost,'newUtilityCalls':0,
        'requestedModel':protocol['model'],'nativeModelLabels':dict(models),'nativeCharacterUsageUnpriced':dict(usage),
        'latencyMs':{'min':min(latencies),'median':statistics.median(latencies),'max':max(latencies)},
        'sourceCount':len(authorized['sources']),'frozenInputsUnchanged':True,'sourceMappingsAndObserverChecked':True,
        'nativeDecisionsVerified':True,'offlineRetrievalDeliveryReplays':len(retrieval_metrics),'nonmemoryContextIdentical':True,
        'privateCanaryAbsent':True,'retrieval':retrieval_metrics,
        'outcomes':[{'probe':p,'condition':c,**dict(v)} for (p,c),v in summaries.items()],
        'failures':failures,'responses':responses,
        'limits':protocol['limits']+['no automatic semantic labels','no attribution to target without matching target-removal difference']}
    (root/'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k not in ('responses','retrieval','failures')},ensure_ascii=True))

if __name__=='__main__':audit(sys.argv[1])
