"""Analyze existing metadata only; never emit prompts, response text or credentials."""
import json
import sys
from pathlib import Path
from collections import Counter

root = Path(sys.argv[1])
rows = []
for directory in ('nodes-core-sms-gemini38-20261010-01', 'nodes-core-sms-gemini38-20261010-02', 'nodes-core-phone-gemini38-20261010-01'):
    for path in (root / directory / 'source' / 'memory-core').glob('utility-attempts-*.jsonl'):
        for line in path.read_text(encoding='utf-8').splitlines():
            rows.append({**json.loads(line), 'experiment': directory})
rows.sort(key=lambda row: row['atMs'])
active = set()
peak = 0
finished = []
for row in rows:
    key = (row['pid'], row['callId'], row.get('attempt'))
    if row['event'] == 'started':
        active.add(key)
        peak = max(peak, len(active))
    elif row['event'] == 'finished':
        finished.append({key: row.get(key) for key in ('experiment', 'actor', 'stage', 'attempt', 'inputChars', 'durationMs',
            'headersMs', 'bodyReadMs', 'status', 'timedOut', 'errorType', 'requestedMaxTokens', 'usage')})
        finished[-1]['overlappingAttemptsAtFinish'] = len(active)
        active.discard(key)
report = {'peakConcurrentHttpAttemptsAcrossExperiments': peak, 'attempts': len(finished),
    'statuses': dict(Counter(row['status'] for row in finished)), 'finished': finished}
target = root / 'core-timing-summary.json'
target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'report': str(target), 'peak': peak, 'attempts': len(finished), 'statuses': report['statuses']}))
for row in finished:
    print(json.dumps(row, ensure_ascii=False))
