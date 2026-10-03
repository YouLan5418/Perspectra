"""Audit both facet retrieval and narrow-model applicability without new API calls."""
import copy
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import core_bridge as bridge


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def audit(root):
    protocol, built, projection = [load(root / name) for name in ('protocol.json', 'build.json', 'applicability.json')]
    origin = Path(protocol['reusedArchiveFrom'])
    assert built == load(origin / 'build.json')
    assert projection == load(origin / 'applicability.json')
    archive, index = built['archive'], built['index']
    bridge.episode.validate_units(archive)
    bridge.vector_core.check_mapping(index, index['units'])
    spec = importlib.util.spec_from_file_location('facet_match', HERE / 'observation-facet-match.py')
    matcher = importlib.util.module_from_spec(spec);spec.loader.exec_module(matcher)
    input_doc, prepared = load(root / 'facet-input.json'), load(root / 'facet-projection.json')
    assert prepared == matcher.prepare(input_doc)
    target = next(o for o in archive['observations'] if o['id'] == prepared['memoryId'])
    comparisons = []
    for probe in protocol['probes']:
        baseline, selected = [load(root / (probe['id'] + suffix)) for suffix in ('-baseline-recall.json', '-recall.json')]
        assert baseline['query'] == selected['query']
        assert baseline['retrieval']['rawScores'] == selected['retrieval']['rawScores']
        assert baseline['retrieval']['thresholds'] == selected['retrieval']['thresholds']
        route = selected['retrieval']['applicabilityRoute']
        candidates = [c for c in selected['retrieval']['results'] if c['id'] == target['id']]
        assert len(candidates) == int(route['accepted'])
        for c in candidates:
            assert c['matches'][0]['sourceRefs'] == target['sourceRefs']
            assert c['matches'][0]['atomIds'] == target['sourceFactIds']
        for item in selected['delivery']:
            if item['memoryId'] == target['id']:
                assert item['text'] == target['text']
                assert item['epistemicKind'] == 'subjective_inference'
                assert item['sourceIds'] == [s['sourceId'] for s in target['sourceRefs']]
                assert item['sourceAgeTicks'] == 42
        if not route['subjectMatched']:
            assert route.get('judgeInput') is None and route.get('judgeResult') is None
        comparisons.append({'probe': probe['id'], 'baselineDeliveryIds': [m['memoryId'] for m in baseline['delivery']],
                            'selectedDeliveryIds': [m['memoryId'] for m in selected['delivery']], 'route': route})
    summary = load(root / 'summary.json')
    calls = sorted(root.glob('*/call-1.json'))
    assert len(calls) == summary['trials'] == len(summary['eligible']) * 9
    canonical, trials = {}, []
    for file in calls:
        call = load(file);row = load(file.parent / 'result.json')
        assert call['status'] == 'returned' and row['originalWorldUnchanged']
        request = copy.deepcopy(call['request'])
        memories = request['context'].pop('memories')
        nonmemory = json.dumps(request, sort_keys=True, ensure_ascii=False)
        assert call['probe'] not in canonical or canonical[call['probe']] == nonmemory
        canonical[call['probe']] = nonmemory
        assert request['context']['observations'] == [] and request['context']['selfObservations'] == []
        assert not request['canRecall']
        expected = next(c for c in comparisons if c['probe'] == call['probe'])['selectedDeliveryIds']
        expected = expected if call['mode'] == 'with-observation' else [i for i in expected if i != target['id']]
        assert [m['memoryId'] for m in memories] == expected
        assert all(set(m) == {'memoryId', 'memoryLevel', 'text', 'epistemicKind', 'sourceIds', 'sourceAgeTicks'} for m in memories)
        assert chr(0x96ea) + chr(0x9752) not in json.dumps(call['request'], ensure_ascii=False)
        moved = any(e['eventType'] == 'character.moved' for e in row['events'])
        if moved:
            assert row['result']['performResult']['status'] == 'accepted'
            assert any(e['eventType'] == 'action.resolved' and e['data']['accepted'] and e['data']['actionType'] == 'move' for e in row['events'])
        trials.append({'probe': call['probe'], 'mode': call['mode'], 'repetition': call['repetition'],
                       'response': call['response'], 'status': row['result']['status'], 'moved': moved,
                       'acceptedAction': row['result'].get('performResult', {}).get('status'),
                       'eventTypes': [e['eventType'] for e in row['events']]})
    negative = []
    def never_call(*args):
        raise AssertionError('audit attempted a new model call')
    bridge.utility_llm = never_call
    matcher.jev_applicability.assess = never_call
    base = {**input_doc, 'prepared': prepared, 'operation': 'recall',
            'request': load(root / 'new-task-preview-request.json'), 'tick': 55, 'observations': True}
    for name, mutate in [
        ('wrong-request-character', lambda d: d['request']['context']['character'].update(characterId='character:bob')),
        ('tampered-source-hash', lambda d: d['index']['sources'][0].update(sourceHash='sha256:tampered')),
        ('tampered-field-vector', lambda d: d['prepared']['fieldVectors']['contexts'].__setitem__(0, 42.0)),
    ]:
        value = copy.deepcopy(base);mutate(value)
        try:matcher.recall(value)
        except ValueError:negative.append(name)
        else:raise AssertionError(name + ' accepted')
    if input_doc.get('judge'):
        first = load(root / 'new-task-recall.json')['retrieval']['applicabilityRoute']['judgeResult']
        if input_doc.get('judgeBackend') == 'jev':
            matcher.jev_applicability.assess = lambda *args: copy.deepcopy(first)
        else:
            bridge.utility_llm = lambda *args: copy.deepcopy(first)
        replay = matcher.recall(copy.deepcopy(base))
        assert replay['delivery'][0]['text'] == target['text']
        assert replay['deliveryTrace']['delivered'][0]['coveredAtomIds'] == []
        assert replay['deliveryTrace']['distinctEvidenceSegments'] == 0
        bad = copy.deepcopy(first)
        if input_doc.get('judgeBackend') == 'jev':
            bad['choice'] = 'UNRELATED'  # Keep related=True: must reject inconsistent wire output.
            matcher.jev_applicability.assess = lambda *args: bad
        else:
            bad['stimulusQuotes'] = ['not in this stimulus']
            bridge.utility_llm = lambda *args: bad
        try:matcher.recall(copy.deepcopy(base))
        except ValueError:negative.append('inconsistent-jev-choice' if input_doc.get('judgeBackend') == 'jev' else 'invented-stimulus-quote')
        else:raise AssertionError('invalid model result accepted')
    with sqlite3.connect('file:' + (root / 'history/world.sqlite').resolve().as_posix() + '?mode=ro', uri=True) as db:
        assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    utility = root / ('jev-applicability-calls.jsonl' if input_doc.get('judgeBackend') == 'jev' else 'facet-utility-calls.jsonl')
    return {'archiveAndFrozenProjectionUnchanged': True, 'originalIndexAndBaseScoresUnchanged': True,
            'queriesUnchanged': True, 'nonmemoryContextEqualWithinProbe': True, 'judgeNotDeliveredToCharacter': True,
            'privateSourceExcluded': True, 'originalWorldUnchanged': summary['originalWorldUnchanged'],
            'negativeChecksRejected': negative, 'deliveryRegressionPassed': bool(input_doc.get('judge')),
            'modelApplicabilityCalls': len(utility.read_text(encoding='utf-8').splitlines()) if utility.exists() else 0,
            'characterCalls': len(calls), 'comparisons': comparisons, 'trials': trials,
            'assessmentMethod': 'nonblind exploratory comparison; single candidate and one applicability draw per query'}


if __name__ == '__main__':
    root = Path(sys.argv[1]);result = audit(root)
    (root / 'audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k not in ('comparisons', 'trials')}, ensure_ascii=True))
