"""Two real actor-owned inspect Sources -> unchanged cognition update experiment."""
import copy
import json
import os
import sys
from pathlib import Path
import cognition_lineage as lineage
from notice_board_revision import filehash, ro, load

def build_archive(input_root, repeat):
    directory=Path(input_root)/('repeat-'+str(repeat))
    summary=load(directory/'summary.json')
    selected=[summary['firstSourceId'],summary['secondSourceId']]
    if None in selected or len(set(selected))!=2:
        raise ValueError('two different actual readings required; no substitute synthetic evidence')
    world=ro(directory/'world.sqlite')
    try:
        events={seq:{'tick':tick,'type':kind,'data':json.loads(data),'hash':digest,'transactionId':txn}
          for seq,tick,kind,data,digest,txn in world.execute(
          'SELECT seq,tick,event_type,data_json,event_hash,transaction_id FROM events')}
    finally:world.close()
    memory=ro(directory/'memory.sqlite')
    try:
        rows=memory.execute('SELECT namespace_key,source_id,source_seq,source_hash,epistemic_kind,text_value FROM cognitive_memory_v2_sources').fetchall()
    finally:memory.close()
    sources=[]
    for sid in selected:
        matches=[row for row in rows if row[1]==sid and row[0].split(chr(31))[-1]=='character:npc']
        if len(matches)!=1:raise ValueError('missing or ambiguous actor Source')
        ns,source_id,seq,digest,kind,text=matches[0]
        tenant,world_id,branch,actor=ns.split(chr(31))
        e=events[seq];v=e['data']['value'];c=v['content']
        target='entity:hall-board' if sid==selected[0] else 'entity:distant-board'
        expected='登记处：二楼203' if sid==selected[0] else '登记处：一楼105'
        if (source_id!='event:'+str(seq) or digest!=e['hash'] or kind!='direct_observation'
            or v['observerId']!=actor or json.loads(text)!=c or c['targetId']!=target
            or c['observedText']!=expected or c['capabilityId']!='experiment:inspect-notice-board'):
            raise ValueError('invalid direct read provenance/content')
        if not any(x['type']=='action.resolved' and x['data']['actionId']==v['actionId']
          and x['data']['accepted'] and x['transactionId']==e['transactionId'] for x in events.values()):
            raise ValueError('read was not atomically accepted')
        if any(row[1]==sid and row[0]!=ns for row in rows):
            raise ValueError('direct read escaped actor')
        sources.append({'sourceId':sid,'sourceHash':digest,'worldSeq':seq,'characterId':actor,
          'worldAddress':{'tenantId':tenant,'worldId':world_id,'branchId':branch},
          'epistemicKind':kind,'text':text,'knownTick':e['tick']})
    tick=max(e['tick'] for e in events.values())
    archive={'scope':{'characterId':'character:npc','worldAddress':sources[0]['worldAddress'],'asOfWorldSeq':max(events)},
      'sources':sources,'facts':[],'episodes':[],'observations':[]}
    for source in sources:
        atoms=[]
        for index,part in enumerate(lineage.bridge.episode.segments(source)):
            atom=lineage.bridge.episode.make_atom(source,part,part['context'],index)
            atoms.extend(lineage.bridge.timed([atom],sources))
        archive['facts'].extend(atoms)
        archive['episodes'].extend(lineage.bridge.timed([{'id':'episode:'+source['sourceId'],
          'kind':'episode','memoryLevel':'episode','label':'independent read, not a truth verdict',
          'eventAtomIds':[a['id'] for a in atoms],'eventAtoms':copy.deepcopy(atoms),
          'sourceRefs':lineage.bridge.episode.union_refs(atoms),
          'text':lineage.bridge.episode.episode_text(atoms)}],sources))
    old_projection=load(directory/'old-local.json')
    old_ids=[a['id'] for a in archive['facts'] if a['sourceRefs'][0]['sourceId']==selected[0]]
    new_ids=[a['id'] for a in archive['facts'] if a['sourceRefs'][0]['sourceId']==selected[1]]
    old=lineage.observation(archive,'conflict:local:v1',old_projection['text'],old_ids,[])
    archive['observations']=[old]
    lineage.bridge.episode.validate_units(archive)
    return archive,old,new_ids,old_projection['firstFormedTick'],tick

def run(root,input_root):
    root=Path(root).resolve();input_root=Path(input_root).resolve()
    if root.exists():raise ValueError('fresh output directory required')
    root.mkdir(parents=True)
    files=[input_root/'protocol.json',input_root/'summary.json',
      *[input_root/('repeat-'+str(r))/f for r in range(3)
        for f in ('world.sqlite','memory.sqlite','old-local.json','summary.json')]]
    frozen={str(p):filehash(p) for p in files}
    lineage.save(root/'protocol.json',{'inputRoot':str(input_root),'frozen':frozen,'repeats':3,
      'model':'gemini-3.7-flash','maxUpdateCalls':3,'newJevCalls':0,'protocolChanged':False,
      'limits':['known cognition family; initial local body researcher-authored from real first read',
        'distinct inscriptions are not independent tests of actual room location',
        'no truth preference based on recency; relation not supplied to updater',
        'these are three fresh short episodes, not a 100-turn memory evolution']})
    os.environ['HCW_HINDSIGHT_UTILITY_TRACE']=str(root/'utility-calls.jsonl')
    rows=[]
    for repeat in range(3):
        archive,old,new_ids,formed,tick=build_archive(input_root,repeat)
        lineage.save(root/('archive-'+str(repeat)+'.json'),archive)
        before=lineage.digest(archive)
        no_new=lineage.update(archive,old,[],'family:registration-signs',formed,formed,tick,
          lambda *_: (_ for _ in ()).throw(AssertionError('no-evidence model call')))
        lineage.save(root/('no-new-'+str(repeat)+'.json'),no_new)
        try:
            record=lineage.update(archive,old,new_ids,'family:registration-signs',formed,formed,tick)
            row={'repeat':repeat,'status':'accepted','record':record}
        except (ValueError,TypeError) as error:
            row={'repeat':repeat,'status':'rejected','error':str(error)}
        if before!=lineage.digest(archive):raise ValueError('immutable evidence/history changed')
        lineage.save(root/('update-'+str(repeat)+'.json'),row);rows.append(row)
        print(json.dumps({'repeat':repeat,'status':row['status'],'relation':row.get('record',{}).get('relation'),
          'branches':len(row.get('record',{}).get('current',[]))}),flush=True)
    if any(filehash(p)!=h for p,h in frozen.items()):raise ValueError('frozen source world changed')
    lineage.save(root/'summary.json',{'updates':len(rows),'accepted':sum(r['status']=='accepted' for r in rows),
      'relations':[r.get('record',{}).get('relation') for r in rows],
      'originalUnchanged':True,'evidenceUnchanged':True,'newJevCalls':0})
if __name__=='__main__':run(sys.argv[1],sys.argv[2])
