"""Validate and summarize a continuous run without claiming inferred behavioral causality."""
import argparse,json,hashlib,sqlite3,math
from collections import Counter
from pathlib import Path
import sys
sys.stdout.reconfigure(encoding="utf-8")
p=argparse.ArgumentParser();p.add_argument('root',type=Path);p.add_argument('--output',type=Path);args=p.parse_args();root=args.root
progress=json.loads((root/'progress.json').read_text(encoding='utf-8'))
rounds=progress['rounds'];ids=[ident for r in rounds for ident in r['traceIds']]
assert len(ids)==len(set(ids))
counts=Counter();events=Counter();actions=Counter();calls_by_actor=Counter();paths=Counter()
snapshots={};interesting=[];windows={}
refs={'sourceId','sourceHash','epistemicKind','worldSeq','characterId','worldAddress'}
with sqlite3.connect((root/'base/memory.sqlite').resolve().as_uri()+'?mode=ro',uri=True) as db:
    source_rows={(r[0],r[1]):r[2:] for r in db.execute('SELECT namespace_key,source_id,source_hash,source_seq,epistemic_kind,text_value FROM cognitive_memory_v2_sources')}
with sqlite3.connect((root/'base/world.sqlite').resolve().as_uri()+'?mode=ro',uri=True) as db:
    tick_rows={(r[0],r[1]):r[2] for r in db.execute('SELECT address_key,seq,tick FROM events')}
def verify_snapshot(snapshot):
    scope=snapshot['scope'];address=scope['worldAddress']
    address_key='\x1f'.join(address[k] for k in ('tenantId','worldId','branchId'))
    namespace=address_key+'\x1f'+scope['characterId']
    for source in snapshot['sources']:
        assert source['worldAddress']==address and source['characterId']==scope['characterId']
        assert source['worldSeq']<=scope['asOfWorldSeq']
        assert (source['sourceHash'],source['worldSeq'],source['epistemicKind'],source['text'])==source_rows[(namespace,source['sourceId'])]
        assert source['knownTick']==tick_rows[(address_key,source['worldSeq'])]

for ident in ids:
    trace=json.loads((root/'traces'/(ident+'.json')).read_text(encoding='utf-8'))
    if trace['status']!='model_returned':
        assert trace['modelResponse'] is None and trace['roundOutcome']['error'],ident+' unexplained missing response'
        assert trace['roundOutcome']['activationCycle']['terminalReason'] in {'interrupted','failed'}
        counts['calls_without_model_response']+=1
    assert trace['indexedThroughSeq']<=trace['headSeq']
    if trace['snapshot'] not in snapshots:
        snapshots[trace['snapshot']]=json.loads((root/trace['snapshot']).read_text(encoding='utf-8'))
        verify_snapshot(snapshots[trace['snapshot']])
    snapshot=snapshots[trace['snapshot']]
    sources={s['sourceId']:s for s in snapshot['sources']}
    delivered=trace['deliveredRequest']
    assert json.loads(trace['modelCall']['messages'][1]['content'])==delivered
    if 'projection' in trace:
        delivery=trace['projection']['delivery']
        memories=delivered['context']['memories']
        assert len(memories)<=delivery['budget']['maxItems']==3
        assert len(memories)==len(delivery['delivered'])
        for memory,item in zip(memories,delivery['delivered'],strict=True):
            assert memory['memoryId']==item['memoryId']
            source_refs=item['sourceRefs']
            assert source_refs and memory['sourceIds']==[r['sourceId'] for r in source_refs]
            for ref in source_refs:
                source=sources[ref['sourceId']]
                assert set(ref)==refs and all(ref[k]==source[k] for k in refs)
                assert ref['characterId']==trace['actorId'] and ref['worldSeq']<=trace['headSeq']
                assert source['knownTick']<=trace['tick']
            assert memory['sourceAgeTicks']==trace['tick']-max(sources[r['sourceId']]['knownTick'] for r in source_refs)
            counts['delivered_'+memory['memoryLevel']]+=1
        for unit in trace['selected']:
            counts['selected_'+unit['kind']]+=1
            paths.update(set(route['kind'] for route in unit['routes']))
            assert unit['sources']==[sources[ref['sourceId']] for ref in unit['sourceRefs']]
            for ref in unit['sourceRefs']:
                assert set(ref)==refs and all(ref[k]==sources[ref['sourceId']][k] for k in refs)
                assert ref['characterId']==trace['actorId']
        assert trace['hasObservation']==any(m['memoryLevel']=='observation' for m in memories)
    else:
        assert len(delivered['context']['memories'])==len(trace['selected'])
        for unit,memory in zip(trace['selected'],delivered['context']['memories'],strict=True):
            assert memory['memoryId']==unit['id'] and memory['text']==unit['text']
            assert memory['sourceRefs']==unit['sourceRefs']
            assert unit['sources']==[sources[ref['sourceId']] for ref in unit['sourceRefs']]
            assert memory['sourceAges']==[{'sourceId':ref['sourceId'],'knownTick':sources[ref['sourceId']]['knownTick'],'sourceAgeTicks':trace['tick']-sources[ref['sourceId']]['knownTick']} for ref in unit['sourceRefs']]
            assert memory['sourceMaxSeq']==max(r['worldSeq'] for r in unit['sourceRefs'])
            assert memory['sourceAgeTicks']==trace['tick']-max(sources[r['sourceId']]['knownTick'] for r in unit['sourceRefs'])
            assert math.isclose(unit['score'],sum(unit['rrfContributions'].values()),abs_tol=1e-12)
            for arm,rank in unit['sourceRanks'].items():
                assert trace['retrieval']['armResults'][arm.removesuffix('_rank')][rank-1]['id']==unit['id']
            assert unit['sourceRefs']
            for ref in unit['sourceRefs']:
                source=sources[ref['sourceId']]
                assert set(ref)==refs and all(ref[k]==source[k] for k in refs)
                assert ref['characterId']==trace['actorId'] and ref['worldSeq']<=trace['headSeq']
                assert source['knownTick']<=trace['tick']
            counts['selected_'+unit['kind']]+=1
            paths.update(set(route['kind'] for route in unit['routes']))
    counts['calls']+=1;counts['calls_with_observation']+=trace['hasObservation'];counts['calls_with_memory']+=bool(delivered['context']['memories'])
    bucket=(trace['playerTurn']-1)//20
    window=windows.setdefault(bucket,{'fromTurn':bucket*20+1,'throughTurn':min((bucket+1)*20,len(rounds)),
        'calls':0,'nonemptyDeliveries':0,'roundsWithMemory':set(),'observationCandidates':0,
        'suppressedObservations':0,'callsWithSuppressedObservation':0,'deliveredObservations':0,'fallbackObservations':0,
        'punctuationOnlyQueries':0,'punctuationNonemptyDeliveries':0,'contentQueries':0,'contentNonemptyDeliveries':0})
    query_projection=trace.get('projection',{}).get('retrieval',{}).get('queryProjection',trace.get('retrieval',{}).get('queryProjection',{}))
    raw_query=query_projection.get('originalText',query_projection.get('semanticQuery',trace.get('retrieval',{}).get('query','')))
    punct=bool(raw_query.strip()) and not any(c.isalnum() for c in raw_query)
    prefix='punctuation' if punct else 'content'
    window['punctuationOnlyQueries' if punct else 'contentQueries']+=1
    window[prefix+'NonemptyDeliveries']+=bool(delivered['context']['memories'])
    counts['punctuation_only_queries']+=punct
    counts['punctuation_nonempty_deliveries']+=punct and bool(delivered['context']['memories'])
    window['calls']+=1
    window['nonemptyDeliveries']+=bool(delivered['context']['memories'])
    if delivered['context']['memories']:window['roundsWithMemory'].add(trace['playerTurn'])
    window['deliveredObservations']+=sum(m.get('memoryLevel')=='observation' for m in delivered['context']['memories'])
    if 'projection' in trace:
        suppressed={o['memoryId'] for o in trace['projection']['delivery']['omitted']
                    if o['reason'].startswith('unverified observation summary suppressed')}
        window['observationCandidates']+=sum(u['kind']=='observation' for u in trace['selected'])
        window['suppressedObservations']+=len(suppressed)
        window['callsWithSuppressedObservation']+=bool(suppressed)
        window['fallbackObservations']+=len({m['fallbackObservationId'] for m in trace['projection']['delivery']['delivered'] if 'fallbackObservationId' in m})
    calls_by_actor[trace['actorId']]+=1
    raw=trace['modelResponse'];decision=raw.get('decision','invalid') if isinstance(raw,dict) else ('no_response' if trace['status']!='model_returned' else 'invalid')
    counts['decision_'+decision]+=1
    if decision=='perform':
        counts['perform_proposals']+=1
        interesting.append({'id':ident,'tick':trace['tick'],'response':raw,'hasObservation':trace['hasObservation']})
    if trace['hasObservation'] and decision=='publish':
        interesting.append({'id':ident,'tick':trace['tick'],'response':raw,'hasObservation':True})
for r in rounds:
    counts['player_'+r['intent']['kind']]+=1
    counts['player_private']+=r['intent'].get('scope')=='private'
    counts['round_errors']+=r['error']
    counts['rounds_without_character_call']+=not r['traceIds']
    for e in r['events']:
        events[e['eventType']]+=1
        if e['eventType']=='action.resolved':
            actions[(str(e['data'].get('actorId')),str(e['data'].get('actionType')),str(e['data'].get('accepted')))]+=1
topology=[json.loads(l) for l in (root/'room-scenes.jsonl').read_text(encoding='utf-8').splitlines()] if (root/'room-scenes.jsonl').exists() else []
counts['host_scene_creation_rounds']=len(topology)
for window in windows.values():
    window['roundsWithMemory']=len(window['roundsWithMemory'])
    window['contentNonemptyRate']=window['contentNonemptyDeliveries']/window['contentQueries'] if window['contentQueries'] else None
    window['nonemptyRate']=window['nonemptyDeliveries']/window['calls'] if window['calls'] else 0
report={'windows':list(windows.values()),'root':str(root.resolve()),'completedPlayerTurns':len(rounds),'lastTick':rounds[-1]['afterTick'] if rounds else 0,
 'counts':dict(counts),'callsByActor':dict(calls_by_actor),'retrievalRouteKinds':dict(paths),'worldEvents':dict(events),
 'actionResolutions':[{'actor':a,'action':b,'accepted':c,'count':n} for (a,b,c),n in actions.items()],
 'traceValidation':'source snapshots matched read-only cognitive namespace and world tick databases; six-field provenance, actor/world prefixes, source ages and model input checked; projected delivery budget checked; legacy-only RRF ranks checked',
 'artifactHashes':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ['protocol.json','progress.json','rounds.jsonl']},
 'interestingCalls':interesting,'limits':['one continuing trajectory, shadow recall baselines only','route does not establish final decision causality','promises/misunderstandings require manual reading, not keyword labels']}
(args.output or root/'trace-summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k not in ['interestingCalls','artifactHashes']},ensure_ascii=False))
