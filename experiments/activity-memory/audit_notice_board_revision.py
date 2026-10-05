"""Audit actual Source -> revision -> delivered Character experiments, no new model calls."""
import collections
import hashlib
import json
import statistics
import sqlite3
import sys
from pathlib import Path
import cognition_lineage as lineage
import notice_board_revision as revision

def load(p):
    return json.loads(Path(p).read_text(encoding='utf-8'))
def check_frozen(protocol):
    for p,h in protocol['frozen'].items():
        if hashlib.sha256(Path(p).read_bytes()).hexdigest()!=h:raise ValueError('original changed')
def dbread(p):
    db=sqlite3.connect(Path(p).resolve().as_uri()+'?mode=ro',uri=True)
    db.execute('PRAGMA query_only=ON')
    if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('database integrity failure')
    return db
def events(db):
    return {seq:{'tick':tick,'type':kind,'data':json.loads(data),'hash':digest,'transactionId':txn}
            for seq,tick,kind,data,digest,txn in db.execute('SELECT seq,tick,event_type,data_json,event_hash,transaction_id FROM events')}

def audit(revision_root,choice_root):
    root=Path(revision_root).resolve();choice=Path(choice_root).resolve()
    protocol=load(root/'protocol.json');experiment=load(choice/'protocol.json')
    check_frozen(protocol);check_frozen(experiment)
    archive=load(root/'authorized-archive.json');lineage.bridge.episode.validate_units(archive)
    rebuilt,tick,cases=revision.build_archive(protocol['inputRoot'])
    if archive!=rebuilt or tick!=protocol['updateTick']:raise ValueError('authorized export mismatch')
    if len(archive['sources'])!=6 or any(s['characterId']!='character:npc' for s in archive['sources']):
        raise ValueError('foreign or missing sources')
    if '青杉' in json.dumps(archive,ensure_ascii=False):raise ValueError('private source leaked')
    traces=[json.loads(s) for s in (root/'utility-calls.jsonl').read_text(encoding='utf-8').splitlines()]
    if len(traces)!=6:raise ValueError('wrong update call count')
    update_rows=[];relations=collections.Counter()
    for r in range(3):
        for case in ('local','global'):
            row=load(root/(case+'-'+str(r)+'.json'))
            if row['status']!='accepted':raise ValueError('structural update rejected')
            record=row['record'];old,new_ids,formed=cases[case]
            if record['generationInput']['oldUnderstanding']!=old:raise ValueError('old object changed')
            if [a['id'] for a in record['generationInput']['newEvidence']]!=new_ids:raise ValueError('new evidence changed')
            trace=traces[r*2+(case=='global')]
            native=json.loads(trace['responseText'].strip().removeprefix('```json').removesuffix('```').strip())
            if native!=record['rawAnswer']:raise ValueError('update answer changed')
            if record['versions'][0]!=old or record['firstFormedTick']!=formed:
                raise ValueError('old history/formation changed')
            lineage.bridge.episode.validate_units({**archive,'observations':archive['observations']+record['current']})
            check=lineage.update(archive,old,new_ids,record['familyId'],formed,formed,tick,
                                 lambda *_:native)
            if any(check[k]!=record[k] for k in ('relation','current','versions','generationInput','versionMetadata',
                                                'lastRevisedTick','revisionSourceIds','hasUnresolvedConflict')):
                raise ValueError('revision cannot be reproduced from native answer')
            relations[case+':'+record['relation']]+=1
            update_rows.append({'case':case,'repeat':r,'currentCount':len(record['current']),
                'historicalCount':len(lineage.select(record,'historical')),
                'lastRevisedTick':record['lastRevisedTick'],'evidenceUpdatedTick':record['evidenceUpdatedTick']})
    for record in load(root/'no-new-evidence.json'):
        if record['modelCalled'] or record['relation']!='no_new_evidence':
            raise ValueError('rewrote without evidence')

    trial_rows=load(choice/'trials.json');summary=load(choice/'summary.json')
    if len(trial_rows)!=12:raise ValueError('incomplete choices')
    source_db=dbread(Path(protocol['inputRoot'])/'repeat-0/world.sqlite')
    try:initial=events(source_db)
    finally:source_db.close()
    models=collections.Counter();usage=collections.Counter();first={};groups={};latencies=[];source_rows=0;added_reads=0
    expected={(p['id'],r,c) for p in experiment['probes'] for r in range(2) for c in experiment['conditions']}
    if {(t['probe'],t['repeat'],t['condition']) for t in trial_rows}!=expected:raise ValueError('trial matrix differs')
    for trial in trial_rows:
        ident=trial['probe']+'-'+str(trial['repeat'])+'-'+trial['condition'];directory=choice/ident
        world=dbread(directory/'world.sqlite')
        try:stored=events(world)
        finally:world.close()
        if {seq:stored[seq] for seq in initial}!=initial:raise ValueError('copied history altered')
        memory=dbread(directory/'memory.sqlite')
        try:rows=memory.execute('SELECT namespace_key,source_id,source_seq,source_hash,epistemic_kind,text_value FROM cognitive_memory_v2_sources').fetchall()
        finally:memory.close()
        for ns,sid,seq,digest,kind,text in rows:
            event=stored[seq];owner=ns.split(chr(31))[-1]
            if sid!='event:'+str(seq) or digest!=event['hash'] or event['data']['value']['observerId']!=owner:
                raise ValueError('Source namespace/hash mismatch')
            content=event['data']['value']['content']
            if isinstance(content,dict) and 'speech' in content and kind!='reported_speech':
                raise ValueError('dialogue upgraded to factual evidence')
            if owner!='character:bob' and '青杉' in text:raise ValueError('private memory leak')
            source_rows+=1
        calls=[load(directory/('call-'+str(i)+'.json')) for i in range(trial['calls'])]
        projected=calls[0]['request']['context']['memories']
        local_update=load(root/('local-'+str(trial['repeat'])+'.json'))['record']['current'][0]
        units= [cases['local'][0]] if trial['condition']=='old-local' else [local_update] if trial['condition']=='updated-local' else [
            a for a in archive['facts'] if a['sourceRefs'][0]['sourceId'] in {'event:20','event:23'}]
        if [(m['text'],m['sourceRefs']) for m in projected]!=[(u['text'],u['sourceRefs']) for u in units]:
            raise ValueError('delivery evidence/body mismatch')
        for call in calls:
            request=call['request']
            if request['context']['observations'] or request['context']['selfObservations']:
                raise ValueError('uncontrolled recent raw reading')
            if '青杉' in json.dumps(request,ensure_ascii=False):raise ValueError('private context leak')
            native=load(directory/('transport-'+str(call['index'])+'.json'))
            payload=json.loads(native['body']);message=payload['choices'][0]['message']
            if native['status']!=200:raise ValueError('provider failure')
            if 'tool_calls' in message:
                if len(message['tool_calls'])!=1:raise ValueError('multiple actions')
                answer=json.loads(message['tool_calls'][0]['function']['arguments'])
            else:answer=json.loads(message['content'])
            if answer!=call['response']:raise ValueError('native choice mutated')
            models[payload.get('model')]+=1
            for k,v in payload.get('usage',{}).items():
                if isinstance(v,(int,float)):usage[k]+=v
            latencies.append(call['durationMs'])
            response=call['response']
            if response['decision']=='publish':
                if not any(e['type']=='character.speak' and e['data']['characterId']=='character:npc'
                           and e['data'].get('text')==response.get('speech','') and seq>call['head']['headSeq']
                           for seq,e in stored.items()):raise ValueError('speech not committed')
        plain={**calls[0]['request'],'context':{**calls[0]['request']['context'],'memories':[]}}
        if trial['probe'] in first and first[trial['probe']]!=plain:raise ValueError('nonmemory mismatch')
        first[trial['probe']]=plain
        rereads=[(seq,e) for seq,e in stored.items() if seq>trial['probeSeq'] and e['type']=='observation.upsert'
                 and isinstance(e['data']['value']['content'],dict)
                 and e['data']['value']['content'].get('capabilityId')=='experiment:inspect-notice-board']
        for seq,event in rereads:
            value=event['data']['value']
            if not any(e['type']=='action.resolved' and e['data']['actionId']==value['actionId'] and e['data']['accepted']
                       and e['transactionId']==event['transactionId'] for e in stored.values()):
                raise ValueError('reread not atomically accepted')
            continuation=[c for c in calls if c['request'].get('continuation')
                and c['request'].get('result',{}).get('evidence',{}).get('actionId')==value['actionId']]
            if not continuation or continuation[0]['head']['headSeq']<seq:raise ValueError('reread feedback precedes commit')
            added_reads+=1
        key=trial['probe']+':'+trial['condition']
        group=groups.setdefault(key,{'activations':0,'calls':0,'rereads':0,'speech':[]})
        group['activations']+=1;group['calls']+=trial['calls'];group['rereads']+=len(rereads)
        group['speech'].append(calls[-1]['response'].get('speech',''))
    if len(latencies)!=summary['calls']:raise ValueError('call totals wrong')
    return {'structuralAuditPassed':True,'updateCalls':len(traces),'updateRelations':dict(relations),
      'updateRows':update_rows,'characterActivations':len(trial_rows),'characterCalls':len(latencies),
      'newActualReads':added_reads,'auditedSourceRows':source_rows,'newJevCalls':0,
      'nativeReturnedModels':dict(models),'characterUsage':dict(usage),
      'medianCharacterLatencyMs':statistics.median(latencies),'groups':groups,
      'originalUnchanged':True,'initialNonmemoryIdentical':True,
      'semanticPassNotImplied':True}
if __name__=='__main__':
    result=audit(sys.argv[1],sys.argv[2])
    Path(sys.argv[2],'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=True))
