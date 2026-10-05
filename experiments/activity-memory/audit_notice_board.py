"""Read-only independent audit of native calls, persisted commits and authorized Sources."""
import collections
import hashlib
import json
import sqlite3
import statistics
import sys
from pathlib import Path

def load(p):
    return json.loads(Path(p).read_text(encoding='utf-8'))

def readonly(p):
    db=sqlite3.connect(Path(p).resolve().as_uri()+'?mode=ro',uri=True)
    db.execute('PRAGMA query_only=ON')
    if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':
        raise ValueError('database integrity failure')
    return db

def audit(root):
    root=Path(root).resolve()
    protocol=load(root/'protocol.json')
    summary=load(root/'summary.json')
    if hashlib.sha256(Path(protocol['original']).read_bytes()).hexdigest()!=protocol['frozenHash']:
        raise ValueError('original input changed')
    original=load(protocol['original'])
    target=next(m for m in original['delivery']['memories'] if m['memoryId']=='family:traveler-navigation:revision:20:1')
    if target['text']!=protocol['priorText']:
        raise ValueError('prior text changed')
    models=collections.Counter();usage=collections.Counter();latencies=[];rows=0;total_reads=0;canonical=None
    results=[]
    for repeat in range(protocol['repeats']):
        directory=root/('repeat-'+str(repeat));trial=load(directory/'summary.json')
        world=readonly(directory/'world.sqlite')
        try:
            events={seq:{'tick':tick,'eventType':kind,'data':json.loads(data),'eventHash':digest,'transactionId':txn}
                    for seq,tick,kind,data,digest,txn in world.execute('SELECT seq,tick,event_type,data_json,event_hash,transaction_id FROM events')}
        finally:world.close()
        memory=readonly(directory/'memory.sqlite')
        try:
            sources=memory.execute('SELECT namespace_key,source_id,source_seq,source_hash,epistemic_kind,text_value FROM cognitive_memory_v2_sources').fetchall()
        finally:memory.close()
        for namespace,sid,seq,digest,kind,text in sources:
            event=events[seq];value=event['data']['value'];actor=namespace.split(chr(31))[-1]
            if sid!='event:'+str(seq) or digest!=event['eventHash'] or value['observerId']!=actor:
                raise ValueError('Source mapping mismatch')
            if isinstance(value['content'],dict) and 'speech' in value['content'] and kind!='reported_speech':
                raise ValueError('speech upgraded')
            if actor!='character:bob' and '\u9752\u6749' in text:raise ValueError('private source leaked')
            rows+=1
        staged=load(directory/'stages.json')
        for stage in staged:
            for traced in stage['events']:
                stored=events[traced['seq']]
                if any(traced[k]!=stored[k] for k in ('tick','eventType','data','eventHash')):
                    raise ValueError('event trace differs from database')
        calls=[load(directory/('call-'+str(i)+'.json')) for i in range(trial['calls'])]
        for call in calls:
            native=load(directory/('transport-'+str(call['index'])+'.json'))
            if native['status']!=200:raise ValueError('provider response failed')
            response=json.loads(native['body']);message=response['choices'][0]['message']
            if 'tool_calls' in message:
                if len(message['tool_calls'])!=1:raise ValueError('multiple native calls')
                decoded=json.loads(message['tool_calls'][0]['function']['arguments'])
            else:decoded=json.loads(message['content'])
            if decoded!=call['response']:raise ValueError('native response differs from decision')
            if '\u9752\u6749' in json.dumps(call['request'],ensure_ascii=False):raise ValueError('private context leaked')
            models[response.get('model')]+=1
            for k,v in response.get('usage',{}).items():
                if isinstance(v,(int,float)):usage[k]+=v
            latencies.append(call['durationMs'])
        if canonical is None:canonical=calls[0]['request']
        elif canonical!=calls[0]['request']:raise ValueError('first request differs')
        reads=[(seq,e) for seq,e in events.items() if e['eventType']=='observation.upsert'
               and isinstance(e['data']['value']['content'],dict)
               and e['data']['value']['content'].get('capabilityId')=='experiment:inspect-notice-board']
        for seq,event in reads:
            value=event['data']['value'];content=value['content'];txn=event['transactionId']
            related=[e for e in events.values() if e['transactionId']==txn]
            resolved=[e for e in related if e['eventType']=='action.resolved' and e['data']['actionId']==value['actionId']]
            if len(resolved)!=1 or not resolved[0]['data']['accepted'] or not any(e['eventType']=='world.tick-advanced' for e in related):
                raise ValueError('read/action/tick not in same transaction')
            row=[s for s in sources if s[2]==seq]
            if len(row)!=1 or not row[0][0].endswith(chr(31)+'character:npc') or row[0][4]!='direct_observation':
                raise ValueError('reading ownership/kind wrong')
            if content['observedText']!='\u767b\u8bb0\u5904\uff1a\u4e8c\u697c203':raise ValueError('wrong board content')
            if '203' in json.dumps(calls[0]['request'],ensure_ascii=False):raise ValueError('pre-read content leak')
            continuations=[c for c in calls if c['request'].get('continuation')
                           and c['request'].get('result',{}).get('evidence',{}).get('actionId')==value['actionId']]
            if not continuations or continuations[0]['head']['headSeq']<seq:
                raise ValueError('no committed read continuation')
            if str(content['observedText']) not in json.dumps(continuations[0]['request'],ensure_ascii=False):
                raise ValueError('missing result')
            if '203' not in json.dumps(calls[-1]['request']['context']['observations'],ensure_ascii=False):
                raise ValueError('next activation lost read evidence')
            first=calls[0]['response']
            if first.get('decision')!='perform' or first.get('actionType')!='interact' or first['parameters']['targetRef']['id']!=content['targetId']:
                raise ValueError('no native inspection decision')
            total_reads+=1
        results.append({'repeat':repeat,'calls':trial['calls'],'reads':len(reads),
                        'readSeqs':[s for s,_ in reads],
                        'continuation':calls[1]['response'],'nextTurn':calls[-1]['response']})
    if len(latencies)!=summary['calls'] or total_reads!=summary['reads']:raise ValueError('totals disagree')
    return {'audited':True,'trials':len(results),'calls':len(latencies),'reads':total_reads,'sourceRowsAllCharacters':rows,
            'sameTransaction':True,'nativeDecisionsMatch':True,'authorizedSourceMapping':True,'privateIsolation':True,
            'initialContextIdentical':True,'originalUnchanged':True,'requestedModel':protocol['model'],
            'returnedModels':dict(models),'usage':dict(usage),
            'medianLatencyMs':statistics.median(latencies),'maximumLatencyMs':max(latencies),
            'results':results}
if __name__=='__main__':
    result=audit(sys.argv[1])
    Path(sys.argv[1],'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=True))
