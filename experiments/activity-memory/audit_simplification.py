"""Read-only audit of simplification traces. No models, world writes or semantic scoring."""
import copy, hashlib, json, sys
from pathlib import Path

def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))

def audit(root):
    root = Path(root)
    protocol = load(root / 'protocol.json')
    assert all(hashlib.sha256(Path(p).read_bytes()).hexdigest() == h for p,h in protocol['frozen'].items()), 'frozen input changed'
    rows = []
    usage = {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}
    models = set()
    for row in load(root / 'trials.json'):
        seed, sample, path = row['seed'], row['sample'], row['path']
        folder = root / seed / ('sample-' + str(sample) + '-' + path)
        snapshot = load(root / seed / 'snapshot.json')
        sources = {s['sourceId']:s for s in snapshot['sources']}
        events = load(folder / 'events.json')
        event_by_seq = {e['seq']:e for e in events}
        source_after = load(folder / 'sources.json')
        first = load(folder / 'call-0.json')
        expected = load(root / seed / 'request.json')
        plain = copy.deepcopy(first['request']); plain['context']['memories'] = []
        expected['context']['memories'] = []
        assert plain == expected, 'nonmemory input changed'
        for source in snapshot['sources']:
            event = event_by_seq[source['worldSeq']]
            assert event['eventType'] == 'observation.upsert'
            assert event['data']['value']['observerId'] == snapshot['scope']['characterId']
            assert event['eventHash'] == source['sourceHash']
            assert source['worldSeq'] <= snapshot['scope']['asOfWorldSeq']
        if protocol['phase'] in ('6.1-delivery', '6.2', '6.3', '6.4') or path in ('original', 'simple-id'):
            assert first['request']['context']['memories'] == load(root / seed / (path + '.json'))['delivery']['memories']
        elif path != 'complex':
            budget = 8000 if path == 'raw-8000-bytes' else 24000
            delivery = load(root / seed / ('raw-' + str(budget) + '.json'))
            assert first['request']['context']['memories'] == delivery['memories']
            assert len(json.dumps(delivery['memories'], ensure_ascii=False, separators=(',',':')).encode()) <= budget
            assert delivery['trace']['semanticCalls'] == 0
            assert not delivery['trace']['observationBodiesDelivered']
            delivered_ids = [s for m in delivery['memories'] for s in m['sourceIds']]
            assert len(delivered_ids) == len(set(delivered_ids))
            for ref in delivery['trace']['delivered']:
                assert ref['sourceRef'] == {k:sources[ref['sourceRef']['sourceId']][k] for k in ref['sourceRef']}
        else:
            assert first['request']['context']['memories'] == load(root / seed / 'complex.json')['delivery']['memories']
        perform = row['result'].get('performResult', {})
        operation = perform.get('operationId')
        resolution = next((e for e in events if e['seq'] > row['before']['headSeq'] and e['eventType'] == 'action.resolved'
                           and e['data'].get('actionId') == operation and e['data'].get('accepted') is True), None)
        committed = perform.get('status') == 'accepted' and resolution is not None
        action = perform.get('action', {})
        params = action.get('parameters', {})
        capability = params.get('definitionRef', {}).get('id')
        acquired = []
        for s in source_after['sources']:
            c = s.get('content', {})
            if s['worldSeq'] <= row['before']['headSeq'] or not isinstance(c,dict) or c.get('sourceActionId') != operation:
                continue
            if c.get('capabilityId') in ['experiment:ask_staff','experiment:inspect_terminal','experiment:inspect-notice-board']:
                assert committed, 'uncommitted evidence'
                assert event_by_seq[s['worldSeq']]['transactionId'] == resolution['transactionId'], 'non-atomic evidence'
                assert s['characterId'] == snapshot['scope']['characterId']
                assert s['epistemicKind'] == ('reported_speech' if c['capabilityId'] == 'experiment:ask_staff' else 'direct_observation')
                acquired.append(s['sourceId'])
        per_usage = {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}
        for i in range(row['calls']):
            call = load(folder / ('call-' + str(i) + '.json'))
            transport = load(folder / ('transport-' + str(i) + '.json'))
            assert call['status'] == 'returned' and transport['status'] == 200
            body = json.loads(transport['body'])
            models.add(body.get('model','unknown'))
            for k in usage:
                per_usage[k] += body.get('usage',{}).get(k,0)
                usage[k] += body.get('usage',{}).get(k,0)
        kind = ('move:' + str(params.get('locationId'))) if action.get('actionType') == 'move' else capability
        rows.append({'seed':seed,'sample':sample,'path':path,'calls':row['calls'], 'durationMs':row['durationMs'],
                     'materialCount':row['materialCount'],'materialBytes':row['materialBytes'], 'requestBytes':first['requestBytes'],
                     'decision':first['response'],'status':row['result']['status'],'failure':row.get('failure'),'acceptedAndCommitted':committed,'actionKind':kind if committed else 'none',
                     'acquiredSourceIds':acquired,'usage':per_usage})
    groups = {}
    for path in protocol['paths']:
        own = [r for r in rows if r['path'] == path]
        groups[path] = {'trials':len(own),'failedActivations':sum(r['status']=='failed' for r in own),'committedActions':sum(r['acceptedAndCommitted'] for r in own),
                        'acquisitions':sum(bool(r['acquiredSourceIds']) for r in own),'calls':sum(r['calls'] for r in own),
                        'activationDurationMs':sum(r['durationMs'] for r in own),
                        'usage':{k:sum(r['usage'][k] for r in own) for k in usage},
                        'materialCount':sorted(set(r['materialCount'] for r in own)),
                        'materialBytes':sorted(set(r['materialBytes'] for r in own))}
    complete = len(rows) == sum(protocol.get('samplesBySeed', {}).get(s, protocol['samples']) for s in protocol['seeds']) * len(protocol['paths'])
    return {'complete':complete,'frozenInputsUnchanged':True,'sourceAuthorizationAndIdentityVerified':True,
            'initialNonmemoryInputsEqual':True,'atomicAcquisitionsVerified':True,'groups':groups,'usage':usage,'models':sorted(models),
            'cost':None,'materialTokens':None, 'rows':rows,
            'limits':['activation timing excludes offline material preparation; no full pipeline speed claim',
                      'byte budgets are not model-token capacities; no prices declared',
                      'read-only audit establishes program boundaries, not semantic correctness']}

if __name__ == '__main__':
    result = audit(sys.argv[1])
    target = Path(sys.argv[1]) / 'audit.json'
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k != 'rows'}, ensure_ascii=False))
