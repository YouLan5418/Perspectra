"""Frozen-Observation search-text experiment; no gameplay or delivery policy."""
import copy
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import core_bridge as bridge
import retrieval_text

FACETS = ('contexts', 'conditions', 'exceptions', 'themes')
PROMPT = (
    'Derive a SEARCH-ONLY applicability projection from ONE frozen subjective Observation. '
    'Return JSON {"subjects":[{"name":"...","characterId":null}],'
    '"contexts":["..."],"conditions":["..."],"exceptions":["..."],"themes":["..."]}. '
    'Use concise Chinese phrases and ordinary semantic synonyms. Describe situations in which '
    'the understanding is relevant, including its exceptions. Never prescribe actions, responses '
    'or decisions. Never add motives, evidence, new assertions, causal explanations or stronger certainty. '
    'Derive only from observationText, not from external knowledge. Use allowedPeople only to resolve '
    'the identity of an explicitly named subject; unresolved identity must remain null. '
    'Keep conditional and exception distinctions. No hypothetical test queries or generated dialogue. '
    'At most six phrases per facet; keep the whole projection compact.'
)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def project(doc):
    built = doc['build']
    archive, original = built['archive'], built['index']
    bridge.episode.validate_units(archive)
    bridge.vector_core.check_mapping(original, original['units'])
    if archive['scope'] != original['scope']:
        raise ValueError('index/archive scope mismatch')
    target = next(o for o in archive['observations'] if o['id'] == doc['targetObservation'])
    identities = doc.get('allowedPeople', [])
    if any(set(p) != {'characterId', 'name'} or not all(isinstance(v, str) and v for v in p.values()) for p in identities):
        raise ValueError('invalid authorized identities')
    generation_input = {'observationText': target['text'], 'allowedPeople': identities}
    bridge.core.llm = bridge.utility_llm
    facets = bridge.core.llm(PROMPT, json.dumps(generation_input, ensure_ascii=False), 1200)
    if set(facets) != {'subjects', *FACETS}:
        raise ValueError('invalid facet keys')
    if not isinstance(facets['subjects'], list) or not facets['subjects']:
        raise ValueError('projection has no named subject')
    for subject in facets['subjects']:
        if (not isinstance(subject, dict) or set(subject) != {'name', 'characterId'}
                or not isinstance(subject['name'], str) or not subject['name']
                or subject['name'] not in target['text']):
            raise ValueError('subject not grounded in Observation text')
        if subject['characterId'] is not None and subject not in identities:
            raise ValueError('subject identity not authorized')
    for key in FACETS:
        phrases = facets[key]
        if not isinstance(phrases, list) or len(phrases) > 6 or any(not isinstance(p, str) or not p.strip() or len(p) > 60 for p in phrases):
            raise ValueError('invalid applicability phrase')
    # One replacement per original view. No extra windows or additional fusion votes.
    views = [u for u in original['units'] if u['memoryId'] == target['id']]
    if len(views) != 1:
        raise ValueError('experiment requires one original Observation window')
    text = '\n'.join(['涉及对象：' + '、'.join(s['name'] for s in facets['subjects'])]
                     + [label + '：' + '、'.join(facets[key]) for key, label in
                        [('contexts', '相关情境'), ('conditions', '适用条件'),
                         ('exceptions', '例外情境'), ('themes', '判断主题')]])
    count = bridge.projections.token_counter()
    if count(text) > 220:
        raise ValueError('projection exceeds unchanged search-window budget')
    index = copy.deepcopy(original)
    for position, unit in enumerate(index['units']):
        if unit['memoryId'] != target['id']:
            continue
        # Subject facets remain diagnostic metadata. Entity admission/ranking stays unchanged.
        unit.update(text=text, retrievalText=retrieval_text.clean(text, original['retrievalAliases']),
                    searchTokens=count(text), applicability=facets,
                    projectionMethod='observation-applicability-experiment',
                    observationTextHash=digest(target['text']))
        index['vectors'][position] = bridge.vector_core.encode([unit['retrievalText']], index['scope'])[0].tolist()
    # Rebuild diagnostic edges with the same algorithm and default 0.80 threshold.
    collections = {key: [u for u in index['units'] if u['kind'] == kind]
                   for key, kind in [('facts', 'fact'), ('episodes', 'episode'), ('observations', 'observation')]}
    rebuilt = bridge.vector_core.index({'scope': index['scope'], 'sources': index['sources'],
                                      'representations': [], 'retrievalAliases': index['retrievalAliases'], **collections})
    if len(rebuilt['units']) != len(original['units']):
        raise ValueError('window count changed')
    for old, new, old_vector, new_vector in zip(original['units'], rebuilt['units'], original['vectors'], rebuilt['vectors']):
        if old['id'] != new['id'] or old['sourceRefs'] != new['sourceRefs'] or old['atomIds'] != new['atomIds']:
            raise ValueError('projection identity or provenance changed')
        if old['memoryId'] != target['id'] and (old != new or old_vector != new_vector):
            raise ValueError('unrelated representation changed')
    bridge.vector_core.check_mapping(rebuilt, rebuilt['units'])
    return {'index': rebuilt, 'facets': facets, 'generationInput': generation_input,
            'prompt': PROMPT, 'searchText': text, 'archiveHash': digest(archive),
            'observationTextHash': digest(target['text']), 'indexUnits': len(rebuilt['units']),
            'targetWindows': len(views), 'selectionMethod': 'natural_retrieval_with_applicability_projection',
            'limits': 'Search-only inferred facets; shape/identity checked, semantic faithfulness needs reading.'}


if __name__ == '__main__':
    json.dump(project(json.load(sys.stdin)), sys.stdout, ensure_ascii=False)
