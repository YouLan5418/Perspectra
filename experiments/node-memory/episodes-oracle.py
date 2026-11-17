"""Offline original-implementation oracle with scripted utility answers, no model calls."""
import json
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(root / 'packages/memory-core/python/bridge'), str(root / 'packages/memory-core/python/core')]
import core_bridge as bridge

doc = json.load(sys.stdin)
answers = iter(doc['answers'])
calls = []
def utility(system, user, max_tokens=1600):
    calls.append({'system': system, 'user': json.loads(bridge.utility_prompt(user)), 'rawUser': bridge.utility_prompt(user), 'maxTokens': max_tokens})
    return next(answers)
bridge.core.llm = utility
operations = {'retain': bridge.episode.retain, 'group': bridge.episode.group,
              'consolidate': bridge.episode.consolidate, 'retainPrefix': bridge.retain_prefix,
              'validate': bridge.episode.validate_units}
try:
    result = operations[doc['operation']](doc['input'])
    json.dump({'result': result, 'calls': calls}, sys.stdout, ensure_ascii=False)
except (ValueError, TypeError, KeyError):
    json.dump({'rejected': True, 'calls': calls}, sys.stdout, ensure_ascii=False)
