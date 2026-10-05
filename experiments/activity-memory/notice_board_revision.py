"""Actual committed capability Source -> existing cognition update sidecar.
The exporter checks host-owned evidence; the updater receives only NPC-authorized sources.
"""
import copy
import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path
import cognition_lineage as lineage

def load(p):
    return json.loads(Path(p).read_text(encoding='utf-8'))
def filehash(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def ro(p):
    db=sqlite3.connect(Path(p).resolve().as_uri()+'?mode=ro',uri=True)
    db.execute('PRAGMA query_only=ON')
    return db

def export_authorized(input_root):
    directory=Path(input_root)/'repeat-0'
    if not load(Path(input_root)/'audit.json')['audited']:
        raise ValueError('original capability run must be audited')
    db=ro(directory/'world.sqlite')
    try:
        events={seq:{'tick':tick,'type':kind,'data':json.loads(data),'hash':digest}
                for seq,tick,kind,data,digest in db.execute('SELECT seq,tick,event_type,data_json,event_hash FROM events')}
        head=max(events)
    finally:db.close()
    db=ro(directory/'memory.sqlite')
    try:
        rows=db.execute('SELECT namespace_key,source_id,source_seq,source_hash,epistemic_kind,text_value FROM cognitive_memory_v2_sources').fetchall()
    finally:db.close()
    exported=[]
    for ns,sid,seq,digest,kind,text in sorted(rows,key=lambda r:r[2]):
        tenant,world,branch,actor=ns.split(chr(31))
        if actor!='character:npc':continue
        e=events[seq];v=e['data']['value']
        if sid!='event:'+str(seq) or digest!=e['hash'] or v['observerId']!=actor:
            raise ValueError('invalid Source mapping')
        content=v['content']
        prior=e['data']['id'].startswith('prior:')
        player= isinstance(content,dict) and content.get('speech',{}).get('characterId')=='character:player' and '去年' in content['speech']['text']
        read= isinstance(content,dict) and content.get('capabilityId')=='experiment:inspect-notice-board'
        if not (prior or player or read):continue
        if prior and text != content:raise ValueError('prior capture text differs from event')
        if player and text != content['speech']['characterId']+' said: '+content['speech']['text']:
            raise ValueError('speech capture text differs from event')
        if read and json.loads(text) != content:raise ValueError('read capture text differs from event')
        if player and kind!='reported_speech':raise ValueError('player claim promoted')
        if read and (kind!='direct_observation' or content['observedText']!='登记处：二楼203'):
            raise ValueError('read Source invalid')
        exported.append({'sourceId':sid,'sourceHash':digest,'worldSeq':seq,'characterId':actor,
            'worldAddress':{'tenantId':tenant,'worldId':world,'branchId':branch},
            'epistemicKind':kind,'text':text,'knownTick':e['tick'],
            'experimentRole':'prior' if prior else 'player_report' if player else 'actual_read'})
    if len(exported)!=6:raise ValueError('expected four historical sources + actual speech + actual read')
    scope={'characterId':'character:npc','worldAddress':exported[0]['worldAddress'],'asOfWorldSeq':head}
    return {'scope':scope,'sources':exported,'facts':[],'episodes':[],'observations':[]},max(e['tick'] for e in events.values())

def build_archive(input_root):
    archive,tick=export_authorized(input_root)
    for source in archive['sources']:
        atoms=[]
        for i,part in enumerate(lineage.bridge.episode.segments(source)):
            atom=lineage.bridge.episode.make_atom(source,part,part['context'],i)
            atoms.extend(lineage.bridge.timed([atom],archive['sources']))
        archive['facts'].extend(atoms)
        episode={'id':'episode:'+source['sourceId'],'kind':'episode','memoryLevel':'episode',
            'label':'authorized source group, not a semantic truth merge',
            'eventAtomIds':[a['id'] for a in atoms],'eventAtoms':copy.deepcopy(atoms),
            'sourceRefs':lineage.bridge.episode.union_refs(atoms),
            'text':lineage.bridge.episode.episode_text(atoms)}
        archive['episodes'].extend(lineage.bridge.timed([episode],archive['sources']))
    ids={s['experimentRole']:[a['id'] for a in archive['facts'] if a['sourceRefs'][0]['sourceId']==s['sourceId']]
         for s in archive['sources'] if s['experimentRole']!='prior'}
    priors=[a['id'] for a in archive['facts'] if next(s for s in archive['sources'] if s['sourceId']==a['sourceRefs'][0]['sourceId'])['experimentRole']=='prior']
    original=load(Path(input_root)/'repeat-0/prior.json')
    global_old=lineage.observation(archive,'capability:global:v1',original['text'],priors,[])
    local_old=lineage.observation(archive,'capability:local:v1',
        '旅人说去年保存的介绍把登记处标在隔壁小屋；我目前只听到他的说法，尚未独立核实这次的位置。',ids['player_report'],[])
    archive['observations']=[global_old,local_old]
    lineage.bridge.episode.validate_units(archive)
    return archive,tick,{'local':(local_old,ids['actual_read'],1),
                        'global':(global_old,ids['player_report']+ids['actual_read'],0)}

def run(root,input_root):
    root=Path(root).resolve();input_root=Path(input_root).resolve()
    if root.exists():raise ValueError('fresh output directory required')
    root.mkdir(parents=True)
    files=[input_root/'protocol.json',input_root/'audit.json',input_root/'repeat-0/prior.json',
           input_root/'repeat-0/world.sqlite',input_root/'repeat-0/memory.sqlite']
    frozen={str(p):filehash(p) for p in files}
    archive,tick,cases=build_archive(input_root)
    lineage.save(root/'authorized-archive.json',archive)
    lineage.save(root/'protocol.json',{'inputRoot':str(input_root),'frozen':frozen,'updateTick':tick,
        'model':'gemini-3.7-flash','repeats':3,'cases':['local','global'],'maxUpdateCalls':6,
        'newJevCalls':0,'labelsNeverSent':True,'protocolChanged':False,
        'limits':['known family assignment; no automatic family discovery',
          'local initial body researcher-authored from actual reported speech',
          'global body reused verbatim; update classified without expected relation supplied',
          'same source snapshot repeated independently, not six sequential updates',
          'one sign is evidence of displayed text, not a verdict on actual registration location or intention']})
    os.environ['HCW_HINDSIGHT_UTILITY_TRACE']=str(root/'utility-calls.jsonl')
    evidence_before=lineage.digest({k:archive[k] for k in ('sources','facts','episodes')})
    no_new=[]
    for case,(old,new_ids,formed) in cases.items():
        no_new.append(lineage.update(archive,old,[],'family:capability:'+case,formed,formed,tick,
            lambda *_: (_ for _ in ()).throw(AssertionError('no-evidence update called model'))))
    lineage.save(root/'no-new-evidence.json',no_new)
    results=[]
    for repeat in range(3):
        for case in ('local','global'):
            old,new_ids,formed=cases[case]
            try:
                record=lineage.update(archive,old,new_ids,'family:capability:'+case,formed,formed,tick)
                row={'case':case,'repeat':repeat,'status':'accepted','record':record}
            except (ValueError,TypeError) as error:
                row={'case':case,'repeat':repeat,'status':'rejected','error':str(error)}
            if evidence_before!=lineage.digest({k:archive[k] for k in ('sources','facts','episodes')}):
                raise ValueError('evidence mutated')
            lineage.save(root/(case+'-'+str(repeat)+'.json'),row);results.append(row)
            print(json.dumps({'case':case,'repeat':repeat,'status':row['status'],
              'relation':row.get('record',{}).get('relation')},ensure_ascii=True),flush=True)
    if any(filehash(p)!=h for p,h in frozen.items()):raise ValueError('original changed')
    lineage.save(root/'summary.json',{'results':len(results),'accepted':sum(r['status']=='accepted' for r in results),
      'evidenceUnchanged':True,'originalUnchanged':True,'newJevCalls':0,
      'relations':[{'case':r['case'],'repeat':r['repeat'],'relation':r.get('record',{}).get('relation'),
        'status':r['status']} for r in results]})
if __name__=='__main__':
    run(sys.argv[1],sys.argv[2])
