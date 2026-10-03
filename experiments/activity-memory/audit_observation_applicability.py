"""Read-only audit of the one-window applicability experiment."""
import copy
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import core_bridge as bridge


def audit(root):
    def load(name):
        return json.loads((root / name).read_text(encoding='utf-8'))
    protocol, built, projection = load('protocol.json'), load('build.json'), load('applicability.json')
    old, new, archive = built['index'], projection['index'], built['archive']
    frozen = json.loads((Path(protocol['reusedArchiveFrom']) / 'build.json').read_text(encoding='utf-8'))
    assert built == frozen
    assert old['scope'] == new['scope'] == archive['scope']
    bridge.episode.validate_units(archive)
    for index in (old, new):
        bridge.vector_core.check_mapping(index, index['units'])
    assert len(old['units']) == len(new['units']) == 34
    changed = [b['id'] for a, b in zip(old['units'], new['units']) if a != b]
    assert len(changed) == 1
    differences = {k for a, b in zip(old['units'], new['units']) for k in set(a) | set(b) if a.get(k) != b.get(k)}
    assert differences <= {'text', 'retrievalText', 'searchTokens', 'applicability', 'projectionMethod', 'observationTextHash'}
    for a, b, av, bv in zip(old['units'], new['units'], old['vectors'], new['vectors']):
        assert a['id'] == b['id']
        if a['memoryId'] != 'obs:1':
            assert a == b and av == bv
    assert projection['targetWindows'] == 1
    assert set(projection['generationInput']) == {'observationText', 'allowedPeople'}
    assert projection['generationInput']['observationText'] == archive['observations'][0]['text']
    assert not any(chr(65533) in json.dumps(value, ensure_ascii=False) for value in (archive, old, new, projection))
    assert not any(chr(0x96ea) + chr(0x9752) in json.dumps(value, ensure_ascii=False) for value in (archive, projection))
    assert all(s['characterId'] == archive['scope']['characterId'] for s in archive['sources'])
    prior = json.loads((Path(protocol['reusedArchiveFrom']) / 'protocol.json').read_text(encoding='utf-8'))
    assert protocol['probes'][:3] == prior['probes']
    rows = []
    for probe in protocol['probes']:
        baseline, projected = load(probe['id'] + '-baseline-recall.json'), load(probe['id'] + '-recall.json')
        assert baseline['query'] == projected['query']
        threshold_keys = ('semanticMin', 'semanticLiftMin', 'keywordCoverageMin')
        assert all(baseline['retrieval']['thresholds'][key] == projected['retrieval']['thresholds'][key] for key in threshold_keys)
        values = []
        for result in (baseline, projected):
            signals = [s for s in result['retrieval']['rawScores'] if s['memoryId'] == 'obs:1']
            assert len(signals) == 1
            values.append({**signals[0], 'delivered': any(m['memoryId'] == 'obs:1' for m in result['delivery']),
                           'queryBackgroundMedian': result['retrieval']['thresholds']['queryBackgroundMedian'],
                           'semanticRank': 1 + sum(s['semanticSimilarity'] > signals[0]['semanticSimilarity'] for s in result['retrieval']['rawScores'])})
        rows.append({'probe': probe['id'], 'baseline': values[0], 'applicability': values[1]})
    spec = importlib.util.spec_from_file_location('applicability', HERE / 'observation-applicability.py')
    module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    source = load('projection-input.json')
    # No gateway calls in negative checks. Return the frozen facets locally.
    bridge.utility_llm = lambda *args: copy.deepcopy(projection['facets'])
    rejected = []
    mutations = [
        ('wrong-character', lambda d: d['build']['archive']['scope'].update(characterId='character:bob')),
        ('tampered-source-hash', lambda d: d['build']['index']['sources'][0].update(sourceHash='sha256:tampered')),
        ('unauthorized-subject-id', lambda d: d.update(allowedPeople=[])),
    ]
    for name, mutate in mutations:
        value = copy.deepcopy(source);mutate(value)
        try:module.project(value)
        except ValueError:rejected.append(name)
        else:raise AssertionError(name + ' was accepted')
    target = archive['observations'][0]
    return {'archiveUnchanged': True, 'sameOriginalThreeStimuli': True, 'sameQueriesAndAdmissionThresholds': True,
            'onlyOneSearchWindowChanged': True, 'otherVectorsUnchanged': True, 'entityMetadataUnchanged': True,
            'privateSourceExcluded': True, 'negativeChecksRejected': rejected,
            'formationTick': protocol['formationTick'], 'probeTick': protocol['probeTick'],
            'latestEvidenceAgeTicks': protocol['probeTick'] - target['knownTickEnd'],
            'targetSourceCount': len(target['sourceRefs']), 'searchTokens': next(u['searchTokens'] for u in new['units'] if u['memoryId'] == target['id']),
            'utilityCalls': len((root / 'projection-utility-calls.jsonl').read_text(encoding='utf-8').splitlines()),
            'characterCalls': len(list(root.glob('*/call-*.json'))), 'rows': rows}


if __name__ == '__main__':
    result = audit(Path(sys.argv[1]))
    Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=True))
