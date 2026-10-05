"""Stage 6.1 audit: reuse host commit checks, then replay candidate and Delivery rules without provider calls."""
import copy, json, sys
from pathlib import Path
from audit_simplification import audit as audit_host, load
import candidate_admission
import notice_board_action_loop as loop


def audit(root):
    root=Path(root); protocol=load(root/'protocol.json')
    result=audit_host(root); stages=[]
    old_protocol=load(Path(protocol['originalProtocolPath']))
    for seed in protocol['seeds']:
        original=load(root/seed/'original.json'); simple=load(root/seed/'simple-id.json')
        assert original['query']==simple['query'], 'query changed between arms'
        assert original['retrieval']['rawScores']==simple['retrieval']['rawScores'], 'score diagnostics changed'
        for arm,recall in [('original',original),('simple-id',simple)]:
            doc=load(root/seed/(arm+'-input.json')); request=load(root/seed/'request.json'); snapshot=load(root/seed/'snapshot.json')
            assert doc['request']==request and doc['scope']==snapshot['scope'] and doc['authorizedHistory']==snapshot['sources']
            archive=loop.archive_for_recall(doc); by_id,sources=loop.bridge.projections.archive(archive)
            targets={o['id']:o for o in archive['observations']}
            assert archive['observations']==doc['revision']['archive']['observations'], 'cognition body changed'
            assert len(sources)==len(snapshot['sources']), 'authorized history silently excluded'
            aliases=[{'scope':archive['scope'],'worldSeq':archive['scope']['asOfWorldSeq'],'people':request['context']['scene']['people']}]
            projection=loop.bridge.projections.retrieval_projection(archive,alias_history=aliases)
            projected=loop.bridge.activity.index_metadata(projection,archive)
            index={'scope':archive['scope'],'units':sum([projected[k] for k in ('facts','episodes','observations')],[])}
            if arm=='simple-id':
                rows,trace=candidate_admission.admit(archive,index,original['retrieval'],request,copy.deepcopy(recall['query']))
                assert rows==recall['retrieval']['results'] and trace==recall['admission'], 'candidate trace not reproducible'
            ids=[r['id'] for r in recall['retrieval']['results'] if r['id'] in targets][:7]
            assert ids==recall['sentIds'] and set(recall['decision']['answers'])==set(ids), 'JEV scope mismatch'
            for answer in recall['decision']['answers'].values(): loop.jev.validate_decision(answer)
            if ids:
                logs=[json.loads(s) for s in (root/(seed+'-'+arm+'-jev.jsonl')).read_text(encoding='utf-8').splitlines()]
                assert len(logs)==1 and logs[0]['status']=='returned'
                state=logs[0]['request']['state']
                assert set(state['candidates'])==set(ids)
                assert all(state['candidates'][i]['understanding']==targets[i]['text'] for i in ids)
                assert state['stimulus']['text']==recall['query']['originalText']
            related=[i for i in ids if recall['decision']['answers'][i]['related']]
            assert related==recall['relatedIds']
            candidates=[r for r in recall['retrieval']['results'] if r['id'] not in targets or r['id'] in related]
            candidates=loop.delivery_order.order(candidates,recall['decision'])
            delivery=loop.bridge.activity.deliver(archive,candidates,request,doc['tick'],copy.deepcopy(recall['query']),max_items=3,max_json_chars=4500)
            assert delivery==recall['delivery'], 'Delivery differs from unchanged deterministic replay'
            covered={i for tr in delivery['trace']['delivered'] for i in tr['coveredAtomIds']}
            recent={o['sourceSeq'] for o in request['context']['observations']+request['context']['selfObservations']}
            delivered_ids={m['memoryId'] for m in delivery['memories']}
            for tr in delivery['trace']['delivered']:
                for ref in tr['sourceRefs']:
                    assert ref=={k:sources[ref['sourceId']][k] for k in ref}, 'Source identity differs'
                owner=tr['memoryId'] if by_id[tr['memoryId']]['memoryLevel']=='observation' else tr.get('fallbackObservationId')
                if owner:
                    assert all(i in covered or by_id[i]['sourceRefs'][0]['worldSeq'] in recent for i in targets[owner]['contradictingAtomIds']), 'lost necessary counter'
            evidence_sources={s['sourceId'] for s in doc['revision']['archive']['sources']}
            other_sources=set(sources)-evidence_sources
            gaps=old_protocol['gaps']
            gap_starts=[s['worldSeq'] for s in snapshot['sources'] if isinstance(s.get('content'),dict)
                        and s['content'].get('speech',{}).get('text') in gaps]
            assert len(gap_starts)==8, 'missing actual unrelated interaction stimuli'
            future_seq=next(s['worldSeq'] for s in snapshot['sources'] if isinstance(s.get('content'),dict)
                            and s['content'].get('speech',{}).get('text')==old_protocol['future'])
            gap_sources={s['sourceId'] for s in snapshot['sources'] if min(gap_starts)<=s['worldSeq']<future_seq}
            assert len(gap_sources)==16, 'expected eight player/NPC exchanges'
            pool_ids={r['id'] for r in recall['retrieval']['results']}
            stages.append({'seed':seed,'arm':arm,'sourceCount':len(sources),'otherHistorySourceCount':len(other_sources),'unrelatedInteractionSourceCount':len(gap_sources),
                'candidateCount':len(pool_ids),'otherHistoryCandidateCount':sum(not {r['sourceId'] for r in by_id[i]['sourceRefs']} <= evidence_sources for i in pool_ids),
                'otherHistoryDeliveredSourceIds':sorted({r['sourceId'] for tr in delivery['trace']['delivered'] for r in tr['sourceRefs']} & other_sources),
                'unrelatedInteractionCandidateIds':sorted(i for i in pool_ids if {r['sourceId'] for r in by_id[i]['sourceRefs']} & gap_sources),
                'unrelatedInteractionDeliveredSourceIds':sorted({r['sourceId'] for tr in delivery['trace']['delivered'] for r in tr['sourceRefs']} & gap_sources),
                'materialIds':[m['memoryId'] for m in delivery['memories']],
                'targets':[{'memoryId':i,'candidate':i in pool_ids,'candidateRank':next((r['rank'] for r in recall['retrieval']['results'] if r['id']==i),None),
                    'jev':recall['decision']['answers'].get(i,{}).get('choice','not sent'),
                    'bodyDelivered':i in delivered_ids,'fallbackDelivered':any(tr.get('fallbackObservationId')==i for tr in delivery['trace']['delivered']),
                    'supportCovered':[a for a in o['supportingAtomIds'] if a in covered],
                    'counterCovered':[a for a in o['contradictingAtomIds'] if a in covered],
                    'omitted':[tr['reason'] for tr in delivery['trace']['omitted'] if tr['memoryId']==i]} for i,o in targets.items()],
                'jevLatencyMs':recall['decision']['latencyMs'],'jevUsage':recall['decision']['usage'],
                'preparation':load(root/seed/(arm+'-timing.json'))})
    result.update({'phase':'6.1','candidateAndDeliveryReplayVerified':True,'sameQueryAndScoresVerified':True,
                   'cognitionBodiesUnchanged':True,'completeAuthorizedHistoryIndexed':True,'necessaryCountersVerified':True,'stages':stages})
    result['jevByArm']={arm:{'preparedCalls':sum(bool(s['jevLatencyMs']) for s in stages if s['arm']==arm),
        'latencyMs':sum(s['jevLatencyMs'] for s in stages if s['arm']==arm),
        'usage':{k:sum(s['jevUsage'].get(k,0) for s in stages if s['arm']==arm) for k in ('input_tokens','output_tokens','cost')}} for arm in protocol['paths']}
    result['limits']=['Character activation timing excludes offline preparation; preparation and JEV timings recorded separately',
        'Character samples reuse one frozen JEV preparation per case/arm; JEV repeat stability not tested',
        'negative controls retain the previous registration question in recent context; topic intrusion is not uniquely caused by recall',
        'provider token counts and JEV cost fields are preserved as returned; Character price and full cost not verified',
        'no cognition body delivered in positive cases; action differences cannot establish cognition benefit',
        'read-only audit verifies program boundaries, not natural-language semantic correctness']
    result['byTopic']={topic:{arm:{'trials':len(rows),'acquisitions':sum(bool(r['acquiredSourceIds']) for r in rows),
        'calls':sum(r['calls'] for r in rows),'usage':{k:sum(r['usage'][k] for r in rows) for k in result['usage']}}
        for arm in protocol['paths'] for rows in [[r for r in result['rows'] if r['path']==arm and r['seed'].endswith('--'+topic)]]} for topic in protocol['cases']}
    return result

if __name__=='__main__':
    result=audit(sys.argv[1]); (Path(sys.argv[1])/'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k not in ('rows','stages')},ensure_ascii=False))
