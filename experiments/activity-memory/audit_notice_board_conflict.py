"""Read-only provenance/transaction/native-answer audit; semantic judgments remain manual."""
import collections
import json
import statistics
import sys
from pathlib import Path
import cognition_lineage as lineage
import notice_board_conflict as conflict
from audit_notice_board_revision import dbread, events, check_frozen, load

def audit(play_root,update_root,follow_root):
    play=Path(play_root).resolve();update=Path(update_root).resolve();follow=Path(follow_root).resolve()
    up=load(update/'protocol.json');fp=load(follow/'protocol.json')
    check_frozen(up);check_frozen(fp)
    trace=[json.loads(s) for s in (update/'utility-calls.jsonl').read_text(encoding='utf-8').splitlines()]
    if len(trace)!=3:raise ValueError('update call budget differs')
    relations=collections.Counter();update_texts=[]
    for repeat in range(3):
        archive,old,new_ids,formed,tick=conflict.build_archive(play,repeat)
        if archive!=load(update/('archive-'+str(repeat)+'.json')):raise ValueError('authorized export changed')
        row=load(update/('update-'+str(repeat)+'.json'))
        if row['status']!='accepted':raise ValueError('not all updates accepted')
        record=row['record']
        native=json.loads(trace[repeat]['responseText'].strip().removeprefix('```json').removesuffix('```').strip())
        # Existing utility transport may return fenced JSON; match its existing parser.
        if native!=record['rawAnswer']:raise ValueError('native update mutated')
        check=lineage.update(archive,old,new_ids,record['familyId'],formed,formed,tick,lambda *_:native)
        for k in ('relation','reason','current','versions','generationInput','revisionSourceIds','versionMetadata'):
            if check[k]!=record[k]:raise ValueError('update not reproducible')
        if lineage.select(record,'historical')[0]!=old:raise ValueError('old version lost')
        if load(update/('no-new-'+str(repeat)+'.json'))['modelCalled']:raise ValueError('rewrite without evidence')
        lineage.bridge.episode.validate_units({**archive,'observations':archive['observations']+record['current']})
        relations[record['relation']]+=1
        update_texts.append({'repeat':repeat,'relation':record['relation'],'currentCount':len(record['current']),
          'historicalCount':len(record['versions']),'texts':[o['text'] for o in record['current']],
          'evidenceTicks':[s['knownTick'] for s in archive['sources']],
          'firstFormedTick':record['firstFormedTick'],'lastRevisedTick':record['lastRevisedTick']})
    models=collections.Counter();usage=collections.Counter();latencies=[];source_rows=0;all_reads=0
    stage_groups={};first_context={};audited_dirs=[]
    def directory_audit(directory,tags,base=None):
        nonlocal source_rows,all_reads
        db=dbread(directory/'world.sqlite')
        try:stored=events(db)
        finally:db.close()
        if stored!=events_json(directory/'events.json'):raise ValueError('events export differs from database')
        if base and {seq:stored[seq] for seq in base}!=base:raise ValueError('copied history changed')
        db=dbread(directory/'memory.sqlite')
        try:rows=db.execute('SELECT namespace_key,source_id,source_seq,source_hash,epistemic_kind,text_value FROM cognitive_memory_v2_sources').fetchall()
        finally:db.close()
        for ns,sid,seq,digest,kind,text in rows:
            e=stored[seq];owner=ns.split(chr(31))[-1]
            if sid!='event:'+str(seq) or digest!=e['hash'] or e['data']['value']['observerId']!=owner:
                raise ValueError('Source provenance mismatch')
            content=e['data']['value']['content']
            if isinstance(content,dict) and 'speech' in content and kind!='reported_speech':
                raise ValueError('dialogue became verified action evidence')
            if owner!='character:bob' and '青杉' in text:raise ValueError('private Source leaked')
            source_rows+=1
        actual=[(seq,e) for seq,e in stored.items() if e['type']=='observation.upsert'
          and isinstance(e['data']['value']['content'],dict)
          and e['data']['value']['content'].get('capabilityId')=='experiment:inspect-notice-board'
          and (not base or seq>max(base))]
        all_reads+=len(actual)
        calls=[]
        for tag in tags:
            result=load(directory/(tag+'-result.json'))
            these=[load(directory/(tag+'-call-'+str(i)+'.json')) for i in range(result['calls'])]
            for i,call in enumerate(these):
                native=load(directory/(tag+'-transport-'+str(i)+'.json'))
                body=json.loads(native['body']);message=body['choices'][0]['message']
                if native['status']!=200:raise ValueError('gateway failure')
                if 'tool_calls' in message:
                    if len(message['tool_calls'])!=1:raise ValueError('multiple native calls')
                    answer=json.loads(message['tool_calls'][0]['function']['arguments'])
                else:answer=json.loads(message['content'])
                if answer!=call['response']:raise ValueError('native response modified')
                models[body.get('model')]+=1
                for k,v in body.get('usage',{}).items():
                    if isinstance(v,(int,float)):usage[k]+=v
                latencies.append(call['durationMs'])
                request=call['request']
                if '青杉' in json.dumps(request,ensure_ascii=False):raise ValueError('private context leak')
                seq=call['head']['headSeq']
                for target,text in [('entity:hall-board','登记处：二楼203'),('entity:distant-board','登记处：一楼105')]:
                    read_before=any(s<=seq and e['type']=='observation.upsert'
                      and isinstance(e['data']['value']['content'],dict)
                      and e['data']['value']['content'].get('targetId')==target
                      and e['data']['value'].get('epistemicKind')=='direct_observation'
                      for s,e in stored.items())
                    if not read_before and text in json.dumps(request,ensure_ascii=False):
                        raise ValueError('inscription exposed before commit')
                if answer['decision']=='publish':
                    if not any(s>seq and e['type']=='character.speak' and e['data']['characterId']=='character:npc'
                      and e['data']['text']==answer.get('speech','') for s,e in stored.items()):
                        raise ValueError('publish missing committed speech')
                calls.append(call)
            stage_groups[str(directory.name)+':'+tag]=[c['response'] for c in these]
        for seq,e in actual:
            v=e['data']['value'];c=v['content']
            own=[row for row in rows if row[2]==seq]
            if len(own)!=1 or own[0][0].split(chr(31))[-1]!='character:npc' or own[0][4]!='direct_observation':
                raise ValueError('direct reading not actor-only')
            expected='登记处：二楼203' if c['targetId']=='entity:hall-board' else '登记处：一楼105'
            if c['observedText']!=expected:raise ValueError('unexpected reading')
            txn=[x for x in stored.values() if x['transactionId']==e['transactionId']]
            if not any(x['type']=='action.resolved' and x['data']['actionId']==v['actionId'] and x['data']['accepted'] for x in txn):
                raise ValueError('no atomic accepted resolution')
            if not any(x['type']=='world.tick-advanced' for x in txn):raise ValueError('tick not atomic')
            if not any(call['head']['headSeq']>=seq and call['request'].get('continuation')
              and call['request'].get('result',{}).get('evidence',{}).get('actionId')==v['actionId'] for call in calls):
                raise ValueError('no postcommit result-aware continuation')
        audited_dirs.append(str(directory))
        return stored,calls
    play_sources={};play_calls=0
    for repeat in range(3):
        stored,calls=directory_audit(play/('repeat-'+str(repeat)),['first','second'])
        play_sources[repeat]=stored;play_calls+=len(calls)
    trials=load(follow/'trials.json')
    expected={(r,p['id'],c) for r in range(3) for p in fp['probes'] for c in fp['conditions']}
    if {(t['repeat'],t['probe'],t['condition']) for t in trials}!=expected:raise ValueError('incomplete trial matrix')
    groups={}
    for trial in trials:
        repeat=trial['repeat'];directory=follow/(trial['probe']+'-'+str(repeat)+'-'+trial['condition'])
        _,calls=directory_audit(directory,[trial['tag']],play_sources[repeat])
        record=load(update/('update-'+str(repeat)+'.json'))['record']
        archive=load(update/('archive-'+str(repeat)+'.json'))
        units=record['current'] if trial['condition']=='updated' else archive['facts']
        projected=calls[0]['request']['context']['memories']
        if [(m['text'],m['sourceRefs']) for m in projected]!=[(u['text'],u['sourceRefs']) for u in units]:
            raise ValueError('delivery body/evidence changed')
        for call in calls:
            if call['request']['context']['observations'] or call['request']['context']['selfObservations']:
                raise ValueError('uncontrolled recent reading')
        plain={**calls[0]['request'],'context':{**calls[0]['request']['context'],'memories':[]}}
        key=(repeat,trial['probe'])
        if key in first_context and first_context[key]!=plain:raise ValueError('nonmemory context differs')
        first_context[key]=plain
        key=trial['probe']+':'+trial['condition']
        group=groups.setdefault(key,{'activations':0,'calls':0,'responses':[],'deliveryItemCounts':[]})
        group['activations']+=1;group['calls']+=len(calls);group['responses'].append(calls[-1]['response'])
        group['deliveryItemCounts'].append(len(projected))
    return {'structuralAuditPassed':True,'updateCalls':len(trace),'updateRelations':dict(relations),
      'updateRows':update_texts,'playActivations':6,'playCalls':play_calls,'followActivations':len(trials),
      'followCalls':len(latencies)-play_calls,'characterCalls':len(latencies),'totalCalls':len(latencies)+len(trace),
      'newActualReadsIncludingFollow':all_reads,'auditedSourceRows':source_rows,
      'nativeCharacterModels':dict(models),'characterUsage':dict(usage),
      'medianCharacterLatencyMs':statistics.median(latencies),'groups':groups,'playResponses':stage_groups,
      'originalUnchanged':True,'initialNonmemoryIdenticalWithinRepeatProbe':True,'newJevCalls':0,
      'semanticPassNotImplied':True}
def events_json(path):
    return {e['seq']:{'tick':e['tick'],'type':e['eventType'],'data':e['data'],'hash':e['eventHash'],
      'transactionId':e['transactionId']} for e in load(path)}
if __name__=='__main__':
    result=audit(*sys.argv[1:4])
    lineage.save(Path(sys.argv[3])/'audit.json',result)
    print(json.dumps(result,ensure_ascii=True))
