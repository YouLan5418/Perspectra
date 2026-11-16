"""Stage 6.1: admit explicit authorized ID associations; preserve scores and downstream rules."""
import copy
import core_bridge as bridge


def seeds_for(request, query, owner):
    context = request['context']
    entries = query['entitySeeds']
    mentioned = {e['id'] for e in entries if 'mentioned' in e['roles'] or any(r.startswith('object:') for r in e['roles'])}
    objects = {i for i in mentioned if i.startswith('entity:')} | set(query.get('requiredEntityIds', []))
    people = {e['id'] for e in entries if e['id'] != owner and e['id'].startswith('character:')
              and set(e['roles']) & {'actor', 'mentioned'}}
    explicit_places = {i for i in mentioned if i.startswith('location:')}
    scene = context.get('scene', {})
    location = scene.get('locationId')
    visible = context.get('items', {})
    visible = visible.get('current', []) if isinstance(visible, dict) else visible
    if objects:
        # An explicit object topic does not open all other objects in the same room.
        places = explicit_places
        mode = 'explicit-object'
    else:
        places = explicit_places | ({location} if isinstance(location, str) else set())
        objects = {v['entityId'] for v in visible if isinstance(v, dict)
                   and isinstance(v.get('entityId'), str) and v.get('locationId') == location}
        mode = 'current-authorized-scene'
    activities = set(bridge.activity.ACTIVITY_ID.findall(query['originalText']))
    active = context.get('activity', {})
    if isinstance(active, dict) and isinstance(active.get('id'), str):
        activities.add(active['id'])
    return {'mode': mode, 'entityIds': sorted((objects | places | people) - {owner}),
            'activityIds': sorted(activities), 'observerIsNotASeed': True}


def admit(archive, index, retrieval, request, query):
    by_id, sources = bridge.projections.archive(archive)
    if index['scope'] != archive['scope'] or retrieval['scope'] != archive['scope']:
        raise ValueError('candidate input crosses world or prefix')
    if request['context']['character']['characterId'] != archive['scope']['characterId']:
        raise ValueError('candidate request belongs to another character')
    if request['context'].get('cognition', {}).get('address', archive['scope']['worldAddress']) != archive['scope']['worldAddress']:
        raise ValueError('candidate request belongs to another world')
    for view in index['units']:
        unit = by_id.get(view['memoryId'])
        if unit is None:
            raise ValueError('foreign projection memory')
        allowed = {unit['id']} if unit['memoryLevel'] == 'event_atom' else set(unit.get('eventAtomIds', unit.get('sourceFactIds', [])))
        if not view['atomIds'] or not set(view['atomIds']) <= allowed:
            raise ValueError('foreign projection atoms')
        if view['sourceRefs'] != bridge.episode.union_refs([by_id[i] for i in view['atomIds']]):
            raise ValueError('projection evidence identity changed')
        if any(r['sourceId'] not in sources for r in view['sourceRefs']):
            raise ValueError('projection contains unauthorized Source')
    seeds = seeds_for(request, query, archive['scope']['characterId'])
    raw = {r['id']:r for r in retrieval.get('rawScores', [])}
    before = {c['id']:copy.deepcopy(c) for c in retrieval['results']}
    candidates = copy.deepcopy(before)
    details = []
    for unit in by_id.values():
        matched = []
        matches = []
        for view in index['units']:
            if view['memoryId'] != unit['id']:
                continue
            entity_ids = sorted(set(view.get('entities', [])) & set(seeds['entityIds']))
            activity_ids = sorted(set(view.get('activityIds', [])) & set(seeds['activityIds']))
            if not entity_ids and not activity_ids:
                continue
            if query['mode'] == 'skip':
                continue
            signal = raw.get(view['id'])
            if signal is None:
                raise ValueError('ID admission requires frozen original score diagnostics')
            values = {k:copy.deepcopy(v) for k,v in signal.items() if k not in ('id', 'memoryId', 'graphScore')}
            atom_scores = []
            for atom_id in view['atomIds']:
                atom_views = [v for v in index['units'] if v['memoryId'] == atom_id]
                atom_signal = max((raw[v['id']] for v in atom_views if v['id'] in raw),
                                  key=lambda r:r['relevance'], default=None)
                if atom_signal is not None:
                    atom_match = any(set(v.get('entities', [])) & set(seeds['entityIds'])
                                     or set(v.get('activityIds', [])) & set(seeds['activityIds']) for v in atom_views)
                    atom_scores.append({**{k:v for k,v in atom_signal.items() if k not in ('id','memoryId','graphScore')},
                                        'atomId':atom_id, 'originalAccepted':atom_signal['accepted'],
                                        'accepted':atom_signal['accepted'] or atom_match,
                                        'admissionReason':'original gate or explicit ID'})
            matches.append({'representationId':view['id'], 'atomIds':copy.deepcopy(view['atomIds']),
                            'sourceRefs':copy.deepcopy(view['sourceRefs']), **values,
                            'originalAccepted':signal['accepted'], 'accepted':True,
                            'admissionReason':'explicit authorized ID', 'atomScores':atom_scores})
            matched.append({'representationId':view['id'], 'entityIds':entity_ids, 'activityIds':activity_ids})
        if unit['id'] not in before and matches:
            candidates[unit['id']] = {'id':unit['id'], 'score':0.0, 'sourceRanks':{}, 'fusionRank':None,
                                     'relevance':max(m['relevance'] for m in matches), 'matches':matches}
        details.append({'memoryId':unit['id'], 'memoryLevel':unit['memoryLevel'],
                        'originalCandidate':unit['id'] in before, 'explicitMatches':matched,
                        'admitted':unit['id'] in candidates,
                        'reason':'original gate' if unit['id'] in before else 'explicit ID' if matches
                                 else 'low-information query' if query['mode'] == 'skip' else 'no explicit association'})
    rows = sorted(candidates.values(), key=lambda c:(-c['relevance'], -c['score'], c['id']))
    selected = rows[:32]
    for rank, row in enumerate(selected, 1):
        row['rank'] = rank
    selected_ids = {c['id'] for c in selected}
    for detail in details:
        detail['selected'] = detail['memoryId'] in selected_ids
        if detail['admitted'] and not detail['selected']:
            detail['reason'] = 'candidate budget'
    return selected, {'seeds':seeds, 'units':details, 'candidateLimit':32,
                      'originalIds':list(before), 'selectedIds':[c['id'] for c in selected],
                      'newSemanticModels':0, 'familyExpansion':False,
                      'ordering':'unchanged relevance then existing fusion score then ID; no new scoring',
                      'limits':['scene association is candidacy, not topic applicability or truth',
                                'rank fusion is not recomputed for newly admitted rows']}
