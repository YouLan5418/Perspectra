"""Read-only audit of committed actions, private Sources, updates and model responses."""
import hashlib,json,sqlite3,sys
from collections import Counter
from pathlib import Path
def load(p):return json.loads(Path(p).read_text(encoding='utf-8'))
def ro(p):
    d=sqlite3.connect(Path(p).resolve().as_uri()+'?mode=ro',uri=True);d.execute('PRAGMA query_only=ON');return d
def events(p):
    d=ro(p)
    try:
        return {seq:{'seq':seq,'tick':tick,'eventType':kind,'data':json.loads(data),'eventHash':h,'transactionId':t}
            for seq,tick,kind,data,h,t in d.execute('SELECT seq,tick,event_type,data_json,event_hash,transaction_id FROM events')}
    finally:d.close()
def source_rows(p):
    d=ro(p)
    try:return d.execute('SELECT namespace_key,source_id,source_seq,source_hash,epistemic_kind,text_value FROM cognitive_memory_v2_sources').fetchall()
    finally:d.close()
def check_refs(archive,es):
    known={s['sourceId']:s for s in archive['sources']}
    for s in known.values():
        e=es[s['worldSeq']];v=e['data']['value']
        assert s['sourceId']=='event:'+str(e['seq']) and s['sourceHash']==e['eventHash']
        assert v['observerId']==s['characterId']=='character:npc'
        assert s['knownTick']==e['tick'] and s['worldSeq']<=archive['scope']['asOfWorldSeq']
    for field in ('facts','episodes','observations'):
        for u in archive[field]:
            for r in u['sourceRefs']:
                s=known[r['sourceId']]
                assert all(s[k]==r[k] for k in ('sourceId','sourceHash','epistemicKind','worldSeq','characterId','worldAddress'))
def audit(root):
    root=Path(root).resolve();protocol=load(root/'protocol.json');summary=load(root/'summary.json')
    assert summary['completed'] and len(load(root/'trials.json'))==18
    for p,h in protocol['frozen'].items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h
    counts=Counter();models=Counter();usage=Counter();acquisitions=Counter();initial_counts={c:Counter() for c in protocol['conditions']}
    original_bodies={};initial_requests={};future_requests={}
    for seed in range(3):
        es=events(root/f'seed-{seed}/world.sqlite')
        doc=load(root/f'seed-{seed}/initial.json');check_refs(doc['archive'],es)
        source_template=load(Path(next(p for p in protocol['frozen'] if p.endswith(f'update-{seed}.json'))))
        assert [o['text'] for o in doc['record']['current']]==[o['text'] for o in source_template['record']['current']]
        original_bodies[seed]=[o['text'] for o in doc['record']['current']]
    source_count=0
    for dbpath in sorted(root.rglob('world.sqlite')):
        es=events(dbpath);memory=dbpath.with_name('memory.sqlite')
        if not memory.exists():continue
        for ns,sid,seq,h,kind,text in source_rows(memory):
            e=es[seq];v=e['data']['value'];actor=ns.split(chr(31))[-1]
            assert sid=='event:'+str(seq) and h==e['eventHash'] and v['observerId']==actor
            c=v.get('content',{});source_count+=1
            if isinstance(c,dict) and c.get('speech'):
                assert kind=='reported_speech'
            if isinstance(c,dict) and c.get('capabilityId') in ('experiment:inspect-notice-board','experiment:ask_staff','experiment:inspect_terminal'):
                assert actor=='character:npc'
                a=next(x for x in es.values() if x['eventType']=='action.resolved' and x['data']['actionId']==v['actionId'])
                assert a['data']['accepted'] is True and a['data']['actorId']==actor
                assert a['transactionId']==e['transactionId'] and c['sourceActionId']==v['actionId']
                assert kind==('reported_speech' if c['capabilityId']=='experiment:ask_staff' else 'direct_observation')
        for p in dbpath.parent.glob('*-call-*.json'):
            call=load(p);assert call['status']=='returned';counts['characterCalls']+=1
            request=call['request'];encoded=json.dumps(request,ensure_ascii=False)
            assert '仅陆舟可读的内部名单：青杉' not in encoded
            wire=load(p.with_name(p.name.replace('-call-','-transport-')))['body'];body=json.loads(wire)
            models[body.get('model','unknown')]+=1
            for k,v in body.get('usage',{}).items():
                if isinstance(v,int):usage[k]+=v
            msg=body['choices'][0]['message'];native=msg.get('content') or msg['tool_calls'][0]['function']['arguments']
            assert json.loads(native)==call['response']
            if not request['continuation']:assert request['canPerform'] is True
            for m in request['context'].get('memories',[]):
                for r in m.get('sourceRefs',[]):
                    e=es[r['worldSeq']]
                    assert r['sourceId']=='event:'+str(e['seq']) and r['sourceHash']==e['eventHash']
                    assert e['data']['value']['observerId']==r['characterId']=='character:npc'
    for row in load(root/'trials.json'):
        initial_counts[row['condition']][row['actionKind']]+=1
        call=load(root/f"seed-{row['seed']}-sample-{row['sample']}-{row['condition']}/choice-call-0.json")
        request=call['request'];request['context']['memories']=[]
        canonical=json.dumps(request,sort_keys=True)
        if row['seed'] in initial_requests:assert initial_requests[row['seed']]==canonical
        initial_requests[row['seed']]=canonical
        dir=root/f"seed-{row['seed']}-sample-{row['sample']}-{row['condition']}"
        es=events(dir/'world.sqlite')
        prefix=events(root/f"seed-{row['seed']}/world.sqlite")
        assert all(es[i]==e for i,e in prefix.items())
        if row['acquired']:
            acquisitions[row['condition']]+=1
            action=row['result']['performResult'];native=row['nativeResponse']
            assert native['decision']=='perform' and action['status']=='accepted'
            assert native['parameters']==action['action']['parameters'] and native['actionType']==action['action']['actionType']
            effects=[e for e in es.values() if e['eventType']=='observation.upsert'
                and isinstance(e['data']['value'].get('content'),dict)
                and e['data']['value']['content'].get('capabilityId')==row['actionKind']
                and e['data']['value'].get('actionId')==action['operationId']]
            assert len(effects)==1
            if row.get('revisionAccepted'):
                revision=load(dir/'revision.json');check_refs(revision['archive'],es)
                record=revision['record'];counts['revisions']+=1
                new={r['sourceId'] for a in record['generationInput']['newEvidence'] for r in a['sourceRefs']}
                assert new=={'event:'+str(effects[0]['seq'])}==set(record['revisionSourceIds'])
                assert record['generationInput']['oldUnderstanding']['text']==original_bodies[row['seed']][0]
                oldsrc={r['sourceId'] for a in record['generationInput']['oldEvidence'] for r in a['sourceRefs']}
                assert oldsrc=={s['sourceId'] for s in load(root/f"seed-{row['seed']}/initial.json")['archive']['sources']}
    later=[]
    for condition in protocol['conditions']:
        path=root/('later-'+condition)
        if not path.exists():continue
        gap=load(path/'gap-end.json');assert not gap['unexpectedNewEvidence']
        counts['delayInteractions']+=len(list(path.glob('gap-*-result.json')))
        for variant in ('current-cognition','prior-cognition','no-cognition'):
            if not (path/variant/'future-result.json').exists():continue
            r=load(path/variant/'future-result.json');retr=load(path/variant/'retrieval.json')
            assert retr['forcedTarget'] is False and retr['newProjectionModelCalls']==0
            assert set(retr['sentIds'])<=set(retr['targetIds'])
            assert all(retr['decision']['answers'][i]['related'] for i in retr['relatedIds'])
            assert len(retr['delivery']['memories'])<=3
            counts['futureChoices']+=1
            request=load(path/variant/'future-call-0.json')['request']
            assert request['context']['memories']==[]
            canonical=json.dumps(request,sort_keys=True)
            if condition in future_requests:assert future_requests[condition]==canonical
            future_requests[condition]=canonical
            recent={o['sourceSeq'] for key in ('observations','selfObservations') for o in request['context'][key]}
            es=events(path/variant/'world.sqlite')
            capseq={e['seq'] for e in es.values() if e['eventType']=='observation.upsert'
                and isinstance(e['data']['value'].get('content'),dict)
                and e['data']['value']['content'].get('capabilityId')}
            assert not recent & capseq
            update=path/variant/'future-revision.json'
            acquired=r['actionKind'] in ('experiment:ask_staff','experiment:inspect_terminal','experiment:inspect-notice-board')
            if acquired:
                assert update.exists()
                revision=load(update);check_refs(revision['archive'],es);counts['futureRevisions']+=1
                operation=r['result']['performResult']['operationId']
                effect=next(e for e in es.values() if e['eventType']=='observation.upsert'
                    and e['data']['value'].get('actionId')==operation
                    and isinstance(e['data']['value'].get('content'),dict)
                    and e['data']['value']['content'].get('capabilityId')==r['actionKind'])
                assert revision['record']['revisionSourceIds']==['event:'+str(effect['seq'])]
            later.append({'initialCondition':condition,'variant':variant,'action':r['actionKind'],
                'sentIds':retr['sentIds'],'relatedIds':retr['relatedIds'],'deliveredIds':retr['targetDeliveredIds'],
                'deliveryTrace':retr['delivery']['trace']})
    for filename,key in [('utility-calls.jsonl','utilityCalls'),('jev-calls.jsonl','jevCalls')]:
        p=root/filename;counts[key]=len(p.read_text(encoding='utf-8').splitlines()) if p.exists() else 0
    assert counts['characterCalls']==summary['newCharacterCalls']
    return {'structuralAuditPassed':True,'counts':dict(counts),'models':dict(models),'characterUsage':dict(usage),
        'initialActions':{c:dict(v) for c,v in initial_counts.items()},'acquisitions':dict(acquisitions),
        'sourceRowsAudited':source_count,'futureRequestsIdenticalWithinTrajectory':True,'initialNonmemoryRequestsIdentical':True,'oldAcquisitionSourcesAbsentFromRecentContext':True,'future':later,'limits':['structural audit is not semantic truth review',
            'same short scene; repeated histories not independent world samples']}
if __name__=='__main__':
    result=audit(sys.argv[1]);Path(sys.argv[1],'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k not in ('future','limits')},ensure_ascii=True))
