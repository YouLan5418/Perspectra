"""Read a frozen run and write a new deterministic diagnosis; no provider calls."""
import copy
import json
import sqlite3
import sys
from pathlib import Path
import core_bridge as bridge

root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
if out.exists(): raise ValueError('diagnostics needs a new output directory')
out.mkdir(parents=True)
def read(path): return json.loads(path.read_text(encoding='utf-8'))
results=[]
for number in (89,94,95,103,107):
    row=read(root/f'character-call-{number}.json')
    actor=row['actor'].split(':')[1]
    archive=read(root/f"checkpoint-{row['checkpoint']}"/f'{actor}-archive.json')
    recall=row['recall']
    projected=bridge.activity.deliver(archive,recall['retrieval']['results'],row['request'],row['tick'],copy.deepcopy(recall['query']))
    assert archive['sources']==read(root/f"checkpoint-{row['checkpoint']}"/f'{actor}-input.json')['sources']
    before=recall['deliveryTrace'];after=projected['trace']
    item={'call':number,'actor':row['actor'],'query':recall['query']['semanticQuery'],
          'beforeSources':[m['sourceIds'] for m in recall['delivery']],
          'afterSources':[m['sourceIds'] for m in projected['memories']],
          'beforeCoverage':before.get('activityCoverage',[]),'afterCoverage':after.get('activityCoverage',[]),
          'afterDelivery':projected['memories'],'afterTrace':after}
    results.append(item)
    print(json.dumps({k:v for k,v in item.items() if k not in {'afterDelivery','afterTrace'}},ensure_ascii=False))
# Reconstruct only this character's authorized observation upserts at call 39.
row=read(root/'character-call-39.json');observations={}
with sqlite3.connect('file:'+str(root/'base/world.sqlite').replace('\\','/')+'?mode=ro',uri=True) as db:
    for seq,kind,value in db.execute('SELECT seq,event_type,data_json FROM events WHERE seq<=? ORDER BY seq',(row['headSeq'],)):
        data=json.loads(value)
        if kind=='observation.upsert' and data['value']['observerId']==row['actor']:
            observations[data['id']]={'sourceSeq':seq,'value':data['value']}
        elif kind=='observation.remove': observations.pop(data['id'],None)
newest=sorted(observations.values(),key=lambda r:r['sourceSeq'])[-8:]
stimulus={'call':39,'old':row['request']['context']['stimulus'],'new':[r['value'] for r in newest],
          'newSourceSeqs':[r['sourceSeq'] for r in newest]}
assert stimulus['new']!=stimulus['old']
(out/'delivery-comparison.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
(out/'stimulus-comparison.json').write_text(json.dumps(stimulus,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'call':39,'newSourceSeqs':stimulus['newSourceSeqs']},ensure_ascii=False))
