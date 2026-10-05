"""Frozen 6.1 candidates: Delivery contrast, then the same minimal Delivery with/without JEV."""
import copy, json, sys
import notice_board_action_loop as loop
import minimal_delivery


def prepare(doc):
    frozen = doc['recall']; source_input = doc['input']
    archive = loop.archive_for_recall(source_input)
    targets = {o['id']: o for o in archive['observations']}
    pool = copy.deepcopy(frozen['retrieval']['results'])
    ids = [r['id'] for r in pool if r['id'] in targets][:7]
    if ids != frozen['sentIds']:
        raise ValueError('frozen cognition candidate pool changed')
    query = frozen['query']; request = source_input['request']; tick = source_input['tick']
    decision = frozen['decision']
    if doc['phase'] == 'jev':
        stimulus = {'text': query['originalText'],
            'actorIds': [e['id'] for e in query['entitySeeds'] if 'actor' in e['roles']],
            'mentionedIds': [e['id'] for e in query['entitySeeds'] if 'mentioned' in e['roles']]}
        empty = {'subjects': [], 'contexts': [], 'conditions': [], 'exceptions': [], 'themes': []}
        decision = loop.jev.assess_many(stimulus, [{'memoryId': i, 'understanding': targets[i]['text'], 'applicability': empty} for i in ids]) if ids else {'answers': {}, 'usage': {}, 'latencyMs': 0}
    elif doc['phase'] != 'delivery':
        raise ValueError('unknown contrast phase')
    if set(decision['answers']) != set(ids):
        raise ValueError('JEV does not cover frozen candidates')
    for answer in decision['answers'].values(): loop.jev.validate_decision(answer)
    related = [i for i in ids if decision['answers'][i]['related']]
    accepted = [r for r in pool if r['id'] not in targets or r['id'] in related]
    accepted = loop.delivery_order.order(accepted, decision)
    def arm(selected, delivery, gate):
        return {'query': copy.deepcopy(query), 'retrieval': copy.deepcopy(frozen['retrieval']),
                'candidateIds': [r['id'] for r in pool], 'selectedIds': selected, 'gateMode': gate,
                'sentIds': ids if gate != 'none' else [], 'decision': decision if gate != 'none' else None,
                'delivery': delivery, 'targetIds': list(targets)}
    minimal = minimal_delivery.deliver(archive, accepted, related, request, tick, copy.deepcopy(query))
    if doc['phase'] == 'delivery':
        legacy = loop.bridge.activity.deliver(archive, accepted, request, tick, copy.deepcopy(query), max_items=3, max_json_chars=4500)
        if legacy != frozen['delivery']:
            raise ValueError('existing Delivery could not be reproduced')
        return {'legacy': arm(related, legacy, 'frozen-jev'),
                'minimal': arm(related, minimal, 'frozen-jev')}
    ungated = minimal_delivery.deliver(archive, pool, ids, request, tick, copy.deepcopy(query))
    return {'with-jev': arm(related, minimal, 'live-jev'),
            'without-jev': arm(ids, ungated, 'none')}

if __name__ == '__main__':
    json.dump(prepare(json.load(sys.stdin)), sys.stdout, ensure_ascii=False)
