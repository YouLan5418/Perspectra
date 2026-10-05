"""Audit sequential continuations from actual persisted events, without model calls."""
import collections
import copy
import hashlib
import json
import sqlite3
import statistics
import sys
from pathlib import Path

def load(p):
    return json.loads(Path(p).read_text(encoding='utf-8'))
def lines(p):
    return [json.loads(s) for s in Path(p).read_text(encoding='utf-8').splitlines()]
def readonly(p):
    db=sqlite3.connect(Path(p).resolve().as_uri()+'?mode=ro',uri=True)
    db.execute('PRAGMA query_only=ON')
    if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':
        raise ValueError('invalid database')
    return db
def events(db):
    return {seq:{'tick':tick,'eventType':kind,'data':json.loads(data),'eventHash':digest}
            for seq,tick,kind,data,digest in db.execute('SELECT seq,tick,event_type,data_json,event_hash FROM events')}

def audit(root):
    root=Path(root).resolve();protocol=load(root/'protocol.json');summary=load(root/'summary.json')
    for p,h in protocol['frozen'].items():
        if hashlib.sha256(Path(p).read_bytes()).hexdigest()!=h:raise ValueError('original changed')
    for repeat in range(protocol['repeats']):
        if load(root/('reading-'+str(repeat)+'.json'))!=load(Path(protocol['inputRoot'])/('new-building-retrieval-'+str(repeat)+'.json')):
            raise ValueError('copied natural reading changed')
    episodes=lines(root/'episodes.jsonl')
    expected={(r['id'],repeat,c) for r in protocol['replies'] for repeat in range(protocol['repeats']) for c in protocol['conditions']}
    if len(episodes)!=len(expected) or {(r['reply'],r['repeat'],r['condition']) for r in episodes}!=expected:
        raise ValueError('incomplete or repeated episodes')
    root_db=readonly(root/'history/world.sqlite')
    try:initial=events(root_db)
    finally:root_db.close()
    total=0;usage=collections.Counter();models=collections.Counter();latencies=[];responses=[];source_count=0;failures=[];canonical=None;outcomes=[]
    for ep in episodes:
        directory=root/ep['id'];stages=lines(directory/'stages.jsonl');players=lines(directory/'player.jsonl')
        world=readonly(directory/'world.sqlite')
        try:stored=events(world)
        finally:world.close()
        if {seq:stored[seq] for seq in initial}!=initial:raise ValueError('initial copy changed')
        recorded=[e for r in players+stages for e in r['events']]
        if len({e['seq'] for e in recorded})!=len(recorded) or {e['seq'] for e in recorded}!=set(stored)-set(initial):
            raise ValueError('events omitted or duplicated')
        for e in recorded:
            if stored[e['seq']]!={k:e[k] for k in ('tick','eventType','data','eventHash')}:
                raise ValueError('trace differs from committed event')
        memory=readonly(directory/'memory.sqlite')
        try:
            sources=memory.execute('SELECT namespace_key,source_id,source_hash,epistemic_kind,source_seq,text_value FROM cognitive_memory_v2_sources').fetchall()
        finally:memory.close()
        for namespace,source_id,digest,kind,seq,text in sources:
            if not namespace.endswith('\x1fcharacter:npc'):raise ValueError('foreign namespace')
            event=stored[seq]
            if source_id!='event:'+str(seq) or digest!=event['eventHash'] or event['data'].get('value',{}).get('observerId')!='character:npc':
                raise ValueError('source mapping/observer differs')
            content=event['data'].get('value',{}).get('content',{})
            speech=content.get('speech') if isinstance(content,dict) else None
            if speech and kind!='reported_speech':raise ValueError('speech upgraded to fact')
            if '\u96ea\u9752\u5bc6\u7801' in text:raise ValueError('private source leaked')
        source_count+=len(sources)
        full=load(root/('reading-'+str(ep['repeat'])+'.json'))['delivery']['memories']
        selected=[m for m in full if ep['condition']=='full' or (m['memoryId']!='bank:10' and
                  (ep['condition']!='atom-only' or m['memoryId']!=protocol['target']))]
        if len(stages)!=ep['stages'] or sum(s['calls'] for s in stages)!=ep['calls'] or ep['calls']>6:
            raise ValueError('episode counts differ')
        move_before=False
        for st in stages:
            stage=st['stage'];speech=[p for p in players if p['tag']=='speech:'+str(stage)]
            if len(speech)!=1:raise ValueError('player stage missing')
            expected_text=protocol['initialText'] if stage==0 else next(r['text'] for r in protocol['replies'] if r['id']==ep['reply']) if stage==1 else protocol['finalText']
            if speech[0]['action']['parameters']['text']!=expected_text or st['playerText']!=expected_text:
                raise ValueError('player content changed')
            stimulus=[e['data']['value'] for e in speech[0]['events'] if e['eventType']=='observation.upsert'
                      and e['data']['value']['observerId']=='character:npc']
            if len(stimulus)!=1:raise ValueError('player speech not visible to NPC')
            stage_moves=[e for e in st['events'] if e['eventType']=='character.moved' and e['data']['characterId']=='character:npc']
            accepted=[e for e in st['events'] if e['eventType']=='action.resolved' and e['data']['actorId']=='character:npc'
                      and e['data']['actionType']=='move' and e['data']['accepted']]
            if len(stage_moves)!=len(accepted):raise ValueError('move and adjudication differ')
            outcome={'episode':ep['id'],'reply':ep['reply'],'repeat':ep['repeat'],'condition':ep['condition'],
                     'stage':stage,'calls':st['calls'],'acceptedMove':len(stage_moves),'alreadyMovedBeforeStage':move_before,
                     'status':st['result']['status'],'failure':st['result'].get('failure')}
            outcomes.append(outcome);move_before=move_before or bool(stage_moves)
            for index in range(st['firstCall'],st['firstCall']+st['calls']):
                call=load(directory/('call-'+str(index)+'.json'));request=call['request'];context=request['context']
                if call['dry'] or call['status']!='returned' or call['stage']!=stage or request['canRecall']:
                    raise ValueError('call identity/status differs')
                expect=[] if stage==2 else [{**m,'sourceAgeTicks':m['sourceAgeTicks']+call['tick']-protocol['tick']} for m in selected]
                if context['memories']!=expect or len(expect)>3 or len(json.dumps(expect,ensure_ascii=False,separators=(',',':')))>4500:
                    raise ValueError('reading projection differs')
                if context['stimulus']!=stimulus or '\u96ea\u9752\u5bc6\u7801' in json.dumps(request,ensure_ascii=False):
                    raise ValueError('stimulus/private context changed')
                for obs in context['observations']:
                    event=stored[obs['sourceSeq']]
                    if not protocol['prefixSeq']<obs['sourceSeq']<=call['headSeq'] or event['data']['value']!=obs['value'] or obs['value']['observerId']!='character:npc':
                        raise ValueError('recent observation unauthorized/future/changed')
                for obs in context['selfObservations']:
                    event=stored[obs['sourceSeq']]
                    if not protocol['prefixSeq']<obs['sourceSeq']<=call['headSeq'] or event['data'].get('characterId')!='character:npc':
                        raise ValueError('self observation unauthorized/future')
                if stage==0 and not request['continuation']:
                    plain=copy.deepcopy(request);plain['context']['memories']=[]
                    if canonical is not None and canonical!=plain:raise ValueError('initial context differs')
                    canonical=plain
                if request['continuation']:
                    if request['canPerform'] or request.get('result',{}).get('status')!='accepted':
                        raise ValueError('continuation does not reflect accepted action')
                    if not stage_moves:raise ValueError('continuation lacks committed move')
                native_record=load(directory/('transport-'+str(index)+'.json'))
                if native_record['status']!=200:raise ValueError('HTTP failed')
                native=json.loads(native_record['body']);response=call['response']
                message=native['choices'][0]['message']
                decoded=json.loads(message['tool_calls'][0]['function']['arguments']) if message.get('tool_calls') else message.get('content')
                if decoded!=response:
                    raise ValueError('native response changed')
                models[native['model']]+=1;total+=1;latencies.append(call['durationMs'])
                for k in ('prompt_tokens','completion_tokens','total_tokens'):usage[k]+=native.get('usage',{}).get(k,0)
                if isinstance(response,dict) and response.get('decision')=='publish':
                    matching=[e for e in st['events'] if e['eventType']=='character.speak' and e['seq']>call['headSeq']]
                    invalid_last=st['result'].get('failure')=='invalid_output' and index==st['firstCall']+st['calls']-1
                    if not invalid_last and (len(matching)!=1 or matching[0]['data']['text']!=response.get('speech','')):
                        raise ValueError('published output differs')
                responses.append({**outcome,'callIndex':index,'continuation':request['continuation'],'response':response})
            if st['result'].get('failure'):
                last=load(directory/('call-'+str(st['firstCall']+st['calls']-1)+'.json'))
                if any(e['seq']>last['headSeq'] for e in st['events']):raise ValueError('failed output committed events')
                failures.append({**outcome,'response':last['response']})
    if total!=summary['calls'] or total>protocol['maxCharacterCalls']:raise ValueError('total calls differ')
    result={'artifactRoot':str(root),'episodes':len(episodes),'activations':len(outcomes),'characterCalls':total,'returned':total,
        'failedActivations':len(failures),'newJevCalls':0,'newUtilityCalls':0,'nativeModelLabels':dict(models),
        'nativeCharacterUsageUnpriced':dict(usage),'latencyMs':{'min':min(latencies),'median':statistics.median(latencies),'max':max(latencies)},
        'sourceRowsAcrossEpisodeCopiesChecked':source_count,'originalInputsUnchanged':True,'committedEventTraceExact':True,
        'initialNonmemoryContextIdentical':True,'laterContextsAllowedToDiverge':True,'nativeDecisionsVerified':True,
        'privateCanaryAbsent':True,'speechSourcesRemainReportedSpeech':True,'thirdStageLongTermReadingEmpty':True,
        'outcomes':outcomes,'responses':responses,'failures':failures,'limits':protocol['limits']}
    (root/'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k not in ('outcomes','responses','failures')},ensure_ascii=True))

if __name__=='__main__':audit(sys.argv[1])
