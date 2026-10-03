"""Experimental subject + field retrieval; no changes to authoritative data."""
import copy
import json
import math
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import core_bridge as bridge
import retrieval_text
import jev_applicability
import numpy as np

FIELDS = ('contexts', 'conditions', 'exceptions', 'themes')
DECISIVE_FIELDS = ('contexts', 'exceptions')
JUDGE_PROMPT = (
    'Assess SEARCH APPLICABILITY only for one character-owned, revisable subjective understanding. '
    'Return JSON {"related":true,"matchedFields":["contexts"],"stimulusQuotes":["exact substring"],"reason":"brief relevance explanation"}. '
    'Determine whether this understanding could inform the response to the current stimulus. '
    'A matching familiar exception is relevant too; do not require the risky condition to hold. '
    'Same person alone, generic social talk, or superficial word overlap is insufficient. '
    'Use only the supplied current stimulus, understanding and frozen applicability fields. '
    'Never decide whether the understanding is true, infer new facts, or prescribe what the character should say or do. '
    'Do not generate action advice, role dialogue or instructions. '
    'If related, cite at least one exact stimulus substring and one of contexts/conditions/exceptions/themes. '
    'If unrelated, return empty matchedFields and stimulusQuotes. Reasons describe relevance only.'
)


def validate(doc):
    if doc.get('judge') and doc.get('judgeBackend', 'gemini') not in ('gemini', 'jev'):
        raise ValueError('unknown applicability judge backend')
    archive, index, frozen = doc['archive'], doc['index'], doc['projection']
    bridge.episode.validate_units(archive)
    bridge.vector_core.check_mapping(index, index['units'])
    if archive['scope'] != index['scope'] or frozen['index']['scope'] != archive['scope']:
        raise ValueError('facet projection scope mismatch')
    target = next(o for o in archive['observations'] if o['id'] == doc['targetObservation'])
    import hashlib
    def digest(value):
        return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    if frozen['archiveHash'] != digest(archive) or frozen['observationTextHash'] != digest(target['text']):
        raise ValueError('frozen applicability belongs to different archive or understanding')
    identities = frozen['generationInput']['allowedPeople']
    facets = frozen['facets']
    for subject in facets['subjects']:
        if subject['characterId'] is not None and subject not in identities:
            raise ValueError('subject identity not authorized')
        if subject['name'] not in target['text']:
            raise ValueError('subject not named in understanding')
    return target, facets


def prepare(doc):
    target, facets = validate(doc)
    index = doc['index']
    text = {field: retrieval_text.clean('；'.join(facets[field]), index['retrievalAliases']) for field in FIELDS}
    if any(bridge.projections.token_counter()(value) > 220 for value in text.values()):
        raise ValueError('facet exceeds original token budget')
    vectors = bridge.vector_core.encode([text[field] for field in FIELDS], index['scope'])
    return {'scope': index['scope'], 'memoryId': target['id'], 'sourceRefs': target['sourceRefs'],
            'archiveHash': doc['projection']['archiveHash'], 'observationTextHash': doc['projection']['observationTextHash'],
            'subjects': copy.deepcopy(facets['subjects']), 'fieldTexts': text,
            'fieldVectors': {field: vector.tolist() for field, vector in zip(FIELDS, vectors)},
            'rules': {'decisiveFields': list(DECISIVE_FIELDS), 'subjectRequired': True,
                      'semanticMin': 0.30, 'semanticLiftMin': 0.30, 'keywordCoverageMin': 0.15,
                      'background': 'unchanged original index query median',
                      'subjectSeeds': 'actor or explicitly mentioned character; scene/addressee alone excluded',
                      'aggregation': 'max across fields; one candidate per memory, no added RRF votes'},
            'selectionMethod': ('subject_and_jev_applicability' if doc.get('judgeBackend') == 'jev' else
                                'subject_and_model_applicability') if doc.get('judge') else 'subject_and_facet_retrieval'}


def recall(doc):
    target, _ = validate(doc)
    prepared = doc['prepared']
    if prepared != prepare(doc):
        raise ValueError('prepared field vectors or mapping changed')
    baseline = bridge.dispatch({**doc, 'operation': 'recall'})
    query, retrieval = baseline['query'], baseline['retrieval']
    index = doc['index']
    subjects = {s['characterId'] for s in prepared['subjects'] if s['characterId'] is not None}
    seeds = {e['id'] for e in query['entitySeeds'] if set(e['roles']) & {'actor', 'mentioned'}}
    shared = sorted(subjects & seeds)
    rule = prepared['rules']
    background = retrieval.get('thresholds', {}).get('queryBackgroundMedian')
    signals = []
    if query['mode'] == 'search' and background is not None:
        qv = bridge.vector_core.encode([query['semanticQuery']], index['scope'], True)[0]
        terms = set(query['keywordTerms'])
        corpus = [Counter(bridge.queries.lexical_terms(u.get('retrievalText', u['text']))) for u in index['units']]
        df = Counter(t for bag in corpus for t in bag)
        n = len(corpus)
        idf = {term: math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5)) for term in terms}
        total = sum(idf.values())
        for field in FIELDS:
            value = np.asarray(prepared['fieldVectors'][field], dtype=np.float32)
            cosine = float(value @ qv / max(np.linalg.norm(value) * np.linalg.norm(qv), 1e-9))
            lift = max(0.0, (cosine - background) / max(1 - background, 1e-9))
            bag = Counter(bridge.queries.lexical_terms(prepared['fieldTexts'][field]))
            matched = sorted(t for t in terms if bag[t])
            coverage = sum(idf[t] for t in matched) / total if total else 0.0
            content_accepted = cosine >= rule['semanticMin'] and lift >= rule['semanticLiftMin'] or coverage >= rule['keywordCoverageMin']
            signals.append({'field': field, 'text': prepared['fieldTexts'][field], 'semanticSimilarity': cosine,
                            'semanticLift': lift, 'keywordCoverage': coverage, 'matchedTerms': matched,
                            'relevance': max(lift, coverage), 'contentAccepted': content_accepted,
                            'canAdmit': field in rule['decisiveFields']})
    winners = [s for s in signals if s['canAdmit'] and s['contentAccepted']]
    accepted = bool(shared and winners)
    judge_input, judged = None, None
    if doc.get('judge'):
        # Independent classifier admission experiment, not a lower cosine threshold.
        accepted = False
        if shared and query['mode'] == 'search':
            judge_input = {'stimulus': query['originalText'], 'understanding': target['text'],
                           'applicability': doc['projection']['facets']}
            if doc.get('judgeBackend') == 'jev':
                judged = jev_applicability.validate_decision(jev_applicability.assess(judge_input))
            else:
                bridge.core.llm = bridge.utility_llm
                judged = bridge.core.llm(JUDGE_PROMPT, json.dumps(judge_input, ensure_ascii=False), 1000)
            if doc.get('judgeBackend') != 'jev' and (set(judged) != {'related', 'matchedFields', 'stimulusQuotes', 'reason'}
                    or type(judged['related']) is not bool
                    or not isinstance(judged['reason'], str)
                    or not isinstance(judged['matchedFields'], list)
                    or any(f not in FIELDS for f in judged['matchedFields'])
                    or not isinstance(judged['stimulusQuotes'], list)
                    or any(not isinstance(q, str) or not q or q not in query['originalText'] for q in judged['stimulusQuotes'])
                    or judged['related'] and (not judged['matchedFields'] or not judged['stimulusQuotes'])
                    or not judged['related'] and (judged['matchedFields'] or judged['stimulusQuotes'])):
                raise ValueError('invalid applicability assessment')
            accepted = judged['related']
    trace = {'memoryId': target['id'], 'subjectIds': sorted(subjects), 'eligibleQuerySubjectIds': sorted(seeds),
             'matchedSubjects': shared, 'subjectMatched': bool(shared), 'fieldSignals': signals,
             'accepted': accepted, 'queryBackgroundMedian': background, 'rules': rule,
             'reason': 'subject and contextual content matched' if accepted else
                       'subject mismatch or unresolved' if not shared else
                       'model assessed uncertain' if judged is not None and judged.get('choice') == 'UNCERTAIN' else
                       'model assessed unrelated' if doc.get('judge') and judged is not None else 'context/exception below unchanged gate',
             'judgeInput': judge_input, 'judgeResult': judged, 'judgeBackend': doc.get('judgeBackend', 'gemini') if doc.get('judge') else None,
             'selectionMethod': prepared['selectionMethod'],
             'limits': 'Relatedness only; similarity/assessment never proves a condition true or determines behavior.'}
    # Assessed Observation uses this route exclusively; ordinary memories keep original recall.
    candidates = [c for c in retrieval['results'] if c['id'] != target['id']]
    if accepted:
        best = max(winners or signals, key=lambda s: s['relevance'])
        candidates.append({'id': target['id'], 'relevance': best['relevance'], 'score': 0,
                           'selectionMethod': prepared['selectionMethod'], 'applicabilityTrace': trace,
                           'matches': [{'representationId': 'applicability:' + target['id'],
                                        'atomIds': target['sourceFactIds'], 'sourceRefs': target['sourceRefs'],
                                        **best}]})
    candidates.sort(key=lambda c: (-c['relevance'], -c['score'], c['id']))
    for rank, candidate in enumerate(candidates, 1):
        candidate['rank'] = rank
    delivered = bridge.activity.deliver(doc['archive'], candidates, doc['request'], doc['tick'], query)
    return {'query': query, 'retrieval': {**retrieval, 'results': candidates,
                                        'applicabilityRoute': trace, 'baseResults': retrieval['results']},
            'delivery': delivered['memories'], 'deliveryTrace': delivered['trace']}


if __name__ == '__main__':
    doc = json.load(sys.stdin)
    result = prepare(doc) if doc['operation'] == 'prepare' else recall(doc)
    json.dump(result, sys.stdout, ensure_ascii=False)
