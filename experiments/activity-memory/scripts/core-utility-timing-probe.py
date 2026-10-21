# 历史研究脚本；路径、样本和模型可能绑定原始记录，不属于游戏启动或默认验收。
"""Bounded same-payload transport probe, independent of world writes and Core retries."""
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

repository = Path(__file__).resolve().parents[3]
for directory in ['experiments/activity-memory', 'desktop/host/memory/python/core', 'desktop/host/memory/python/bridge']:
    sys.path.insert(0, str(repository / directory))
import core_bridge as bridge

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=False)
archive = json.loads(Path('output/experiments/nodes-core-sms-gemini38-20261010-01/source/memory-core/Y2hhcmFjdGVyOmZyaWVuZA.json').read_text(encoding='utf-8'))['archive']
captured = []
def capture(system, user, limit):
    captured.append((system,user,limit))
    return {'atoms':[]}
bridge.core.llm = capture
bridge.episode.retain({'scope':archive['scope'], 'sources':archive['sources']})
system,user,limit = captured[0]
endpoint = os.getenv('HCW_LOCAL_ENDPOINT','http://127.0.0.1:8046/v1/chat/completions')
model = os.getenv('HCW_LOCAL_MODEL','gemini-3.8-flash')

def probe(label, effort):
    body,headers,url = bridge.utility_request('openai',endpoint,model,system,user,limit,os.getenv('HCW_LOCAL_API_KEY'))
    if effort is not None:
        body.pop('thinking',None)
        body['reasoning_effort'] = effort
    start = time.perf_counter()
    result = {'label':label,'startedAtMs':time.time_ns()/1_000_000,'inputChars':len(user),'requestedMaxTokens':limit,
        'thinking':body.get('thinking'),'reasoningEffort':effort,'timeoutSeconds':60}
    try:
        with urllib.request.urlopen(urllib.request.Request(url,data=json.dumps(body,ensure_ascii=False).encode(),headers=headers),timeout=60) as response:
            result['headersMs'] = (time.perf_counter()-start)*1000
            result['contentType'] = response.headers.get('Content-Type')
            raw = response.read().decode('utf-8')
            result['bodyChars'] = len(raw)
            result['isSse'] = raw.lstrip().startswith('data:')
            value = json.loads(raw)
            text,finish,usage = bridge.utility_response(value,'openai')
            result.update(finishReason=finish,usage=usage,responseChars=len(text))
            parsed = json.loads(text.strip().removeprefix('```json').removesuffix('```').strip())
            result.update(status='returned',finishReason=finish,usage=usage,responseChars=len(text),validAtoms=isinstance(parsed.get('atoms'),list))
    except (OSError,ValueError,TypeError) as error:
        result.update(status='failed',errorType=type(error).__name__)
    result['durationMs'] = (time.perf_counter()-start)*1000
    print(json.dumps(result,ensure_ascii=False),flush=True)
    return result

results = [probe('low-serial','low')]
with ThreadPoolExecutor(max_workers=2) as executor:
    results += list(executor.map(lambda i:probe('low-concurrent-'+str(i),'low'),range(2)))
results.append(probe('legacy-serial',None))
(root/'report.json').write_text(json.dumps({'model':model,'results':results},ensure_ascii=False,indent=2),encoding='utf-8')
