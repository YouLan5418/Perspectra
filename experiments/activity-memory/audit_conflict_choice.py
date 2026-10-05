"""Read-only checks for the post-hoc conflict-removal Character diagnostic."""
import collections
import hashlib
import json
import statistics
import sys
from pathlib import Path

def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))

def audit(root):
    root=Path(root).resolve();protocol=load(root/'protocol.json')
    original=Path(protocol['inputRoot']);baseline=load(original/'new-building-0-natural-full/call.json')['request']
    plain=lambda request:{**request,'context':{**request['context'],'memories':[]}}
    canonical=plain(baseline)
    for path,digest in protocol['frozen'].items():
        if hashlib.sha256(Path(path).read_bytes()).hexdigest()!=digest:
            raise ValueError('original evidence changed')
    trials=[json.loads(line) for line in (root/'trials.jsonl').read_text(encoding='utf-8').splitlines()]
    expected={(repeat,condition) for repeat in range(protocol['repeats']) for condition in protocol['conditions']}
    if len(trials)!=len(expected) or {(r['repeat'],r['condition']) for r in trials}!=expected:
        raise ValueError('incomplete/repeated trials')
    counts={};responses=[];models=collections.Counter();usage=collections.Counter();latencies=[];invalid=0
    for row in trials:
        call=load(root/(str(row['repeat'])+'-'+row['condition'])/'call.json')
        full=load(original/('new-building-retrieval-'+str(row['repeat'])+'.json'))['delivery']['memories']
        excluded={'natural-full-repeat':set(),'without-opposed':{protocol['opposed']},
                  'without-opposed-and-target':{protocol['opposed'],protocol['target']}}[row['condition']]
        expected_memory=[m for m in full if m['memoryId'] not in excluded]
        if call['status']!='returned' or plain(call['request'])!=canonical or call['request']['context']['memories']!=expected_memory:
            raise ValueError('request/body/context intervention differs')
        if '\u96ea\u9752\u5bc6\u7801' in json.dumps(call['request'],ensure_ascii=False):
            raise ValueError('private canary leaked')
        record=load(root/(str(row['repeat'])+'-'+row['condition'])/'transport.json')
        if record['status']!=200:raise ValueError('non-200 response')
        native=json.loads(record['body']);response=call['response']
        if json.loads(native['choices'][0]['message']['tool_calls'][0]['function']['arguments'])!=response:
            raise ValueError('native output differs')
        models[native['model']]+=1;latencies.append(call['durationMs'])
        for key in ('prompt_tokens','completion_tokens','total_tokens'):usage[key]+=native.get('usage',{}).get(key,0)
        moves=[e for e in row['events'] if e['eventType']=='character.moved' and e['data']['characterId']=='character:npc']
        accepted=[e for e in row['events'] if e['eventType']=='action.resolved' and e['data'].get('accepted') is True and e['data']['actionType']=='move']
        if bool(moves)!=bool(accepted):raise ValueError('resolved move disagrees with committed move')
        result=row['result']
        if result.get('failure'):
            invalid+=1
            if row['events']:raise ValueError('failed initial output committed events')
        elif response['decision']=='publish':
            speech=[e for e in row['events'] if e['eventType']=='character.speak']
            if len(speech)!=1 or speech[0]['data']['text']!=response.get('speech',''):
                raise ValueError('speech differs')
        counter=counts.setdefault(row['condition'],collections.Counter())
        counter['draws']+=1;counter['acceptedMove']+=bool(moves)
        counter['published']+=result['status']=='published';counter['invalidOutput']+=result.get('failure')=='invalid_output'
        responses.append({'repeat':row['repeat'],'condition':row['condition'],'response':response,
                          'result':result,'acceptedMove':bool(moves)})
    result={'artifactRoot':str(root),'characterCalls':len(trials),'returned':len(trials),'legalOutputs':len(trials)-invalid,
            'newJevCalls':0,'newUtilityCalls':0,'nativeModelLabels':dict(models),'nativeCharacterUsageUnpriced':dict(usage),
            'latencyMs':{'min':min(latencies),'median':statistics.median(latencies),'max':max(latencies)},
            'originalInputsUnchanged':True,'nonmemoryContextIdenticalToPrimary':True,'nativeDecisionsVerified':True,
            'privateCanaryAbsent':True,'memoryRemovalOnly':True,
            'outcomes':[{'condition':condition,**dict(count)} for condition,count in counts.items()],
            'responses':responses,'limits':protocol['limits']}
    (root/'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k!='responses'},ensure_ascii=True))

if __name__=='__main__':audit(sys.argv[1])
