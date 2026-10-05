"""Audit native result-only timing comparison with no new model calls."""
import collections
import json
import statistics
import sys
from pathlib import Path
import cognition_lineage as lineage
import notice_board_conflict as conflict
from audit_notice_board_revision import dbread, events, check_frozen, load

def plain_readings(archive,now_tick,paired=False):
    """Independent expected projection from the canonical sources, for auditing TS delivery."""
    labels={'entity:hall-board':'大厅公告牌','entity:distant-board':'窗口指示牌'}
    by_source={s['sourceId']:s for s in archive['sources']}
    parts=[]
    for atom in archive['facts']:
        source=by_source[atom['sourceRefs'][0]['sourceId']]
        content=json.loads(source['text'])
        if content['description']!='你亲眼看到公告牌上写着：'+content['observedText']:
            raise ValueError('unexpected host description')
        parts.append({'memoryId':atom['id'],'memoryLevel':'event_atom','epistemicKind':'direct_observation',
            'text':'【本角色的直接观察】'+labels[content['targetId']]+'：'+content['description'],
            'sourceIds':[source['sourceId']],'sourceRefs':atom['sourceRefs'],
            'sourceAgeTicks':now_tick-source['knownTick']})
    if not paired:return parts
    return [{'memoryId':'delivery:inscription-pair','memoryLevel':'event_atom','epistemicKind':'direct_observation',
        'eventAtomIds':[a['id'] for a in archive['facts']],
        'text':'\n'.join(p['text'] for p in parts),
        'sourceIds':[s for p in parts for s in p['sourceIds']],
        'sourceRefs':[r for p in parts for r in p['sourceRefs']],
        'sourceAgeTicks':min(p['sourceAgeTicks'] for p in parts)}]

def audit(seed_root,update_root,choice_root):
    seeds=Path(seed_root).resolve();updates=Path(update_root).resolve();choices=Path(choice_root).resolve()
    up=load(updates/'protocol.json');cp=load(choices/'protocol.json')
    check_frozen(up);check_frozen(cp)
    traces=[json.loads(s) for s in (updates/'utility-calls.jsonl').read_text(encoding='utf-8').splitlines()]
    if len(traces)!=3:raise ValueError('unexpected utility calls')
    seed_events={};relations=collections.Counter();revisions=[];models=collections.Counter()
    usage=collections.Counter();latencies=[];source_rows=0;groups={};first_context={};initial_speech=[]
    def check_directory(directory,tags,base=None):
        nonlocal source_rows
        db=dbread(directory/'world.sqlite')
        try:stored=events(db)
        finally:db.close()
        exported=load(directory/'events.json')
        if len(exported)!=len(stored) or any(e['eventHash']!=stored[e['seq']]['hash'] or e['data']!=stored[e['seq']]['data'] for e in exported):
            raise ValueError('event export differs')
        if base and {s:stored[s] for s in base}!=base:raise ValueError('copied evidence history changed')
        db=dbread(directory/'memory.sqlite')
        try:rows=db.execute('SELECT namespace_key,source_id,source_seq,source_hash,epistemic_kind,text_value FROM cognitive_memory_v2_sources').fetchall()
        finally:db.close()
        for ns,sid,seq,digest,kind,text in rows:
            e=stored[seq];owner=ns.split(chr(31))[-1];value=e['data']['value'];content=value['content']
            if sid!='event:'+str(seq) or digest!=e['hash'] or value['observerId']!=owner:
                raise ValueError('invalid Source namespace/hash/owner')
            if isinstance(content,dict) and 'speech' in content and kind!='reported_speech':
                raise ValueError('speech promoted to fact')
            if owner!='character:bob' and '青杉' in text:raise ValueError('private memory leaked')
            source_rows+=1
        calls=[]
        for tag,count in tags:
            for index in range(count):
                call=load(directory/(tag+'-call-'+str(index)+'.json'))
                transport=load(directory/(tag+'-transport-'+str(index)+'.json'))
                if transport['status']!=200 or call['status']!='returned':raise ValueError('provider failure')
                body=json.loads(transport['body']);message=body['choices'][0]['message']
                if 'tool_calls' in message:
                    if len(message['tool_calls'])!=1:raise ValueError('multiple responses')
                    native=json.loads(message['tool_calls'][0]['function']['arguments'])
                else:native=json.loads(message['content'])
                if native!=call['response']:raise ValueError('native answer modified')
                models[body.get('model')]+=1
                for k,v in body.get('usage',{}).items():
                    if isinstance(v,(int,float)):usage[k]+=v
                latencies.append(call['durationMs']);calls.append(call)
                request=call['request'];serialized=json.dumps(request,ensure_ascii=False);head=call['head']['headSeq']
                if '青杉' in serialized:raise ValueError('private context leaked')
                for target,text in [('entity:hall-board','登记处：二楼203'),('entity:distant-board','登记处：一楼105')]:
                    observed=any(s<=head and e['type']=='observation.upsert' and isinstance(e['data']['value']['content'],dict)
                      and e['data']['value']['content'].get('targetId')==target
                      and e['data']['value'].get('epistemicKind')=='direct_observation' for s,e in stored.items())
                    if not observed and text in serialized:raise ValueError('inscription delivered before commit')
                if native['decision']=='publish':
                    if not any(s>head and e['type']=='character.speak' and e['data']['characterId']=='character:npc'
                      and e['data']['text']==native.get('speech','') for s,e in stored.items()):
                        raise ValueError('speech not committed')
        return stored,calls
    for seed in range(3):
        directory=seeds/('repeat-'+str(seed))
        stored,calls=check_directory(directory,[('first',2),('second',1)])
        seed_events[seed]=stored;handoff=load(directory/'handoff.json')
        second_result=load(directory/'second-result.json')
        if second_result['status']!='budget_exhausted' or second_result['performResult']['status']!='accepted':
            raise ValueError('seed is not a deliberately bounded accepted inspect')
        if handoff['head']['headSeq']!=max(stored):raise ValueError('snapshot not at accepted inspect')
        action_id=handoff['continuationOf']['actionId']
        own_reads=[(s,e) for s,e in stored.items() if e['type']=='observation.upsert'
          and isinstance(e['data']['value']['content'],dict)
          and e['data']['value']['content'].get('capabilityId')=='experiment:inspect-notice-board']
        if len(own_reads)!=2:raise ValueError('seed does not have exactly two actual reads')
        for seq,event in own_reads:
            value=event['data']['value'];txn=[e for e in stored.values() if e['transactionId']==event['transactionId']]
            if not any(e['type']=='action.resolved' and e['data']['actionId']==value['actionId'] and e['data']['accepted'] for e in txn):
                raise ValueError('reading not atomically accepted')
            if not any(e['type']=='world.tick-advanced' for e in txn):raise ValueError('reading tick not atomic')
        second=next(e for _,e in own_reads if e['data']['value']['actionId']==action_id)
        if any(s>handoff['continuationOf']['afterSeq'] and e['type']=='character.speak' for s,e in stored.items()):
            raise ValueError('seed already replied after second inspect')
        if not any(c['response'].get('decision')=='perform' and c['response'].get('parameters',{}).get('bindingId')=='binding:entity:distant-board:inspect' for c in calls):
            raise ValueError('second action not autonomously selected')
        archive,old,new_ids,formed,tick=conflict.build_archive(seeds,seed)
        if archive!=load(updates/('archive-'+str(seed)+'.json')):raise ValueError('authorized export changed')
        row=load(updates/('update-'+str(seed)+'.json'));record=row['record']
        native=json.loads(traces[seed]['responseText'].strip().removeprefix('```json').removesuffix('```').strip())
        if native!=record['rawAnswer']:raise ValueError('utility answer mutated')
        check=lineage.update(archive,old,new_ids,record['familyId'],formed,formed,tick,lambda *_:native)
        for k in ('current','versions','relation','reason','generationInput','lastRevisedTick'):
            if check[k]!=record[k]:raise ValueError('update does not reproduce')
        if record['versions'][0]!=old:raise ValueError('old cognition overwritten')
        if load(updates/('no-new-'+str(seed)+'.json'))['modelCalled']:raise ValueError('update without evidence')
        relations[record['relation']]+=1
        revisions.append({'seed':seed,'currentCount':len(record['current']),'knownTicks':[s['knownTick'] for s in archive['sources']],
          'firstFormedTick':record['firstFormedTick'],'lastRevisedTick':record['lastRevisedTick'],
          'texts':[o['text'] for o in record['current']],'updateLatencyMs':record['latencyMs']})
        initial_speech.append(calls[1]['response'].get('speech',''))
    seed_usage=usage.copy();seed_models=models.copy();seed_call_count=len(latencies)
    trials=load(choices/'trials.json')
    expected={(s,n,c) for s in range(3) for n in range(2) for c in cp['conditions']}
    if {(t['seed'],t['sample'],t['condition']) for t in trials}!=expected:raise ValueError('trial matrix incomplete')
    for trial in trials:
        seed,sample,condition=trial['seed'],trial['sample'],trial['condition']
        directory=choices/('seed-'+str(seed)+'-sample-'+str(sample)+'-'+condition)
        stored,calls=check_directory(directory,[('continuation',1)],seed_events[seed])
        if trial['calls']!=1:raise ValueError('continuation call budget differs')
        call=calls[0];request=call['request'];handoff=load(seeds/('repeat-'+str(seed))/'handoff.json')
        continuation=handoff['continuationOf'];record=load(updates/('update-'+str(seed)+'.json'))['record']
        archive=load(updates/('archive-'+str(seed)+'.json'))
        if (not request['continuation'] or request['canPerform'] or request['canRecall']
          or request['result']['status']!='accepted'
          or request['result']['evidence']['actionId']!=continuation['actionId']
          or request['context']['stimulus']!=handoff['stimulus']
          or request['result']['action']!=continuation['action']):
            raise ValueError('changed execution/continuation/stimulus contract')
        if call['head']!=handoff['head']:raise ValueError('wrong pre-reply head')
        if any(s>max(seed_events[seed]) and e['type']=='observation.upsert'
          and e['data']['value'].get('epistemicKind')=='direct_observation' for s,e in stored.items()):
            raise ValueError('comparison replayed the inspect')
        units=archive['observations'] if condition=='baseline' else record['current'] if condition=='updated' else archive['facts']
        if condition in ('plain-evidence','paired-evidence'):
            expected_projection=plain_readings(archive,call['head']['tick'],condition=='paired-evidence')
            if request['context']['memories']!=expected_projection:
                raise ValueError('deterministic natural-language projection differs')
        elif [(m['text'],m['sourceRefs']) for m in request['context']['memories']]!=[(u['text'],u['sourceRefs']) for u in units]:
            raise ValueError('delivered cognition/evidence mismatch')
        if not request['context']['observations']:raise ValueError('recent observation channels unexpectedly omitted')
        plain={**request,'context':{**request['context'],'memories':[]}}
        if seed in first_context and first_context[seed]!=plain:raise ValueError('nonmemory context differs')
        first_context[seed]=plain
        group=groups.setdefault(condition,{'trials':0,'readingItemCounts':[],'responses':[]})
        group['trials']+=1;group['readingItemCounts'].append(len(request['context']['memories']))
        group['responses'].append({'seed':seed,'sample':sample,'status':trial['result']['status'],'response':call['response'],
          'artifact':str(directory/'continuation-call-0.json')})
    utility_usage=collections.Counter()
    for trace in traces:
        for k,v in trace.get('usage',{}).items():
            if isinstance(v,(int,float)):utility_usage[k]+=v
    return {'structuralAuditPassed':True,'seedCalls':9,'continuationCalls':len(trials),'updateCalls':len(traces),
      'totalCalls':len(latencies)+len(traces),'nativeCharacterModels':dict(models),'newActualReadOperations':6,
      'comparisonReadOperations':0,'auditedSourceRows':source_rows,'updateRelations':dict(relations),'revisions':revisions,
      'originalUnchanged':True,'nonmemoryContinuationIdenticalWithinSeed':True,'initialSpeech':initial_speech,'groups':groups,
      'characterUsage':dict(usage),'utilityUsage':dict(utility_usage),'medianCharacterLatencyMs':statistics.median(latencies),
      'medianUpdateLatencyMs':statistics.median(r['updateLatencyMs'] for r in revisions),
      'newJevCalls':0,'semanticPassNotImplied':True,
      **({'newCalls':len(trials),'newUpdateCalls':0,'newReadOperations':0,
          'reusedSeedCalls':seed_call_count,'reusedUpdateCalls':len(traces),
          'newCharacterUsage':dict(usage-seed_usage),'newCharacterModels':dict(models-seed_models),
          'newMedianCharacterLatencyMs':statistics.median(latencies[seed_call_count:])}
        if cp.get('mode')=='--delivery' else {})}
if __name__=='__main__':
    result=audit(*sys.argv[1:4])
    lineage.save(Path(sys.argv[3])/'audit.json',result)
    print(json.dumps(result,ensure_ascii=True))
