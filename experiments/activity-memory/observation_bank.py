"""Synthetic 20-understanding bank: cheap shortlist vs one independent JEV batch."""
import copy
import hashlib
import json
import math
import random
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import core_bridge as bridge
import jev_applicability as jev
import retrieval_text
import numpy as np
import importlib.util

spec = importlib.util.spec_from_file_location('applicability_projection', Path(__file__).with_name('observation-applicability.py'))
projection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(projection)
FIELDS = ('contexts', 'conditions', 'exceptions', 'themes')


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def check_facets(facets, text, people):
    if not isinstance(facets, dict) or set(facets) != {'subjects', *FIELDS}:
        raise ValueError('invalid bank applicability fields')
    if not isinstance(facets['subjects'], list) or not facets['subjects']:
        raise ValueError('bank subject missing')
    for person in facets['subjects']:
        if not isinstance(person, dict) or set(person) != {'name', 'characterId'} or person not in people or person['name'] not in text:
            raise ValueError('bank subject identity not grounded or authorized')
    for field in FIELDS:
        phrases = facets[field]
        if not isinstance(phrases, list) or len(phrases) > 6 or any(not isinstance(p, str) or not p.strip() or len(p) > 60 for p in phrases):
            raise ValueError('invalid bank applicability phrase')


def prepare(doc):
    original, frozen, authorized, fixture = doc['archive'], doc['projection'], doc['authorized'], doc['fixture']
    bridge.episode.validate_units(original)
    bridge.core.check_sources(authorized)
    if frozen['archiveHash'] != digest(original) or authorized['scope']['characterId'] != original['scope']['characterId'] or authorized['scope']['worldAddress'] != original['scope']['worldAddress']:
        raise ValueError('bank crosses frozen archive scope')
    old_ids = {s['sourceId'] for s in original['sources']}
    if original['sources'] != [s for s in authorized['sources'] if s['sourceId'] in old_ids]:
        raise ValueError('frozen authorized evidence changed')
    if len(fixture['entries']) != 20 or len({r['memoryId'] for r in fixture['entries']}) != 20:
        raise ValueError('requires 20 distinct authored understandings')
    archive = copy.deepcopy(original)
    archive.update(scope=copy.deepcopy(authorized['scope']), sources=copy.deepcopy(authorized['sources']))
    target = next(o for o in original['observations'] if o['id'] == fixture['targetId'])
    if frozen['observationTextHash'] != digest(target['text']):
        raise ValueError('target understanding changed')
    archive['observations'] = [copy.deepcopy(target)]
    people = frozen['generationInput']['allowedPeople']
    for row in fixture['entries'][1:]:
        sources = [s for s in authorized['sources'] if s['knownTick'] == row['tick'] and s['text'] == row['evidence']]
        if len(sources) != 1 or sources[0]['epistemicKind'] != 'direct_observation':
            raise ValueError('synthetic understanding lacks its exact authorized source')
        source = sources[0];segment = bridge.episode.segments(source)[0]
        atom = bridge.episode.make_atom(source, segment, segment['context'], 0)
        atom = bridge.timed([atom], archive['sources'])[0]
        episode_id = 'episode:' + row['memoryId']
        episode = {'id': episode_id, 'kind': 'episode', 'memoryLevel': 'episode',
                   'label': 'synthetic bank evidence', 'eventAtomIds': [atom['id']], 'eventAtoms': [copy.deepcopy(atom)],
                   'sourceRefs': atom['sourceRefs'], 'text': bridge.episode.episode_text([atom])}
        archive['facts'].append(atom)
        archive['episodes'].extend(bridge.timed([episode], archive['sources']))
        archive['observations'].extend(bridge.timed([{
            'id': row['memoryId'], 'kind': 'observation', 'memoryLevel': 'observation',
            'epistemicKind': 'subjective_inference', 'text': row['text'],
            'supportingAtomIds': [atom['id']], 'contradictingAtomIds': [], 'sourceFactIds': [atom['id']],
            'episodeIds': [episode_id], 'eventAtoms': [copy.deepcopy(atom)], 'sourceRefs': atom['sourceRefs']}], archive['sources']))
    bridge.episode.validate_units(archive)
    aliases = retrieval_text.alias_table(archive, [{'scope': archive['scope'], 'worldSeq': original['scope']['asOfWorldSeq'], 'people': people}])
    # Ordinary experience search stays on the original frozen windows, with an updated source scope.
    index = copy.deepcopy(doc['index'])
    index.update(scope=archive['scope'], sources=archive['sources'], retrievalAliases=aliases)
    bridge.vector_core.check_mapping(index, index['units'])
    facet_by_id = {target['id']: copy.deepcopy(frozen['facets'])}
    generation_inputs = []
    pending = [{'memoryId': o['id'], 'observationText': o['text']} for o in archive['observations'] if o['id'] != target['id']]
    prompt = projection.PROMPT + (' For this batch, return JSON {"items":[{"memoryId":"...",'
             '"subjects":[],"contexts":[],"conditions":[],"exceptions":[],"themes":[]}]}. '
             'Derive each independently from its own observationText. No test stimuli or evaluation labels are supplied.')
    for offset in range(0, len(pending), 5):
        batch = pending[offset:offset + 5]
        payload = {'items': batch, 'allowedPeople': people}
        generation_inputs.append(copy.deepcopy(payload))
        answer = bridge.utility_llm(prompt, json.dumps(payload, ensure_ascii=False), 5000)
        if not isinstance(answer, dict) or set(answer) != {'items'} or not isinstance(answer['items'], list):
            raise ValueError('invalid bank projection batch')
        expected = {r['memoryId']: r['observationText'] for r in batch}
        if len(answer['items']) != len(expected) or {r.get('memoryId') for r in answer['items']} != set(expected):
            raise ValueError('bank projection batch missing or duplicated IDs')
        for item in answer['items']:
            ident = item['memoryId'];facets = {k:v for k,v in item.items() if k != 'memoryId'}
            check_facets(facets, expected[ident], people)
            facet_by_id[ident] = facets
    entries = []
    for understanding in archive['observations']:
        ident = understanding['id'];facets = facet_by_id[ident]
        check_facets(facets, understanding['text'], people)
        body = retrieval_text.clean(understanding['text'], aliases)
        fields = {f:retrieval_text.clean('；'.join(facets[f]), aliases) for f in FIELDS}
        if any(bridge.projections.token_counter()(t) > 220 for t in [body, *fields.values()]):
            raise ValueError('bank projection exceeds E5 window')
        vectors = bridge.vector_core.encode([body, *fields.values()], archive['scope'])
        entries.append({'memoryId':ident, 'facets':facets, 'bodyText':body, 'fieldTexts':fields,
                        'bodyVector':vectors[0].tolist(), 'fieldVectors':{f:v.tolist() for f,v in zip(FIELDS,vectors[1:])},
                        'sourceRefs':understanding['sourceRefs']})
    result = {'archive':archive, 'index':index, 'entries':entries,
              'baseArchiveHash':digest(original), 'fixtureHash':digest(fixture), 'fixture':fixture,
              'generationInputs':generation_inputs, 'generationPrompt':prompt,
              'rules':{'subjectGraph':'explicit actor/mentioned ID -> subject ID -> understanding; no semantic or temporal graph expansion',
                       'semantic':'max(body, four nonempty fields), one semantic ranking per memory',
                       'bm25':'cleaned body and all facets; same authorized name cleanup; Chinese bigrams',
                       'fusion':'RRF k=60 over semantic/BM25; subject graph eligibility only',
                       'shortlistLimit':fixture['shortlistLimit'], 'scoreGate':'none; top-K is only a cheap candidate budget',
                       'sizes':fixture['sizes'], 'repeats':fixture['classificationRepeats'],
                       'delivery':'existing projection; 3 items; RELATED original texts only',
                       'labels':'evaluation only; never sent to either model'}}
    result['contentHash'] = digest(result)
    return result


def validate(doc):
    bank = doc['prepared']
    if bank['contentHash'] != digest({k:v for k,v in bank.items() if k != 'contentHash'}):
        raise ValueError('bank projection changed')
    if bank['baseArchiveHash'] != doc['projection']['archiveHash']:
        raise ValueError('bank belongs to another frozen archive')
    bridge.episode.validate_units(bank['archive'])
    bridge.vector_core.check_mapping(bank['index'], bank['index']['units'])
    if doc['archive'] != bank['archive'] or doc['index'] != bank['index']:
        raise ValueError('request bank archive or index differs')
    observations = {o['id']:o for o in bank['archive']['observations']}
    if set(observations) != {r['memoryId'] for r in bank['entries']}:
        raise ValueError('bank projections do not cover all understandings')
    for entry in bank['entries']:
        if entry['sourceRefs'] != observations[entry['memoryId']]['sourceRefs']:
            raise ValueError('bank source mapping changed')
    return bank


def trigger(bank, query):
    started = time.perf_counter()
    entries = bank['entries']
    qv = bridge.vector_core.encode([query['semanticQuery']], bank['archive']['scope'], True)[0]
    terms = set(query['keywordTerms'])
    bags = {r['memoryId']: Counter(bridge.queries.lexical_terms(r['bodyText'] + ' ' + ' '.join(r['fieldTexts'].values()))) for r in entries}
    df = Counter(t for b in bags.values() for t in b)
    n = len(bags);average = sum(sum(b.values()) for b in bags.values()) / n
    idf = {t:math.log(1+(n-df[t]+.5)/(df[t]+.5)) for t in terms}
    seeds = {e['id'] for e in query['entitySeeds'] if set(e['roles']) & {'actor','mentioned'}}
    rows = []
    for entry in entries:
        ident = entry['memoryId'];bag = bags[ident]
        subjects = {s['characterId'] for s in entry['facets']['subjects'] if s['characterId'] is not None}
        def cosine(vector):
            v = np.asarray(vector,dtype=np.float32)
            return float(v @ qv / max(np.linalg.norm(v) * np.linalg.norm(qv), 1e-9))
        signals = {'body':cosine(entry['bodyVector']),
                   **{f:cosine(entry['fieldVectors'][f]) for f in FIELDS if entry['fieldTexts'][f]}}
        matched = sorted(t for t in terms if bag[t])
        bm = sum(idf[t]*bag[t]*2.5/(bag[t]+1.5*(.25+.75*sum(bag.values())/max(average,1))) for t in matched)
        rows.append({'memoryId':ident, 'subjectIds':sorted(subjects), 'matchedSubjectIds':sorted(subjects & seeds),
                     'subjectMatched':bool(subjects & seeds), 'fieldCosines':signals,
                     'semanticSimilarity':max(signals.values()), 'bm25Score':bm, 'matchedTerms':matched})
    eligible = [r for r in rows if r['subjectMatched']]
    semantic = sorted(eligible,key=lambda r:(-r['semanticSimilarity'],r['memoryId']))
    lexical = sorted([r for r in eligible if r['bm25Score'] > 0],key=lambda r:(-r['bm25Score'],r['memoryId']))
    sr = {r['memoryId']:i+1 for i,r in enumerate(semantic)}
    br = {r['memoryId']:i+1 for i,r in enumerate(lexical)}
    for row in rows:
        ident = row['memoryId']
        row.update(semanticRank=sr.get(ident),bm25Rank=br.get(ident),
                   rrfScore=(1/(60+sr[ident]) if ident in sr else 0)+(1/(60+br[ident]) if ident in br else 0))
    rows.sort(key=lambda r:(-r['rrfScore'],-r['semanticSimilarity'],r['memoryId']))
    return rows, (time.perf_counter() - started) * 1000


def deliver(bank, baseline, request, tick, related, scores, route):
    archive = bank['archive']
    by_id = {o['id']:o for o in archive['observations']}
    candidates = [c for c in baseline['retrieval']['results'] if c['id'] not in by_id]
    for ident in related:
        unit = by_id[ident];score = scores[ident]
        candidates.append({'id':ident,'relevance':score['rrfScore'],'score':score['semanticSimilarity'],
                           'selectionMethod':'bank_' + route + '_jev',
                           'matches':[{'representationId':'applicability:' + ident,
                                       'atomIds':unit['sourceFactIds'],'sourceRefs':unit['sourceRefs']}]})
    # Independent RELATED decisions still need a reading order, identical across A/B.
    candidates.sort(key=lambda c:(-c['relevance'],-c['score'],c['id']))
    for rank, candidate in enumerate(candidates,1):candidate['rank'] = rank
    delivered = bridge.activity.deliver(archive, candidates, request, tick, baseline['query'])
    return candidates, delivered


def recall(doc):
    bank = validate(doc)
    baseline = bridge.dispatch({**doc,'operation':'recall'})
    query = baseline['query']
    rows, trigger_ms = trigger(bank,query)
    score_by_id = {r['memoryId']:r for r in rows}
    entries = {r['memoryId']:r for r in bank['entries']}
    observations = {o['id']:o for o in bank['archive']['observations']}
    stimulus = {'text':query['originalText'],
                'actorIds':[e['id'] for e in query['entitySeeds'] if 'actor' in e['roles']],
                'mentionedIds':[e['id'] for e in query['entitySeeds'] if 'mentioned' in e['roles']]}
    fixture = bank['fixture'];matrix = [];chosen = None
    ids = [r['memoryId'] for r in fixture['entries']]
    for size in fixture['sizes']:
        subset = ids[:size]
        shortlist = [r['memoryId'] for r in rows if r['memoryId'] in subset and r['subjectMatched']][:fixture['shortlistLimit']]
        for repeat in range(fixture['classificationRepeats']):
            for route in (['all','trigger'] if repeat % 2 == 0 else ['trigger','all']):
                selected = list(subset if route == 'all' else shortlist)
                random.Random(fixture['randomSeed'] + size*100 + repeat).shuffle(selected)
                candidates = [{'memoryId':ident,'understanding':observations[ident]['text'],'applicability':entries[ident]['facets']} for ident in selected]
                if candidates and query['mode'] == 'search':
                    decision = jev.assess_many(stimulus,candidates)
                else:
                    selected = []
                    decision = {'answers':{},'model':None,'usage':{},'latencyMs':0}
                related = [ident for ident in selected if decision['answers'][ident]['related']]
                ranked, delivered = deliver(bank,baseline,doc['request'],doc['tick'],related,score_by_id,route)
                row = {'size':size,'repeat':repeat,'route':route,'bankIds':subset,'shortlistIds':shortlist,
                       'sentIds':selected,'decision':decision,'relatedIds':related,
                       'rankedCandidateIds':[c['id'] for c in ranked],
                       'delivery':delivered['memories'],'deliveryTrace':delivered['trace'],
                       'triggerLatencyMs':trigger_ms if route == 'trigger' else 0}
                matrix.append(row)
                if size == 20 and repeat == 0 and route == 'trigger':
                    chosen = (ranked,delivered)
    assert chosen is not None
    candidates,delivered = chosen
    return {'query':query, 'retrieval':{**baseline['retrieval'],'baseResults':baseline['retrieval']['results'],
                'results':candidates,'bankEvaluation':{'rows':matrix,'triggerScores':rows,'stimulus':stimulus,
                'contentHash':bank['contentHash'],'selectedBehaviorRoute':'trigger/20/repeat0',
                'allRouteDoesNotUseSubjectGate':True,'classifierNeverReceivesLabelsOrScores':True}},
            'delivery':delivered['memories'],'deliveryTrace':delivered['trace']}


if __name__ == '__main__':
    doc = json.load(sys.stdin)
    json.dump(prepare(doc) if doc['operation'] == 'prepare' else recall(doc), sys.stdout, ensure_ascii=False)
