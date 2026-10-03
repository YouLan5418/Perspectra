"""Search and reading projections over an immutable authorized cognitive archive.

Neither projection creates evidence. Full provenance stays in the delivery trace.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import core
import episode_core as episode
import vector_core as vector
import queries
import retrieval_text


def chars(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')))


def archive(doc):
    units = episode.validate_units(doc)
    vector.check_mapping(doc, units)
    return {u['id']: u for u in units if u.get('memoryLevel')}, {s['sourceId']: s for s in doc['sources']}


def token_counter():
    from tokenizers import Tokenizer
    assets = Path(os.getenv('HCW_HINDSIGHT_ONNX_DIR', str(vector.BASE / '.tmp/hindsight-e5-small')))
    tokenizer = Tokenizer.from_file(str(assets / 'tokenizer.json'))
    return lambda text: len(tokenizer.encode('passage: ' + text).ids)


def atom_search_text(atom):
    evidence = atom['evidence']
    if evidence['channel'] == 'action':
        value = json.loads(evidence['context'])
        return queries.action_text(value, {})
    # Authority labels remain in delivery; they are not search content.
    return evidence['quote']


def entity_roles(atoms):
    roles = {}
    def add(ident, role):
        if isinstance(ident, str) and queries.ID.fullmatch(ident):
            roles.setdefault(ident, set()).add(role)
    for atom in atoms:
        evidence = atom['evidence']
        add(evidence.get('actorId'), 'actor')
        for ident in atom.get('entities', []): add(ident, 'mentioned')
        if evidence['channel'] == 'action':
            value = json.loads(evidence['context'])
            for key in ('movement', 'interaction'):
                for field, ident in value.get(key, {}).items():
                    if field in ('entityId','fromLocationId','toLocationId','fromHolderId','toHolderId','characterId'):
                        add(ident, key + ':' + field)
    return [{'id':ident,'roles':sorted(values)} for ident,values in sorted(roles.items())]


def retrieval_projection(doc, count_tokens=None, max_tokens=220, alias_history=()):
    by_id, _ = archive(doc)
    aliases = retrieval_text.alias_table(doc, alias_history)
    count = count_tokens or token_counter()
    views = []

    def add(unit, atoms, text):
        # Search excerpts may split a long span. Delivery never uses those excerpts.
        while text:
            end = len(text)
            if count(text) > max_tokens:
                lo, hi = 1, len(text)
                while lo < hi:
                    middle = (lo + hi + 1) // 2
                    if count(text[:middle]) <= max_tokens: lo = middle
                    else: hi = middle - 1
                end = lo
            piece, text = text[:end], text[end:]
            if count(piece) > max_tokens: raise ValueError('search token budget too small')
            cleaned = retrieval_text.clean(piece, aliases)
            if retrieval_text.content_length(cleaned) < retrieval_text.MIN_CONTENT_CHARS: continue
            refs = episode.union_refs(atoms) if atoms else unit['sourceRefs']
            roles = {r['id']:set(r['roles']) for r in entity_roles(atoms)}
            # Removed names stay available to the existing entity route, never as facts.
            for person in aliases['people']:
                if person['name'] in piece:
                    roles.setdefault(person['characterId'],set()).add('mentioned')
            roles = [{'id':ident,'roles':sorted(values)} for ident,values in sorted(roles.items())]
            views.append({'id':'retrieval:' + str(len(views)), 'kind':unit['kind'],
                'retrievalProjection':True, 'memoryId':unit['id'], 'projectionLevel':unit['memoryLevel'],
                'atomIds':[a['id'] for a in atoms], 'text':piece,
                'retrievalText':cleaned, 'retrievalTextRule':retrieval_text.RULE, 'sourceRefs':refs,
                'channels':sorted({a['evidence']['channel'] for a in atoms}),
                'entities':[r['id'] for r in roles], 'entityRoles':roles, 'searchTokens':count(piece)})

    for unit in by_id.values():
        level = unit['memoryLevel']
        if level == 'event_atom': add(unit, [unit], atom_search_text(unit))
        elif level == 'episode':
            chunk, texts = [], []
            for ident in unit['eventAtomIds']:
                atom = by_id[ident]
                text = atom_search_text(atom)
                if retrieval_text.content_length(retrieval_text.clean(text, aliases)) < retrieval_text.MIN_CONTENT_CHARS: continue
                if texts and count('\n'.join(texts + [text])) > max_tokens:
                    add(unit, chunk, '\n'.join(texts)); chunk, texts = [], []
                chunk.append(atom); texts.append(text)
            if texts: add(unit, chunk, '\n'.join(texts))
        elif level == 'observation':
            text = unit['text']
            while text.startswith('【主观认识，可修正】'): text = text[len('【主观认识，可修正】'):]
            add(unit, [by_id[i] for i in unit['sourceFactIds']], text)
    collections = {key:[v for v in views if v['kind'] == kind] for key, kind in
                   [('facts','fact'), ('episodes','episode'), ('observations','observation')]}
    result = {'scope':doc['scope'],'sources':doc['sources'],'representations':[], 'retrievalAliases':aliases, **collections}
    vector.check_mapping(result, views)
    return result


def search(index, scope, query, recent_seqs=(), **options):
    if index['scope'] != scope: raise ValueError('index scope differs')
    recent = set(recent_seqs)
    positions = [i for i,v in enumerate(index['units']) if v['projectionLevel'] == 'observation'
                 or not all(r['worldSeq'] in recent for r in v['sourceRefs'])]
    units = [index['units'][i] for i in positions]
    ids = {u['id'] for u in units}
    filtered = {**index,'units':units,'vectors':[index['vectors'][i] for i in positions],
                'links':[e for e in index['links'] if e[0] in ids and e[1] in ids]}
    return vector.recall({'scope':scope,'index':filtered,'query':query,
                          'collapseByMemory':True,'limit':32, **options})


def evidence_key(atom, sources):
    evidence = atom['evidence']
    channel, actor = evidence['channel'], evidence.get('actorId')
    if channel == 'player_input':
        # Merge the duplicate rendering only when this exact source also attributes
        # this exact text to the player. Similar events in other sources stay separate.
        twins = [s for s in episode.segments(sources[evidence['sourceId']])
                 if s['channel'] == 'speech' and s.get('actorId') == 'character:player'
                 and s['context'] == evidence['context']]
        if twins: channel, actor = 'speech', 'character:player'
    return (evidence['sourceId'], channel, actor, evidence['context'])


def candidate_clusters(candidates, by_id):
    groups = []
    for candidate in candidates:
        unit = by_id.get(candidate['id'])
        if unit is None: raise ValueError('candidate not in authorized archive')
        coverage = {unit['id']} if unit['memoryLevel'] == 'event_atom' else set(unit.get('eventAtomIds',unit.get('sourceFactIds',[])))
        touching = [g for g in groups if g['coverage'] & coverage]
        if not touching: groups.append({'ids':[unit['id']],'coverage':coverage})
        else:
            target = touching[0]
            target['ids'].append(unit['id']); target['coverage'].update(coverage)
            for other in touching[1:]:
                target['ids'].extend(other['ids']); target['coverage'].update(other['coverage']); groups.remove(other)
    return [{'memoryIds':g['ids'],'atomIds':sorted(g['coverage'])} for g in groups]


def delivery_projection(doc, candidates, request, tick, max_json_chars=4500, max_items=3, fair=False):
    by_id, sources = archive(doc)
    if any(s['knownTick'] > tick for s in sources.values()): raise ValueError('future knowledge tick')
    context = request['context']
    if context.get('character',{}).get('characterId') != doc['scope']['characterId']:
        raise ValueError('delivery request belongs to another character')
    for candidate in candidates:
        unit = by_id.get(candidate['id'])
        if unit is None: raise ValueError('candidate not in authorized archive')
        allowed = {unit['id']} if unit['memoryLevel']=='event_atom' else set(unit.get('eventAtomIds',unit.get('sourceFactIds',[])))
        for match in candidate.get('matches',[]):
            ids = match['atomIds']
            if not ids or not set(ids) <= allowed: raise ValueError('foreign candidate atom')
            if match['sourceRefs'] != episode.union_refs([by_id[i] for i in ids]):
                raise ValueError('candidate source mapping mismatch')
    recent = {int(o['sourceSeq']) for o in context.get('observations',[]) + context.get('selfObservations',[])}
    clusters = candidate_clusters(candidates, by_id)
    atom_ids = [i for i,u in by_id.items() if u['memoryLevel'] == 'event_atom']
    keys = {i:evidence_key(by_id[i],sources) for i in atom_ids}
    delivered, provenance, omitted = [], [], []
    covered, observations = set(), set()

    def evidence_item(atom, memory_id, level):
        evidence = atom['evidence']
        key = keys[atom['id']]
        actor = (key[2] + '：') if key[2] else ''
        text = '【' + episode.LABELS[key[1]] + '】' + actor + evidence['context']
        ids = [i for i in atom_ids if keys[i] == key]
        refs = atom['sourceRefs']
        return {'memoryId':memory_id,'memoryLevel':level,'text':text,
                'epistemicKind':sources[evidence['sourceId']]['epistemicKind'],
                'sourceIds':[evidence['sourceId']],'sourceAgeTicks':tick-sources[evidence['sourceId']]['knownTick']}, ids, refs

    def commit(items, traces):
        if len(delivered)+len(items)>max_items or chars(delivered+items)>max_json_chars: return False
        delivered.extend(items); provenance.extend(traces)
        return True

    delivery_candidates = candidates
    if fair:
        queues = []
        for candidate in candidates:
            unit = by_id[candidate['id']]
            if unit['memoryLevel'] == 'observation':
                queues.append([candidate]); continue
            if unit['memoryLevel'] == 'event_atom':
                ids = [unit['id']]
            else:
                matched = {}
                for match in candidate.get('matches', []):
                    for row in match.get('atomScores', []):
                        if row['accepted']:
                            matched[row['atomId']] = max(matched.get(row['atomId'], 0), row['relevance'])
                ids = sorted(matched, key=lambda i:(-matched[i],i))
                if not any('atomScores' in m for m in candidate.get('matches', [])):
                    ids = candidate.get('matches', [{}])[0].get('atomIds', [])
            # One complete evidence segment per memory per pass, at most two.
            unique = []
            for ident in ids:
                if keys[ident] not in {keys[i] for i in unique}: unique.append(ident)
            queues.append([{**candidate, '_deliveryAtomIds':[i]} for i in unique[:2]])
        delivery_candidates = [queue[depth] for depth in range(2) for queue in queues if len(queue)>depth]
    for candidate in delivery_candidates:
        unit = by_id[candidate['id']]
        level = unit['memoryLevel']
        if level == 'observation':
            if unit['id'] in observations: continue
            support = [by_id[i] for i in unit['supportingAtomIds']]
            # A mixed citation list cannot lend confirmed status to its unverified parts.
            confirmed = all(a['evidence']['channel'] == 'direct_observation'
                            or (a['evidence']['channel'] == 'action'
                                and a['evidence'].get('executionStatus') == 'accepted') for a in support)
            if not confirmed:
                omitted.append({'memoryId':unit['id'],'reason':'unverified observation summary suppressed; original evidence fallback'})
                scored = {}
                has_scores = False
                for match in candidate.get('matches',[]):
                    has_scores |= 'atomScores' in match
                    for row in match.get('atomScores',[]):
                        if row['accepted'] and row['atomId'] in unit['supportingAtomIds']:
                            scored[row['atomId']] = max(scored.get(row['atomId'],0),row['relevance'])
                support_ids = sorted(scored,key=lambda i:(-scored[i],i)) if has_scores else unit['supportingAtomIds']
                available = [i for i in support_ids if keys[i] not in covered
                             and by_id[i]['sourceRefs'][0]['worldSeq'] not in recent]
                support_present = any(keys[a['id']] in covered or a['sourceRefs'][0]['worldSeq'] in recent for a in support)
                if not available and not support_present:
                    omitted.append({'memoryId':unit['id'],'reason':'no relevant nonrecent evidence for observation fallback'})
                    continue
                # One relevant supporting segment; every missing counter-segment is mandatory.
                ids_to_read = available[:1] + unit['contradictingAtomIds']
                pending, traces, pending_keys = [], [], set()
                for ident in ids_to_read:
                    atom = by_id[ident]
                    if keys[ident] in covered | pending_keys or atom['sourceRefs'][0]['worldSeq'] in recent:
                        continue
                    item, ids, refs = evidence_item(atom,ident,'event_atom')
                    pending.append(item); pending_keys.add(keys[ident])
                    traces.append({'memoryId':ident,'sourceRefs':refs,'coveredAtomIds':ids,
                                   'fallbackObservationId':unit['id'],'retrieval':candidate,
                                   'reason':'counter-evidence for suppressed observation' if ident in unit['contradictingAtomIds'] else 'original evidence for suppressed observation'})
                if commit(pending,traces): covered.update(pending_keys)
                else: omitted.append({'memoryId':unit['id'],'reason':'budget; original evidence and counter-evidence kept together'})
                observations.add(unit['id'])
                continue
            refs = unit['sourceRefs']
            item = {'memoryId':unit['id'],'memoryLevel':level,'text':unit['text'],
                    'epistemicKind':'subjective_inference','sourceIds':[r['sourceId'] for r in refs],
                    'sourceAgeTicks':tick-max(sources[r['sourceId']]['knownTick'] for r in refs)}
            pending, traces, pending_keys = [item], [{'memoryId':unit['id'],'sourceRefs':refs,
                'supportingAtomIds':unit['supportingAtomIds'],'contradictingAtomIds':unit['contradictingAtomIds'],
                'retrieval':candidate}], set()
            # An understanding must not crowd out its counter-evidence.
            for ident in unit['contradictingAtomIds']:
                atom = by_id[ident]
                if keys[ident] in covered | pending_keys or atom['sourceRefs'][0]['worldSeq'] in recent: continue
                counter, ids, counter_refs = evidence_item(atom, ident, 'event_atom')
                pending.append(counter); pending_keys.add(keys[ident])
                traces.append({'memoryId':ident,'sourceRefs':counter_refs,'coveredAtomIds':ids,
                               'reason':'contradicts selected observation'})
            if commit(pending,traces): observations.add(unit['id']); covered.update(pending_keys)
            else: omitted.append({'memoryId':unit['id'],'reason':'budget; observation and counter-evidence kept together'})
            continue
        if level == 'event_atom': selected_ids = [unit['id']]
        else:
            matches = candidate.get('matches',[])
            if '_deliveryAtomIds' in candidate: selected_ids = candidate['_deliveryAtomIds']
            elif matches: selected_ids = matches[0]['atomIds']
            else:
                # Delivery-only diagnostic over the unchanged legacy recall.
                ranked = {c['id']:n for n,c in enumerate(candidates)}
                selected_ids = sorted(unit['eventAtomIds'],key=lambda i:ranked.get(i,len(ranked)))
        for ident in selected_ids:
            atom = by_id.get(ident)
            if atom is None or atom['memoryLevel'] != 'event_atom': raise ValueError('foreign candidate atom')
            if level == 'episode' and ident not in unit['eventAtomIds']: raise ValueError('candidate atom outside episode')
            key = keys[ident]
            if atom['sourceRefs'][0]['worldSeq'] in recent:
                omitted.append({'memoryId':unit['id'],'atomId':ident,'reason':'already in current context'}); continue
            if key in covered:
                omitted.append({'memoryId':unit['id'],'atomId':ident,'reason':'same evidence segment already delivered'}); continue
            item, ids, refs = evidence_item(atom,unit['id'],level)
            trace = {'memoryId':unit['id'],'sourceRefs':refs,'coveredAtomIds':ids,'retrieval':candidate}
            if commit([item],[trace]): covered.add(key)
            else: omitted.append({'memoryId':unit['id'],'atomId':ident,'reason':'budget; complete context not truncated'})
    return {'memories':delivered,'trace':{'scope':doc['scope'],'tick':tick,'clusters':clusters,
        'delivered':provenance,'omitted':omitted,'budget':{'maxJsonChars':max_json_chars,'maxItems':max_items, 'allocation':'one segment per memory per pass; max two' if fair else 'fusion order','conservativeObservations':True},
        'jsonChars':chars(delivered),'distinctEvidenceSegments':len(covered)}}
