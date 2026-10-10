"""Test the proposed transport choice inside this process only; production defaults stay intact."""
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'experiments'/'activity-memory'))
import core_bridge as bridge

root = Path(sys.argv[1]); root.mkdir(parents=True,exist_ok=False)
cached = json.loads(Path('output/experiments/nodes-core-sms-gemini38-20261010-01/source/memory-core/Y2hhcmFjdGVyOmZyaWVuZA.json').read_text(encoding='utf-8'))
archive = cached['archive']
os.environ['HCW_LOCAL_ENDPOINT'] = 'http://127.0.0.1:8046/v1/chat/completions'
os.environ['HCW_LOCAL_MODEL'] = 'gemini-3.8-flash'
os.environ['HCW_MODEL_PROTOCOL'] = 'openai'
os.environ['HCW_HINDSIGHT_UTILITY_ATTEMPTS'] = str(root/'utility-attempts.jsonl')
original = bridge.utility_request
def low(*args):
    body,headers,url = original(*args)
    body.pop('thinking',None); body['reasoning_effort'] = 'low'
    return body,headers,url
bridge.utility_request = low
start = time.perf_counter()
try:
    built = bridge.dispatch({'operation':'build','scope':archive['scope'],'sources':archive['sources'],
        'aliasHistory':cached.get('aliasHistory',[]),'retainConcurrency':2,'buildId':'core-low-transport-probe'})
    bridge.episode.validate_units(built['archive'])
    assert built['archive']['sources'] == archive['sources']
    assert built['archive']['scope'] == archive['scope']
    (root/'archive.json').write_text(json.dumps(built,ensure_ascii=False),encoding='utf-8')
    report = {'status':'passed','durationMs':(time.perf_counter()-start)*1000,
        'facts':len(built['archive']['facts']),'episodes':len(built['archive']['episodes']),
        'observations':len(built['archive']['observations']),'indexUnits':len(built['index']['units'])}
except Exception as error:
    report = {'status':'failed','durationMs':(time.perf_counter()-start)*1000,'errorType':type(error).__name__}
(root/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report),flush=True)
if report['status'] != 'passed': sys.exit(1)
