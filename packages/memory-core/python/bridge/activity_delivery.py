"""Activity evidence associations and bounded delivery; never reads a world store."""
import copy
import json
import re
import core
import episode_core as episode
import projections

ACTIVITY_ID = re.compile(r'activity:[a-z0-9_-]+')
HOST_ESCAPE = '玩家使用宿主逃生按钮中止活动，已解除本活动的交互限制与调度。'


def metadata(value):
    if not isinstance(value, dict) or value.get('status') != 'accepted': return None
    result = value.get('resultMetadata', {})
    candidate = result.get('activity') if isinstance(result, dict) else None
    if candidate is None: candidate = value.get('activity')
    if candidate is None: return None
    if (not isinstance(candidate, dict) or not isinstance(candidate.get('id'), str)
            or not ACTIVITY_ID.fullmatch(candidate['id'])
            or type(candidate.get('revision')) is not int or candidate['revision'] < 1
            or not isinstance(candidate.get('phase'), str)
            or type(candidate.get('round')) is not int):
        raise ValueError('invalid authorized activity metadata')
    if 'active' in candidate and type(candidate['active']) is not bool:
        raise ValueError('invalid activity active flag')
    if 'lifecycle' in candidate and candidate['lifecycle'] not in {'started', 'updated', 'ended'}:
        raise ValueError('invalid activity lifecycle')
    if candidate.get('lifecycle') == 'ended' and candidate.get('active') is not False:
        raise ValueError('end marker requires inactive result')
    return {k:copy.deepcopy(candidate[k]) for k in ('id','revision','phase','round','active','lifecycle') if k in candidate}


def associations(doc):
    by_id, sources = projections.archive(doc)
    activities, atom_activity = {}, {}
    for atom in by_id.values():
        if atom['memoryLevel'] != 'event_atom' or atom['evidence']['channel'] != 'action': continue
        value = json.loads(atom['evidence']['context'])
        meta = metadata(value)
        if meta is None: continue
        ident = meta['id']; atom_activity[atom['id']] = ident
        row = activities.setdefault(ident, {'activityId':ident,'atomIds':[],'openingAtomId':None,'endingAtomId':None,'status':'unknown'})
        row['atomIds'].append(atom['id'])
        if meta.get('lifecycle') == 'started' or meta['revision'] == 1:
            prior = row['openingAtomId']
            if prior is None or atom['sourceRefs'][0]['worldSeq'] < by_id[prior]['sourceRefs'][0]['worldSeq']:
                row['openingAtomId'] = atom['id']
        # Frozen first-run sources have no active flag. Recognize only the exact
        # existing host escape renderer, not arbitrary phase names or keyword guesses.
        legacy_escape = ('active' not in meta and meta['phase'] == 'host-aborted'
                         and value.get('resultDescription') == HOST_ESCAPE)
        if meta.get('active') is False or legacy_escape:
            prior = row['endingAtomId']
            if prior is None or atom['sourceRefs'][0]['worldSeq'] > by_id[prior]['sourceRefs'][0]['worldSeq']:
                row['endingAtomId'] = atom['id']; row['status'] = 'ended'
    memberships = {}
    for unit in by_id.values():
        if unit['memoryLevel'] != 'episode': continue
        ids = sorted({atom_activity[i] for i in unit['eventAtomIds'] if i in atom_activity})
        memberships[unit['id']] = ids
    return by_id, sources, activities, atom_activity, memberships


def bind(doc):
    by_id, _, activities, atom_activity, memberships = associations(doc)
    for atom in doc['facts']:
        atom['activityIds'] = [atom_activity[atom['id']]] if atom['id'] in atom_activity else []
    for unit in doc.get('episodes', []):
        unit['activityLinks'] = []
        for ident in memberships[unit['id']]:
            row = activities[ident]
            anchors = [by_id[i] for i in (row['openingAtomId'],row['endingAtomId']) if i is not None]
            unit['activityLinks'].append({**{k:v for k,v in row.items() if k != 'atomIds'},
                                          'sourceRefs':episode.union_refs(anchors)})
    return doc


def reproject(doc):
    """Rebuild deterministic action projections, retaining all sources and LLM decisions."""
    data = copy.deepcopy(doc)
    sources = {s['sourceId']:s for s in core.check_sources(data)}
    for atom in data['facts']:
        if atom['evidence']['channel'] != 'action': continue
        parts = [s for s in episode.segments(sources[atom['evidence']['sourceId']]) if s['id'] == atom['evidence']['id']]
        if len(parts) != 1: raise ValueError('frozen action segment missing')
        part = parts[0]
        atom['evidence'] = {**part,'sourceId':atom['evidence']['sourceId'],'quote':part['context']}
        atom['evidenceQuote'] = part['context']; atom['text'] = episode.atom_text(atom)
    canonical = {a['id']:a for a in data['facts']}
    for unit in data.get('episodes', []) + data.get('observations', []):
        unit['eventAtoms'] = [copy.deepcopy(canonical[a['id']]) for a in unit['eventAtoms']]
        if unit['memoryLevel'] == 'episode': unit['text'] = episode.episode_text(unit['eventAtoms'])
    return bind(data)


def index_metadata(projected, doc):
    _, _, _, atom_activity, _ = associations(doc)
    for key in ('facts','episodes','observations'):
        for view in projected[key]:
            view['activityIds'] = sorted({atom_activity[i] for i in view['atomIds'] if i in atom_activity})
    return projected


def deliver(doc, candidates, request, tick, query, max_items=3, max_json_chars=4500, include_anchors=True):
    base = projections.delivery_projection(doc,candidates,request,tick,max_items=max_items,max_json_chars=max_json_chars,fair=True)
    by_id, sources, activities, atom_activity, memberships = associations(doc)
    recent = {int(o['sourceSeq']) for o in request['context'].get('observations',[]) + request['context'].get('selfObservations',[])}
    requested = set(ACTIVITY_ID.findall(query['originalText']))
    touched = {}; relation_refs = {}
    def atom_links(atom_id):
        # An incidental sentence in a game episode is not a game-content hit.
        return {atom_activity[atom_id]} if atom_id in atom_activity else set()
    def touch(ident, memory_id, atoms):
        if requested and ident not in requested: return
        touched.setdefault(ident, []).append(memory_id)
        relation_refs.setdefault(ident, []).extend(episode.union_refs([by_id[i] for i in atoms]))
    for candidate in candidates:
        unit = by_id[candidate['id']]
        ids = [unit['id']] if unit['memoryLevel'] == 'event_atom' else []
        for match in candidate.get('matches', []):
            scores = match.get('atomScores')
            ids.extend([r['atomId'] for r in scores if r['accepted']] if scores is not None else match['atomIds'])
        ids = list(dict.fromkeys(ids))
        direct = set().union(*(atom_links(i) for i in ids))
        # No accepted atom match means no automatic closure expansion. Explicit
        # authorized IDs below still retrieve endings without a similarity hit.
        for ident in sorted(direct): touch(ident,unit['id'],ids)
    # An exact authorized ID is sufficient. Natural-language "that game" is not guessed.
    explicit = [i for i in dict.fromkeys(ACTIVITY_ID.findall(query['originalText'])) if i in activities]
    query['activitySeeds'] = explicit
    for ident in explicit:
        row = activities[ident]
        touch(ident,ident,[i for i in (row['openingAtomId'],row['endingAtomId']) if i is not None])
    keys = {i:projections.evidence_key(a,sources) for i,a in by_id.items() if a['memoryLevel'] == 'event_atom'}
    pool = []
    anchors = [('endingAtomId','same activity ending evidence'),('openingAtomId','same activity opening evidence')] if include_anchors else []
    for field,reason in anchors:
        for ident in touched:
            atom_id = activities[ident][field]
            if atom_id is None: continue
            atom = by_id[atom_id]
            if atom['sourceRefs'][0]['worldSeq'] in recent: continue
            evidence = atom['evidence']
            text = '【'+episode.LABELS[evidence['channel']]+'】'+(evidence.get('actorId') or '')+'：'+evidence['context']
            item = {'memoryId':atom_id,'memoryLevel':'event_atom','text':text,'epistemicKind':sources[evidence['sourceId']]['epistemicKind'],
                    'sourceIds':[evidence['sourceId']],'sourceAgeTicks':tick-sources[evidence['sourceId']]['knownTick']}
            trace = {'memoryId':atom_id,'sourceRefs':atom['sourceRefs'],'coveredAtomIds':[atom_id],
                     'reason':reason,'activityId':ident,'matchedMemoryIds':list(dict.fromkeys(touched[ident])),
                     'relationSourceRefs':list({r['sourceId']:r for r in relation_refs[ident]}.values())}
            pool.append((item,trace,ident))
    for item,trace in zip(base['memories'],base['trace']['delivered']):
        ids = set().union(*(atom_links(i) for i in trace['coveredAtomIds']))
        ident = next(iter(ids)) if len(ids) == 1 else None
        if requested and ident not in requested: continue
        pool.append((item,trace,ident))
    def annotated(rows):
        items = copy.deepcopy([row[0] for row in rows]); coverage = {}; noted = set()
        included = {i for _,tr,_ in rows for i in tr['coveredAtomIds']}
        for item,(_,_,ident) in zip(items,rows):
            if ident is None: continue
            row = activities[ident]
            def present(atom_id): return atom_id is not None and (atom_id in included or by_id[atom_id]['sourceRefs'][0]['worldSeq'] in recent)
            info = {'activityId':ident,'status':row['status'],'openingIncluded':present(row['openingAtomId']),
                    'endingIncluded':present(row['endingAtomId']),'processCoverage':'selected evidence'}
            coverage[ident] = {**info,'endingSourceRefs':by_id[row['endingAtomId']]['sourceRefs'] if row['endingAtomId'] else []}
            item['deliveryCoverage'] = info
            if ident not in noted:
                if info['endingIncluded']: note = '该活动已结束；当前材料包含结束记录，过程为选取的经历片段。'
                elif row['status'] == 'ended': note = '该活动已结束；当前材料未包含结束记录，不能据此推断结束方式或原因。'
                else: note = '当前材料为经历片段；本角色授权档案中尚无结束记录，不能据此确定结局或认定活动仍在进行。'
                item['text'] = '【材料完整度】'+note+'\n'+item['text']; noted.add(ident)
        return items,list(coverage.values())
    # The first projection committed summaries/fallbacks with their counters.
    # Preserve those dependencies through this final activity-budget allocation.
    owner_rows = {}
    key_rows = {}
    for index, (item, trace, _) in enumerate(pool):
        for key in {keys[i] for i in trace['coveredAtomIds']}:
            key_rows.setdefault(key, index)
        owner = item['memoryId'] if item['memoryLevel'] == 'observation' else trace.get('fallbackObservationId')
        if owner is not None:
            owner_rows.setdefault(owner, []).append(index)
    protected = {}
    roots = {}
    for owner, indices in owner_rows.items():
        counters = [i for i in by_id[owner]['contradictingAtomIds']
                    if by_id[i]['sourceRefs'][0]['worldSeq'] not in recent]
        if not counters:
            continue
        missing = [i for i in counters if keys[i] not in key_rows]
        members = sorted(set(indices + [key_rows[keys[i]] for i in counters if keys[i] in key_rows]))
        protected[owner] = {'indices':members, 'counterAtomIds':counters, 'missing':missing}
        roots[min(indices)] = owner
    grouped_roots = {i for owner in protected for i in owner_rows[owner]}
    dependent_rows = {i for group in protected.values() for i in group['indices']}
    tasks = []
    openings = []
    for index, row in enumerate(pool):
        item, trace, _ = row
        if index in roots:
            tasks.append((protected[roots[index]]['indices'], roots[index]))
        elif index in grouped_roots:
            continue
        elif index in dependent_rows and trace.get('reason') == 'contradicts selected observation':
            # This evidence is carried by its summary's protected group, unless
            # independently selected elsewhere; it must not become a loose tail.
            continue
        elif protected and trace.get('reason') == 'same activity opening evidence':
            openings.append(([index], None))
        else:
            tasks.append(([index], None))
    tasks.extend(openings)

    selected = []; covered = set(); omitted = []; accepted_groups = []
    for indices, owner in tasks:
        if owner is not None and protected[owner]['missing']:
            omitted.append({'memoryId':owner, 'reason':'required counter-evidence absent after activity filtering',
                            'counterAtomIds':protected[owner]['missing']})
            continue
        pending = []; pending_keys = set()
        for index in indices:
            item, trace, ident = pool[index]
            evidence_keys = {keys[i] for i in trace['coveredAtomIds']}
            if evidence_keys and evidence_keys <= covered | pending_keys:
                continue
            pending.append((item, trace, ident)); pending_keys.update(evidence_keys)
        trial = selected + pending
        memories,_ = annotated(trial)
        if len(trial)>max_items or projections.chars(memories)>max_json_chars:
            omitted.append({'memoryId':owner if owner is not None else pool[indices[0]][0]['memoryId'],
                            'reason':'budget; complete observation/fallback and counter-evidence kept together'
                                     if owner is not None else 'budget including completeness annotation'})
            continue
        selected = trial; covered.update(pending_keys)
        if owner is not None:
            accepted_groups.append({'memoryId':owner, 'counterAtomIds':protected[owner]['counterAtomIds'],
                                    'additionalItems':len(pending)})
    for item, _, _ in selected:
        if item['memoryLevel'] == 'observation':
            missing = [i for i in by_id[item['memoryId']]['contradictingAtomIds']
                       if by_id[i]['sourceRefs'][0]['worldSeq'] not in recent and keys[i] not in covered]
            if missing:
                raise ValueError('final activity delivery lost required counter-evidence')
    memories,coverage = annotated(selected)
    result = {'memories':memories,'trace':{**base['trace'],'delivered':[r[1] for r in selected],
        'omitted':[{**o,'stage':'retrieved evidence projection'} for o in base['trace']['omitted']]+omitted,'activityCoverage':coverage,'jsonChars':projections.chars(memories),
        'budget':{**base['trace']['budget'],'allocation':'authorized activity ending, opening, then retrieved evidence'},
        'distinctEvidenceSegments':len(covered)}}
    if protected:
        result['trace']['protectedGroups'] = accepted_groups
        result['trace']['budget']['allocation'] = 'activity ending, complete observation/counter groups and retrieved evidence, optional opening'
    return result
