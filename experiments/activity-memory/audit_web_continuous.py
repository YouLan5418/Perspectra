"""Audit normal HTTP Memory integration against committed owner Source rows and frozen bridge results."""
import copy, json, sqlite3, sys
from pathlib import Path
import candidate_admission
import minimal_delivery
bridge=candidate_admission.bridge

def load(path): return json.loads(path.read_text(encoding='utf-8'))
def lines(path): return [json.loads(s) for s in path.read_text(encoding='utf-8').splitlines()] if path.exists() else []
def audit(root):
    summary=load(root/'summary.json');assert summary['completed'], 'continuous playtest did not finish'
    stages=load(root/'stages.json');events=load(root/'events.json')
    calls=lines(root/'bridge.jsonl');recalls=lines(root/'memory-core/recall-trace.jsonl')
    decisions=lines(root/'memory-core/model-trace.jsonl');utility=lines(root/'utility.jsonl')
    assert len(stages)==14 and all(s['status']==200 and not s['state']['error'] for s in stages)
    assert all(a['after']==b['before'] for a,b in zip(stages,stages[1:]))
    for s in stages:
        assert s['state']['debug']['memoryMode']=='core'
        if s['text'] is None: assert s['before']==s['after'], 'refresh changed world head'
    db=sqlite3.connect((root/'memory.sqlite').resolve().as_uri()+'?mode=ro',uri=True)
    db.row_factory=sqlite3.Row
    rows=[dict(r) for r in db.execute('SELECT * FROM cognitive_memory_v2_sources')];db.close()
    by_seq={e['seq']:e for e in events}
    builds=[c for c in calls if c['input']['operation']=='build']
    retrievals=[c for c in calls if c['input']['operation']=='recall']
    assert len(builds)==4
    previous={}
    for c in builds:
        doc,result=c['input'],c['result'];archive=result['archive'];scope=doc['scope'];owner=scope['characterId']
        assert archive['scope']==scope and result['index']['scope']==scope
        assert archive['sources']==doc['sources']
        own=[r for r in rows if r['namespace_key'].endswith('\x1f'+owner) and r['source_seq']<=scope['asOfWorldSeq']]
        assert len(archive['sources'])==len(own)
        for source in archive['sources']:
            row=next(r for r in own if r['source_id']==source['sourceId'])
            assert source['characterId']==owner and source['worldAddress']==scope['worldAddress']
            assert source['sourceHash']==row['source_hash'] and source['text']==row['text_value']
            assert source['worldSeq']==row['source_seq'] and source['epistemicKind']==row['epistemic_kind']
            assert source['knownTick']==by_seq[source['worldSeq']]['tick']<=doc['tick']
        bridge.episode.validate_units(archive)
        if owner in previous:
            old=previous[owner];assert doc['retainedPrefix']==old
            sources={s['sourceId']:s for s in archive['sources']};atoms={a['id']:a for a in archive['facts']}
            assert all(sources[s['sourceId']]==s for s in old['sources'])
            assert all(atoms[a['id']]==a for a in old['facts'])
        previous[owner]=archive
    metrics=[]
    for c in retrievals:
        doc,result=c['input'],c['result'];archive=doc['archive'];assert doc['deliveryMode']=='minimal'
        assert result['jevCalls']==0 and result['gateMode']=='none'
        query=bridge.queries.project(doc['request'],doc['index'].get('retrievalAliases'))
        # Original raw projection can append deterministic activity seeds only to its local copy.
        assert all(result['query'][k]==v for k,v in query.items())
        candidates,admission=candidate_admission.admit(archive,doc['index'],result['baselineRetrieval'],doc['request'],result['query'])
        assert admission==result['admission'] and candidates==result['retrieval']['results']
        observations={o['id']:o for o in archive['observations']}
        selected=[c['id'] for c in candidates if c['id'] in observations]
        replay=minimal_delivery.deliver(archive,candidates,selected,doc['request'],doc['tick'],copy.deepcopy(result['query']))
        assert replay['memories']==result['delivery'] and replay['trace']==result['deliveryTrace']
        bodies=[m for m in result['delivery'] if m['memoryLevel']=='observation']
        for m in bodies:
            o=observations[m['memoryId']]
            assert m['text'].endswith(o['text']) and m['hasUnresolvedCounterEvidence']==bool(o['contradictingAtomIds'])
            assert m['sourceIds']==[r['sourceId'] for r in o['sourceRefs']]
        metrics.append({'actor':archive['scope']['characterId'],'prefix':archive['scope']['asOfWorldSeq'],
            'originalObservationCandidates':sum(c['id'] in observations for c in result['baselineRetrieval']['results']),
            'admittedObservationCandidates':len(selected),'deliveredObservationBodies':len(bodies),
            'incompleteBodies':sum(not m['evidenceCoverage']['complete'] for m in bodies),
            'jsonChars':result['deliveryTrace']['jsonChars'],'durationMs':c['durationMs']})
    assert len(decisions)==len(recalls)
    for decision,recall in zip(decisions,recalls):
        request=decision['request'];assert request['canRecall'] is False and 'recallEvidence' not in request
        original=recall['request'];assert not original['context'].get('memories'), 'hidden native recall still present'
        expected=copy.deepcopy(original)
        expected['context']['memories']=recall['result']['delivery'] if recall['result'] is not None else []
        assert request==expected
        actor=request['context']['character']['characterId']
        assert actor==recall['actor']==recall['scope']['characterId']
        if recall['result'] is not None:
            refs=[r for t in recall['result']['deliveryTrace']['delivered'] for r in t['sourceRefs']]
            assert all(r['characterId']==actor and r['worldSeq']<=recall['headSeq'] for r in refs)
    performs=[d for d in decisions if d['response']['decision']=='perform']
    native=[]
    for d in performs:
        actor=d['request']['context']['character']['characterId']
        resolved=[e for e in events if e['eventType']=='action.resolved' and e['data']['actorId']==actor
                  and e['data']['actionType']==d['response']['actionType'] and e['data']['accepted'] is True]
        assert resolved
        for e in resolved:
            evidence=[v for v in events if v['eventType']=='observation.upsert'
                and v['data']['value'].get('actionId')==e['data']['actionId']
                and v['data']['value'].get('observerId')==actor]
            assert evidence and all(v['transactionId']==e['transactionId'] for v in evidence)
            transfers=[v for v in events if v['eventType']=='entity.transferred' and v['transactionId']==e['transactionId']]
            native.append({'actor':actor,'resolutionSeq':e['seq'],'sourceSeqs':[v['seq'] for v in evidence],
                'transferSeqs':[v['seq'] for v in transfers]})
    assert all(u['status']=='returned' for u in utility)
    for u in utility:json.loads(u['responseText'].strip().removeprefix('```json').removesuffix('```').strip())
    result={'passed':True,'stages':len(stages),'sourceRows':len(rows),'builds':len(builds),
      'recallPreparations':len(retrievals),'characterCalls':len(decisions),'utilityCalls':len(utility),
      'characterActors':sorted({d['request']['context']['character']['characterId'] for d in decisions}),
      'nativePerform':native,'committedMoves':sum(e['eventType']=='character.moved' for e in events),
      'publishedDecisions':sum(d['response']['decision']=='publish' for d in decisions),
      'abstainedDecisions':sum(d['response']['decision']=='abstain' for d in decisions),
      'recallRows':metrics,'deliveredObservationCalls':sum(m['deliveredObservationBodies']>0 for m in metrics),
      'buildDurationMs':sum(c['durationMs'] for c in builds),
      'recallDurationMs':sum(c['durationMs'] for c in retrievals),
      'utilityProviderTokens':sum((u.get('usage') or {}).get('total_tokens',0) for u in utility),
      'limits':['one uncontrolled continuous trajectory; no stable benefit claim',
        'all build inputs owner-authorized; separate private-sentinel regressions cover negative isolation',
        'generic consolidation is reused; known-family revision and independent physical verification not tested']}
    (root/'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    return result
if __name__=='__main__':
    result=audit(Path(sys.argv[1]));print(json.dumps({k:v for k,v in result.items() if k!='recallRows'},ensure_ascii=False))
