from pathlib import Path
import json, sqlite3, hashlib, shutil
root=Path('experiments/jev-narrative-auditor/holdout-2026-09-27')
source_prefix=Path('.tmp')

def load_lines(path):
    return [json.loads(line) for line in path.read_text(encoding='utf-8-sig').splitlines() if line.strip()]

def save(path, value):
    if path.exists(): raise RuntimeError('Refusing to overwrite '+str(path))
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

cases=[]
mapping=[]
for name in ['a1','a2','b1','b2']:
    directory=source_prefix/('jev-holdout-live-20260927-'+name)
    summary=json.loads((directory/'summary.json').read_text(encoding='utf-8'))
    db=sqlite3.connect((directory/'world.sqlite').resolve().as_uri()+'?mode=ro',uri=True)
    rows=db.execute('SELECT seq,event_type,data_json,transaction_id FROM events ORDER BY seq').fetchall()
    db.close()
    events=[{'seq':seq,'eventType':event_type,'data':json.loads(data),'transactionId':tx} for seq,event_type,data,tx in rows]
    for event in events:
        if event['eventType']!='character.speak' or event['data']['characterId']=='character:player': continue
        seq=event['seq']
        id=hashlib.sha256(('holdout07:'+name+':'+str(seq)).encode()).hexdigest()[:12]
        prefix=[e for e in events if e['seq']<=seq]
        holders={}
        for e in prefix:
            d=e['data']
            if e['eventType']=='entity.upsert': holders[d['entityId']]=d.get('holderId')
            if e['eventType'] in ['entity.transferred','entity.taken']: holders[d['entityId']]=d.get('toHolderId') if 'toHolderId' in d else d['characterId']
        cases.append({'id':id,'actorId':event['data']['characterId'],'speech':event['data'].get('text',''),'narration':event['data'].get('narration',''),'holders':holders,'formal':[e for e in prefix if e['eventType'] in ['entity.upsert','entity.transferred','entity.taken']],'prior':[e for e in prefix if e['eventType']=='character.speak' and e['seq']<seq][-4:]})
        mapping.append({'id':id,'run':name,'seq':seq})
    save(root/(name+'-events.json'),events)
    for file in ['summary.json','protocol.json','turns.jsonl','jev-shadow.jsonl','interventions.jsonl']:
        target=root/(name+'-'+file)
        if target.exists(): raise RuntimeError('Refusing overwrite')
        shutil.copyfile(directory/file,target)
cases.sort(key=lambda c:c['id'])
save(root/'review-cases.json',cases)
save(root/'review-mapping.json',mapping)
print(json.dumps({'cases':len(cases)}))
for index,case in enumerate(cases):
    print(json.dumps({'index':index,**{k:v for k,v in case.items() if k not in ['formal','prior']}},ensure_ascii=False))
