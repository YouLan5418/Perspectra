"""Experimental Source -> Event Atom -> Episode -> Observation adapter.

Atoms replace freely paraphrased facts. Episodes organize atoms, never assert that
all mentioned actions happened. Only authorized source snapshots enter this module.
"""
from __future__ import annotations
import copy
import json
import re
import sys
import core

MARKER = re.compile(r"(?:^|; )(?:(character:[a-z0-9_-]+) (said: |published narration \(not an adjudicated outcome\): |appeared: )|original player input \(interpretation evidence, not an adjudicated outcome\): )")
LABELS = {
    'speech': '听到发言；所述内容未经独立核实',
    'narration': '外显叙述；不是规则裁定结果',
    'player_input': '原始玩家输入；不是行动成功证据',
    'appearance': '观察到外显表现；不证明物品转移或移动',
    'action': '本角色获准看到的行动结果',
    'reported_speech': '转述来源；内容未经独立核实',
    'self_intention': '自身意图；不代表已执行',
    'subjective_inference': '已有主观推断；不是客观事实',
    'direct_observation': '本角色的直接观察',
    'observed_action': '本角色的行动观察；不补充未提供的执行结果',
}


def segments(source):
    text = source['text']
    # Recognize the existing host renderer, not arbitrary natural-language actors.
    matches = list(MARKER.finditer(text))
    if matches and matches[0].start() == 0:
        result = []
        for i, match in enumerate(matches):
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            payload = text[match.end():end]
            token = match.group(2) or ''
            channel = ('speech' if token == 'said: ' else 'narration' if token.startswith('published')
                       else 'appearance' if token == 'appeared: ' else 'player_input')
            if payload.strip():
                result.append({'id': source['sourceId'] + '/part:' + str(i), 'channel': channel,
                               'actorId': match.group(1), 'context': payload})
        return result
    if source['epistemicKind'] == 'observed_action':
        try:
            value = json.loads(text)
        except (ValueError, TypeError):
            value = None
        if isinstance(value, dict) and value.get('status') in {'accepted', 'rejected'}:
            # Drop interpretation evidence/reasons from the action-result projection.
            # Keep the complete original Source separately and never invent an outcome.
            outcome = {k: value[k] for k in ('actorId', 'actionType', 'status', 'movement', 'interaction') if k in value}
            return [{'id': source['sourceId'] + '/part:0', 'channel': 'action',
                     'actorId': value.get('actorId'), 'context': json.dumps(outcome, ensure_ascii=False, sort_keys=True),
                     'executionStatus': value['status']}]
    return [{'id': source['sourceId'] + '/part:0', 'channel': source['epistemicKind'],
             'actorId': None, 'context': text}]


def atom_text(atom):
    evidence = atom['evidence']
    actor = (evidence.get('actorId') + '：') if evidence.get('actorId') else ''
    text = '【' + LABELS[evidence['channel']] + '】' + actor + evidence['quote']
    if evidence['quote'] != evidence['context']:
        text += '\n【完整引用语境；保留否定、条件和不确定性】' + evidence['context']
    return text


def make_atom(source, segment, quote, number):
    evidence = {**segment, 'sourceId': source['sourceId'], 'quote': quote}
    atom = {'id': 'atom:' + source['sourceId'] + ':' + str(number), 'kind': 'fact',
            'memoryLevel': 'event_atom', 'evidence': evidence, 'evidenceQuote': quote,
            'sourceRefs': [core.source_ref(source)],
            'entities': sorted(set(re.findall(r'(?:character|entity|location):[a-z0-9_-]+', quote)))}
    atom['text'] = atom_text(atom)
    return atom


def union_refs(atoms):
    refs = {}
    for atom in atoms:
        for ref in atom['sourceRefs']:
            refs[ref['sourceId']] = copy.deepcopy(ref)
    return sorted(refs.values(), key=lambda ref: (ref['worldSeq'], ref['sourceId']))


def check_atom(atom, sources):
    if atom.get('kind') != 'fact' or atom.get('memoryLevel') != 'event_atom':
        raise ValueError('not an Event Atom')
    refs = atom['sourceRefs']
    if len(refs) != 1 or refs[0]['sourceId'] not in sources:
        raise ValueError('atom must cite one authorized source')
    source = sources[refs[0]['sourceId']]
    if refs != [core.source_ref(source)] or atom['evidence'].get('sourceId') != source['sourceId']:
        raise ValueError('atom source mapping mismatch')
    evidence = atom['evidence']
    matching = [s for s in segments(source) if s['id'] == evidence.get('id')]
    if len(matching) != 1:
        raise ValueError('atom segment missing')
    segment = matching[0]
    if any(evidence.get(k) != v for k, v in segment.items()):
        raise ValueError('atom evidence context or attribution changed')
    quote = evidence.get('quote')
    if not isinstance(quote, str) or not quote.strip() or quote not in segment['context']:
        raise ValueError('atom quote not in evidence context')
    if segment['channel'] == 'action' and quote != segment['context']:
        raise ValueError('action atom cannot omit execution status')
    if atom.get('text') != atom_text(atom) or atom.get('evidenceQuote') != quote:
        raise ValueError('atom text does not match evidence')
    return atom


def episode_text(atoms):
    return '【同一段经历的分组；各项证据独立，不表示全部行动已完成】\n' + '\n'.join(
        '[' + atom['id'] + '] ' + atom['text'] for atom in atoms)


def validate_units(doc, units=None):
    sources = {s['sourceId']: s for s in core.check_sources(doc)}
    units = core.check_units(doc) if units is None else units
    canonical = {u['id']: u for u in units if u.get('memoryLevel') == 'event_atom'}
    for unit in units:
        if unit.get('memoryLevel') == 'event_atom':
            check_atom(unit, sources)
        elif unit.get('memoryLevel') in {'episode', 'observation'}:
            atoms = unit.get('eventAtoms', [])
            if not atoms or len({a['id'] for a in atoms}) != len(atoms):
                raise ValueError('aggregate must contain distinct evidence atoms')
            for atom in atoms:
                check_atom(atom, sources)
                if atom['id'] in canonical and any(atom.get(k) != canonical[atom['id']].get(k) for k in ('id', 'text', 'evidence', 'evidenceQuote', 'sourceRefs')):
                    raise ValueError('aggregate changed lower-level atom')
            ids = [a['id'] for a in atoms]
            if unit['sourceRefs'] != union_refs(atoms):
                raise ValueError('aggregate source mapping not equal to cited atoms')
            if unit['memoryLevel'] == 'episode':
                if unit.get('eventAtomIds') != ids or unit['text'] != episode_text(atoms):
                    raise ValueError('episode cannot rewrite atom contents')
            else:
                support, counter = unit.get('supportingAtomIds', []), unit.get('contradictingAtomIds', [])
                if not support or set(support) & set(counter) or set(ids) != set(support + counter):
                    raise ValueError('observation evidence mismatch')
                if unit.get('sourceFactIds') != support + counter or not unit['text'].startswith('【主观认识，可修正】'):
                    raise ValueError('observation lost its subjective/evidence framing')
                if unit.get('epistemicKind') != 'subjective_inference':
                    raise ValueError('observation must be subjective inference')
    return units


def complete_quote(context, quote):
    start = context.find(quote)
    end = start + len(quote)
    boundaries = '。！？!?\n'
    return start >= 0 and (start == 0 or context[:start].rstrip()[-1:] in boundaries) and (end == len(context) or quote[-1:] in boundaries)


def retain(doc):
    sources = core.check_sources(doc)
    by_source = {s['sourceId']: s for s in sources}
    parts = [{**p, 'sourceId': s['sourceId'], 'epistemicKind': s['epistemicKind']} for s in sources for p in segments(s)]
    # Full action-result atoms are deterministic; only narrative segmentation uses the LLM.
    prose = [p for p in parts if p['channel'] != 'action']
    selection = {'atoms': []}
    if prose:
        selection = core.llm(
            'Split authorized evidence into minimal semantic Event Atoms. Return JSON '
            '{"atoms":[{"segment_id":"...","quote":"exact verbatim span"}]}. '
            'An atom is one statement, invitation, answer, intention or visible expression, not an entire episode. '
            'Only SELECT quotes; never paraphrase or add actors, causality, intentions, certainty or completion. '
            'Quotes must consist of whole sentences, not fragments inside a sentence. '
            'Keep negation, modality and antecedents; if unsure quote the whole segment. '
            'Speech contents remain claims; narration is not an adjudicated action. Grouping comes later.',
            json.dumps(prose, ensure_ascii=False), 2500)
    by_part = {p['id']: p for p in parts}
    picked, rejected = {}, 0
    for item in selection.get('atoms', []):
        part = by_part.get(item.get('segment_id')) if isinstance(item, dict) else None
        quote = item.get('quote') if isinstance(item, dict) else None
        if part is None or part['channel'] == 'action' or not isinstance(quote, str) or not quote.strip() or not complete_quote(part['context'], quote):
            rejected += 1
            continue
        picked.setdefault(part['id'], [])
        if quote not in picked[part['id']]:
            picked[part['id']].append(quote)
    atoms, counts, fallback = [], {}, 0
    for part in parts:
        quotes = picked.get(part['id']) or [part['context']]
        fallback += int(part['channel'] != 'action' and part['id'] not in picked)
        for quote in quotes:
            source = by_source[part['sourceId']]
            number = counts.get(source['sourceId'], 0)
            counts[source['sourceId']] = number + 1
            segment = {k: v for k, v in part.items() if k not in {'sourceId', 'epistemicKind'}}
            atoms.append(make_atom(source, segment, quote, number))
    result = {'scope': core.check_scope(doc), 'sources': sources, 'facts': atoms,
              'representations': [{'id': 'raw:' + s['sourceId'], 'kind': 'representation', 'text': s['text'],
                                   'sourceRefs': [core.source_ref(s)], 'entities': []} for s in sources],
              'stats': {'atomCount': len(atoms), 'rejectedSelections': rejected, 'wholeSegmentFallbacks': fallback}}
    validate_units(result)
    return result


def group(doc):
    validate_units(doc)
    atoms = {a['id']: a for a in doc['facts']}
    episodes = copy.deepcopy(doc.get('episodes', []))
    assigned = {ident for e in episodes for ident in e['eventAtomIds']}
    incoming = [a for a in doc['facts'] if a['id'] not in assigned]
    if not incoming:
        return {'scope': doc['scope'], 'episodes': episodes, 'actions': []}
    answer = core.llm(
        'Organize Event Atoms into Episodes for ONE character. An Episode is an experience, not a world Event. '
        'Return JSON {"groups":[{"episode_id":null,"label":"short topic label", "atom_ids":["..."]}]}. '
        'Use an existing episode_id only for a concrete continuation of that same activity. '
        'Same people/place/topic do not imply the same episode. A later similar activity is separate. '
        'Never rewrite atoms or infer that reported/planned/narrated actions happened. '
        'Labels are grouping hints only. If a connection is unclear make separate episodes.',
        json.dumps({'newAtoms': incoming, 'existingEpisodes': episodes}, ensure_ascii=False), 2300)
    by_episode = {e['id']: e for e in episodes}
    new_ids, used, accepted = {a['id'] for a in incoming}, set(), []
    def add(episode_id, label, ids):
        nonlocal episodes
        if episode_id is None:
            number = max([int(e['id'].split(':')[-1]) for e in episodes] or [0]) + 1
            episode_id = 'episode:' + str(number)
            episode = {'id': episode_id, 'kind': 'episode', 'memoryLevel': 'episode',
                       'label': label if isinstance(label, str) else '', 'eventAtomIds': []}
            episodes.append(episode)
            by_episode[episode_id] = episode
        episode = by_episode[episode_id]
        members = set(episode['eventAtomIds']) | set(ids)
        ordered = sorted((atoms[i] for i in members), key=lambda a: (a['sourceRefs'][0]['worldSeq'], a['id']))
        episode.update(eventAtomIds=[a['id'] for a in ordered], eventAtoms=copy.deepcopy(ordered),
                       sourceRefs=union_refs(ordered), text=episode_text(ordered))
        used.update(ids)
        accepted.append({'episodeId': episode_id, 'addedAtomIds': ids})
    for item in answer.get('groups', []):
        if not isinstance(item, dict): continue
        ids, ident = item.get('atom_ids'), item.get('episode_id')
        if (not isinstance(ids, list) or not ids or len(set(ids)) != len(ids)
                or any(i not in new_ids or i in used for i in ids)
                or (ident is not None and ident not in by_episode)):
            continue
        add(ident, item.get('label', ''), ids)
    for atom in incoming:
        if atom['id'] not in used:
            add(None, '', [atom['id']])
    result = {'scope': doc['scope'], 'episodes': episodes, 'actions': accepted}
    validate_units({**doc, 'episodes': episodes})
    return result


def consolidate(doc):
    validate_units(doc)
    atoms = {a['id']: a for a in doc['facts']}
    existing = copy.deepcopy(doc.get('observations', []))
    if not atoms: return {'scope': doc['scope'], 'observations': existing, 'actions': []}
    answer = core.llm(
        'Form revisable SUBJECTIVE Observations for one character from Episodes and their Event Atoms. '
        'Return JSON {"observations":[{"observation_id":null,"text":"subjective understanding",'
        '"supporting_atom_ids":["..."],"contradicting_atom_ids":["..."]}]}. '
        'An existing observation_id updates that understanding. Re-read its ORIGINAL atoms, not just its old summary. '
        'Cite only atoms that support or challenge this particular understanding, not an entire Episode. '
        'Prefer durable preferences/relationship impressions/uncertainties over timeline recaps. '
        'Repeated speech/narration/player-input from one source is not independent corroboration or repeated experience. '
        'Preserve speakers, negation, uncertainty, reports versus observation, intention versus execution. '
        'An Episode never establishes that all its actions happened. No motive or causal assertion without evidence. '
        'A mistaken report does not prove lying. Never instruct future behavior or rewrite evidence. '
        'Return an empty list if no useful understanding is warranted.',
        json.dumps({'episodes': doc.get('episodes', []), 'atoms': doc['facts'],
                    'existingObservationsWithEvidence': existing,
                    'mission': doc.get('observationsMission', '')}, ensure_ascii=False), 2300)
    by_obs = {o['id']: o for o in existing}
    accepted = []
    for item in answer.get('observations', []):
        if not isinstance(item, dict): continue
        support, counter = item.get('supporting_atom_ids'), item.get('contradicting_atom_ids', [])
        ident, text = item.get('observation_id'), item.get('text')
        if (not isinstance(text, str) or not text.strip() or not isinstance(support, list) or not support
                or not isinstance(counter, list) or set(support) & set(counter)
                or any(i not in atoms for i in support + counter)
                or (ident is not None and ident not in by_obs)):
            continue
        if ident is None:
            number = max([int(i.split(':')[-1]) for i in by_obs] or [0]) + 1
            ident = 'obs:' + str(number)
        support, counter = list(dict.fromkeys(support)), list(dict.fromkeys(counter))
        cited = [atoms[i] for i in support + counter]
        by_obs[ident] = {'id': ident, 'kind': 'observation', 'memoryLevel': 'observation',
                        'epistemicKind': 'subjective_inference', 'text': '【主观认识，可修正】' + text.strip(),
                        'supportingAtomIds': support, 'contradictingAtomIds': counter,
                        'sourceFactIds': support + counter,
                        'episodeIds': [e['id'] for e in doc.get('episodes', []) if set(e['eventAtomIds']) & set(support + counter)],
                        'eventAtoms': copy.deepcopy(cited),
                        'sourceRefs': union_refs(cited)}
        accepted.append({'observationId': ident, 'supportingAtomIds': support, 'contradictingAtomIds': counter})
    result = {'scope': doc['scope'], 'observations': list(by_obs.values()), 'actions': accepted}
    validate_units({**doc, 'observations': result['observations']})
    return result


def main():
    doc = json.load(sys.stdin)
    result = {'retain': retain, 'group': group, 'consolidate': consolidate, 'recall': core.recall}[doc['operation']](doc)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__': main()
