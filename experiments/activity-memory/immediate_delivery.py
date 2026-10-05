"""Stage 6.3: reuse frozen current cognition; no update, retrieval or JEV calls."""
import copy, json, sys
import minimal_delivery
bridge = minimal_delivery.bridge


def prepare(doc):
    initial, snapshot = doc['initial'], doc['snapshot']
    archive = copy.deepcopy(initial['archive'])
    if archive['scope']['characterId'] != snapshot['scope']['characterId'] or archive['scope']['worldAddress'] != snapshot['scope']['worldAddress']:
        raise ValueError('frozen cognition crosses owner or world')
    trusted = {s['sourceId']: s for s in snapshot['sources']}
    for source in archive['sources']:
        if source['sourceId'] not in trusted or any(trusted[source['sourceId']].get(k) != v for k,v in source.items()):
            raise ValueError('frozen cognition is not grounded in the host-authorized snapshot')
    archive['scope'] = copy.deepcopy(snapshot['scope'])
    bridge.projections.archive(archive)
    if archive['observations'] != initial['record']['current']:
        raise ValueError('current cognition differs from frozen record')
    candidates = [{'id': o['id']} for o in archive['observations']]
    delivery = minimal_delivery.deliver(archive, candidates, [o['id'] for o in archive['observations']],
        doc['request'], snapshot['tick'], {}, max_items=3, max_json_chars=4500)
    if len(delivery['memories']) != len(candidates):
        raise ValueError('required current body exceeds the shared experiment budget')
    return {'delivery': delivery, 'archive': archive, 'newModelCalls': 0,
            'cognitionUpdatedBeforeResponse': False, 'selection': 'already available current cognition; no retrieval or JEV'}

if __name__ == '__main__':
    json.dump(prepare(json.load(sys.stdin)), sys.stdout, ensure_ascii=False)
