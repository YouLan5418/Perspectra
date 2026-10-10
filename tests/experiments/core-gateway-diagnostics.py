"""Read local gateway records for this experiment; emit only timing/configuration metadata."""
import json
import sqlite3
import sys
from pathlib import Path

db = Path.home() / '.antigravity_tools' / 'proxy_logs.db'
connection = sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)
connection.row_factory = sqlite3.Row
rows = connection.execute('SELECT timestamp,status,duration,model,mapped_model,request_body,upstream_request_body,response_body FROM request_logs WHERE model=? AND timestamp>=? ORDER BY timestamp',
    ('gemini-3.8-flash', 1791643500)).fetchall()
report = []
for row in rows:
    try:
        request = json.loads(row['request_body'] or '{}')
        upstream = json.loads(row['upstream_request_body'] or '{}')
        response = json.loads(row['response_body'] or '{}')
    except ValueError:
        continue
    messages = request.get('messages', [])
    system = next((m.get('content','') for m in messages if m.get('role') == 'system'), '')
    if not isinstance(system,str) or not system.startswith('Split authorized evidence'):
        continue
    config = upstream.get('request', upstream).get('generationConfig', {})
    report.append({'timestamp':row['timestamp'], 'status':row['status'], 'durationMs':row['duration'],
        'model':row['model'], 'mappedModel':row['mapped_model'],
        'inputChars':sum(len(m.get('content','')) for m in messages if m.get('role') == 'user'),
        'clientThinking':request.get('thinking'), 'clientReasoningEffort':request.get('reasoning_effort'),
        'upstreamConfig':{k:config[k] for k in ('thinkingConfig','maxOutputTokens','responseMimeType','temperature') if k in config},
        'usage':response.get('usage') or response.get('usageMetadata')})
target = Path(sys.argv[1]); target.parent.mkdir(parents=True,exist_ok=True)
target.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'matchingRequests':len(report),'report':str(target)}))
for item in report: print(json.dumps(item,ensure_ascii=False))
