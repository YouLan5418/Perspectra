"""Experimental Observation delivery: body first, honest evidence excerpts, no truth gate or complete-group gate."""
import copy
import core_bridge as bridge


def deliver(archive, candidates, selected_ids, request, tick, query, max_items=3, max_json_chars=4500):
    by_id, sources = bridge.projections.archive(archive)
    scope = archive['scope']
    context = request['context']
    if (context['character']['characterId'] != scope['characterId']
            or context.get('cognition', {}).get('address', scope['worldAddress']) != scope['worldAddress']):
        raise ValueError('Delivery request crosses character or world')
    if type(tick) is not int or any(s['knownTick'] > tick for s in sources.values()):
        raise ValueError('Delivery contains future Source')
    if type(max_items) is not int or max_items < 0 or type(max_json_chars) is not int or max_json_chars < 2:
        raise ValueError('invalid Delivery budget')
    candidate_ids = {c['id'] for c in candidates}
    if not candidate_ids <= by_id.keys() or not set(selected_ids) <= candidate_ids:
        raise ValueError('selection is outside authorized candidate pool')
    if any(by_id[i]['memoryLevel'] != 'observation' for i in selected_ids):
        raise ValueError('only Observation can be selected for direct body delivery')
    memories, delivered, omitted = [], [], []
    for candidate in candidates:
        ident = candidate['id']
        if ident not in selected_ids:
            continue
        unit = by_id[ident]
        refs = unit['sourceRefs']
        counters = unit['contradictingAtomIds']
        supports = unit['supportingAtomIds']
        types = sorted({sources[r['sourceId']]['epistemicKind'] for r in refs})
        base = {'memoryId': ident, 'memoryLevel': 'observation', 'epistemicKind': unit['epistemicKind'],
                'text': '【本角色的可修正认识；不是权威世界事实】\n' + unit['text'],
                'sourceIds': [r['sourceId'] for r in refs],
                'sourceAgeTicks': tick - max(sources[r['sourceId']]['knownTick'] for r in refs),
                'sourceTypes': types, 'hasUnresolvedCounterEvidence': bool(counters)}
        def item_for(evidence):
            included = {e['atomId'] for e in evidence}
            return {**base, 'keyEvidence': evidence, 'evidenceCoverage': {
                'included': len(included), 'total': len(unit['sourceFactIds']),
                'counterIncluded': len(included & set(counters)), 'counterTotal': len(counters),
                'complete': set(unit['sourceFactIds']) <= included,
                'note': ('证据已全部展示；来源内容不证明现实真值，也不表示冲突已解决。'
                         if set(unit['sourceFactIds']) <= included else
                         '仅证据摘选；未展示的证据和反证仍存在，不能视为已核实或冲突已解决。')}}
        item = item_for([])
        if len(memories) >= max_items or bridge.projections.chars(memories + [item]) > max_json_chars:
            omitted.append({'memoryId': ident, 'reason': 'Observation body and mandatory provenance exceed budget'})
            continue
        # One counter and one latest support at most. Neither is required to fit for the body to survive.
        choices = counters[:1] + sorted(supports, key=lambda i: max(r['worldSeq'] for r in by_id[i]['sourceRefs']), reverse=True)[:1]
        evidence = []
        for atom_id in dict.fromkeys(choices):
            atom = by_id[atom_id]
            ref = atom['sourceRefs'][0]
            selected = {'atomId': atom_id, 'sourceId': ref['sourceId'],
                        'role': 'counter' if atom_id in counters else 'support',
                        'epistemicKind': sources[ref['sourceId']]['epistemicKind'],
                        'text': '【' + bridge.episode.LABELS[atom['evidence']['channel']] + '】' + atom['evidence']['context']}
            trial = item_for(evidence + [selected])
            if bridge.projections.chars(memories + [trial]) <= max_json_chars:
                evidence.append(selected)
                item = trial
        memories.append(item)
        delivered.append({'memoryId': ident, 'sourceRefs': copy.deepcopy(refs),
                          'referencedAtomIds': copy.deepcopy(unit['sourceFactIds']),
                          'coveredAtomIds': [e['atomId'] for e in evidence],
                          'reason': 'selected authorized subjective Observation body; optional evidence excerpts'})
    # Reuse existing non-Observation evidence projection; the complex Observation path is never called here.
    raw_candidates = [c for c in candidates if by_id[c['id']]['memoryLevel'] != 'observation']
    remaining = max_json_chars - bridge.projections.chars(memories) + (1 if memories else 2)
    if raw_candidates and len(memories) < max_items and remaining >= 2:
        raw = bridge.activity.deliver(archive, raw_candidates, request, tick, copy.deepcopy(query),
                                     max_items=max_items-len(memories), max_json_chars=remaining)
        for item, trace in zip(raw['memories'], raw['trace']['delivered']):
            if len(memories) < max_items and bridge.projections.chars(memories + [item]) <= max_json_chars:
                memories.append(item); delivered.append(trace)
        omitted.extend(raw['trace']['omitted'])
    return {'memories': memories, 'trace': {'delivered': delivered, 'omitted': omitted,
        'jsonChars': bridge.projections.chars(memories), 'budget': {'maxItems': max_items, 'maxJsonChars': max_json_chars},
        'selectedObservationIds': list(selected_ids), 'bodyFirst': True, 'truthGate': False,
        'completeEvidenceGroupRequired': False, 'evidenceExcerptsPerObservation': 2}}
