"""Rebuild the original retain batches of two observed fidelity failures.
These are source regressions, not a behavioral A/B or a replay of all 120 turns.
Only character-authorized exported source texts are passed to the memory core.
"""
import copy
import json
import sys
from pathlib import Path
import episode_core
import vector_core

original = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
if output.exists(): raise SystemExit('use a new output directory')
output.mkdir(parents=True)
entries = [json.loads(line) for line in (original / 'consolidation.jsonl').read_text(encoding='utf-8').splitlines()]
results = []
for actor, target in [('character:friend', 'event:234'), ('character:companion', 'event:938')]:
    entry = next(e for e in entries if e['actorId'] == actor and target in e['sourceIds'])
    sources = entry['sourceTexts']
    data = {'scope': {'worldAddress': sources[0]['worldAddress'], 'characterId': actor, 'asOfWorldSeq': 0},
            'memoryGrain': 'episode', 'sources': [], 'representations': [], 'facts': [], 'episodes': [], 'observations': []}
    stages = []
    # Reproduce a processing boundary inside the same authorized original batch.
    cut = max(1, len(sources) // 2)
    for batch in [sources[:cut], sources[cut:]]:
        if not batch: continue
        scope = {**data['scope'], 'asOfWorldSeq': max(s['worldSeq'] for s in batch)}
        retained = episode_core.retain({'scope': scope, 'sources': batch})
        data.update(scope=scope, sources=data['sources'] + batch, facts=data['facts'] + retained['facts'],
                    representations=data['representations'] + retained['representations'])
        grouped = episode_core.group(data)
        data['episodes'] = grouped['episodes']
        consolidated = episode_core.consolidate(data)
        data['observations'] = consolidated['observations']
        episode_core.validate_units(data)
        stages.append({'sourceIds': [s['sourceId'] for s in batch], 'retainStats': retained['stats'],
                       'groupingActions': grouped['actions'], 'observations': copy.deepcopy(data['observations'])})
    index = vector_core.index(data)
    target_source = next(s for s in sources if s['sourceId'] == target)
    target_atoms = [a for a in data['facts'] if a['sourceRefs'][0]['sourceId'] == target]
    directory = output / actor.split(':')[1]
    directory.mkdir()
    for name, value in [('prepared.json', data), ('index.json', index), ('stages.json', stages)]:
        (directory / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    result = {'actorId': actor, 'sourceId': target, 'originalPlayerTurn': entry['playerTurn'],
              'source': target_source, 'eventAtoms': target_atoms,
              'sourceCount': len(sources), 'atomCount': len(data['facts']),
              'episodeCount': len(data['episodes']), 'observationCount': len(data['observations']),
              'limits': 'original failing retain batch only; no full history replay or behavior comparison'}
    results.append(result)
    print(json.dumps(result, ensure_ascii=False), flush=True)
(output / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
