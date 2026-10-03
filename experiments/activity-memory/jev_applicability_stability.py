"""Two additional identical JEV draws per eligible frozen query; never calls a role model."""
import hashlib
import json
import os
import sys
from pathlib import Path
import jev_applicability as jev

root = Path(sys.argv[1])
out = root / 'jev-stability.json'
if out.exists() or (root / 'jev-stability-calls.jsonl').exists():
    raise ValueError('stability output already exists; preserve earlier calls')
os.environ['HCW_JEV_APPLICABILITY_TRACE'] = str(root / 'jev-stability-calls.jsonl')
protocol = json.loads((root / 'protocol.json').read_text(encoding='utf-8'))
assert protocol['applicabilityJudge'] == jev.MODEL
rows = []
for probe in protocol['probes']:
    selected = json.loads((root / (probe['id'] + '-recall.json')).read_text(encoding='utf-8'))
    route = selected['retrieval']['applicabilityRoute']
    if route['judgeResult'] is None:
        assert not route['subjectMatched']
        continue
    state = route['judgeInput']
    assert route['judgeBackend'] == 'jev'
    jev.validate_decision(route['judgeResult'])
    for draw in range(2):
        result = jev.assess(state)
        row = {'probe': probe['id'], 'additionalDraw': draw,
               'inputHash': hashlib.sha256(json.dumps(state, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
               'result': result, 'sameChoiceAsInitial': result['choice'] == route['judgeResult']['choice']}
        rows.append(row)
        out.write_text(json.dumps({'complete': False, 'rows': rows}, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'probe': probe['id'], 'draw': draw, 'result': result}), flush=True)
out.write_text(json.dumps({'complete': True, 'rows': rows, 'sameChoiceAsInitial': all(r['sameChoiceAsInitial'] for r in rows),
                           'limit': 'Three calls per query, one understanding and four stimuli; probabilities are not calibrated.'},
                          ensure_ascii=False, indent=2), encoding='utf-8')
