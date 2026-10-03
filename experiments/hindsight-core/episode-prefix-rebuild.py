"""Rebuild every recorded character-authorized prefix; original run stays read-only."""
import argparse, hashlib, json, os, sqlite3, time, traceback
from pathlib import Path
import core
import episode_core as episode
import vector_core as vector

p=argparse.ArgumentParser()
p.add_argument('original',type=Path);p.add_argument('output',type=Path)
p.add_argument('--init',action='store_true');p.add_argument('--actor',choices=['companion','friend','host'])
a=p.parse_args();original=a.original.resolve();output=a.output.resolve()

def read(path):return json.loads(path.read_text(encoding='utf-8'))
def write(path,value):
 path.parent.mkdir(parents=True,exist_ok=True)
 temp=path.with_suffix(path.suffix+'.tmp')
 temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(path)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def append(path,value):
 with path.open('a',encoding='utf-8') as f:f.write(json.dumps(value,ensure_ascii=False)+'\n')

code_files=['core.py','episode_core.py','vector_core.py']
code_hashes={name:digest(Path(__file__).parent/name) for name in code_files}
if a.init:
 if output.exists():raise SystemExit('use a new study output directory')
 output.mkdir(parents=True)
 frozen=[original/name for name in ['protocol.json','progress.json','rounds.jsonl','consolidation.jsonl','base/world.sqlite','base/memory.sqlite']]
 frozen+=sorted((original/'snapshots').glob('*/*/*.json'))+sorted((original/'traces').glob('*.json'))
 protocol={'original':str(original),'model':os.getenv('HCW_LOCAL_MODEL','gemini-3.7-flash'),
  'actors':['companion','friend','host'],'sourceBatchSize':8,'codeHashes':code_hashes,
  'observationsMission':read(original/'protocol.json').get('observationsMission',''),
  'originalHashes':{str(path.relative_to(original)):digest(path) for path in frozen},
  'retrieval':'all 137 saved queries, original recent-source exclusion, limit 8, fixed vector/RRF parameters',
  'behavior':'135 returned calls; fresh native/old/new first responses plus original recorded response; proposals not executed',
  'assessment':'manual relevance/noise sample selected before new results; no model judging or scripted stimuli',
  'compression':'text and serialized memory payload separately; ratios above 1 mean expansion'}
 traces=[read(path) for path in sorted((original/'traces').glob('*.json'))]
 sample=set()
 for actor in protocol['actors']:
  for start,end in [(1,30),(31,60),(61,90),(91,120)]:
   candidates=[t for t in traces if t['actorId']=='character:'+actor and start<=t['playerTurn']<=end and t['selected']]
   if candidates:sample.add(candidates[len(candidates)//2]['id'])
 sample.update(['turn-0027-call-001-companion','turn-0074-call-001-friend','turn-0092-call-001-friend'])
 protocol['manualSampleTraceIds']=sorted(sample)
 write(output/'protocol.json',protocol)
 print(json.dumps({'initialized':str(output),'frozenFiles':len(frozen),'manualSampleCalls':len(sample)}),flush=True)
 raise SystemExit(0)

protocol=read(output/'protocol.json')
if protocol['original']!=str(original) or protocol['codeHashes']!=code_hashes:raise SystemExit('study protocol changed')
if not a.actor:raise SystemExit('provide --actor')
actor='character:'+a.actor
# Host-side read-only audit. The memory core gets only this owner's exported sources.
with sqlite3.connect((original/'base/memory.sqlite').as_uri()+'?mode=ro',uri=True) as db:
 rows={(r[0],r[1]):r[2:] for r in db.execute('SELECT namespace_key,source_id,source_hash,source_seq,epistemic_kind,text_value FROM cognitive_memory_v2_sources')}
with sqlite3.connect((original/'base/world.sqlite').as_uri()+'?mode=ro',uri=True) as db:
 ticks={(r[0],r[1]):r[2] for r in db.execute('SELECT address_key,seq,tick FROM events')}

def validate_sources(data):
 scope=data['scope'];address=scope['worldAddress'];key='\x1f'.join(address[k] for k in ['tenantId','worldId','branchId'])
 assert scope['characterId']==actor
 for source in data['sources']:
  assert source['characterId']==actor and source['worldAddress']==address and source['worldSeq']<=scope['asOfWorldSeq']
  assert (source['sourceHash'],source['worldSeq'],source['epistemicKind'],source['text'])==rows[(key+'\x1f'+actor,source['sourceId'])]
  assert source['knownTick']==ticks[(key,source['worldSeq'])]
 core.check_sources(data)

jobdir=output/'actors'/a.actor;jobdir.mkdir(parents=True,exist_ok=True)
active={'checkpoint':None,'operation':None}
base_llm=core.llm

def audited_llm(system,user,max_tokens=1600):
 number=len(list((jobdir/'calls').glob('*.json'))) if (jobdir/'calls').exists() else 0
 path=jobdir/'calls'/('call-'+str(number).zfill(4)+'.json')
 record={**active,'system':system,'user':user,'maxOutputTokens':max_tokens,'inputChars':len(system)+len(user),'output':None}
 write(path,record);start=time.perf_counter()
 try:
  value=base_llm(system,user,max_tokens)
  record.update(output=value,elapsedMs=round((time.perf_counter()-start)*1000))
  write(path,record);return value
 except Exception as error:
  record.update(error=str(error),elapsedMs=round((time.perf_counter()-start)*1000));write(path,record);raise
core.llm=audited_llm

def perform(name,fn,doc,batchdir):
 active['operation']=name
 path=batchdir/(name+'.json')
 if path.exists():
  cached=read(path)
  if cached['input']!=doc:raise ValueError('cached operation input changed')
  return cached['output']
 result=fn(doc);write(path,{'input':doc,'output':result});return result

state=None
try:
 for path in sorted((original/'snapshots').glob('*/'+a.actor+'/prepared.json')):
  checkpoint=path.parent.parent.name;active['checkpoint']=checkpoint
  original_data=read(path);validate_sources(original_data)
  directory=output/'snapshots'/checkpoint/a.actor
  if (directory/'prepared.json').exists() and (directory/'index.json').exists():
   state=read(directory/'prepared.json')
   assert state['scope']==original_data['scope'] and state['sources']==original_data['sources']
   episode.validate_units(state);continue
  if state is None:
   state={'scope':original_data['scope'],'memoryGrain':'episode','sources':[],
    'representations':[],'facts':[],'episodes':[],'observations':[],
    'observationsMission':protocol['observationsMission']}
  state={**state,'scope':original_data['scope']}
  old={s['sourceId']:s for s in state['sources']}
  now={s['sourceId']:s for s in original_data['sources']}
  assert all(now.get(ident)==source for ident,source in old.items()),'authorized prefix changed'
  incoming=[s for s in original_data['sources'] if s['sourceId'] not in old]
  for offset in range(0,len(incoming),8):
   batchdir=directory/'batches'/str(offset//8)
   batch=incoming[offset:offset+8]
   retained=perform('retain',episode.retain,{'scope':state['scope'],'sources':batch},batchdir)
   state.update(sources=state['sources']+batch,facts=state['facts']+retained['facts'],
    representations=state['representations']+retained['representations'])
   grouping=perform('group',episode.group,state,batchdir);state['episodes']=grouping['episodes']
   integrated=perform('consolidate',episode.consolidate,state,batchdir);state['observations']=integrated['observations']
   episode.validate_units(state)
  assert state['sources']==original_data['sources']
  validate_sources(state);episode.validate_units(state)
  indexed=vector.index(state)
  write(directory/'prepared.json',state);write(directory/'index.json',indexed)
  stats={'actor':a.actor,'checkpoint':checkpoint,'sources':len(state['sources']),'atoms':len(state['facts']),
   'episodes':len(state['episodes']),'observations':len(state['observations'])}
  append(jobdir/'progress.jsonl',stats);print(json.dumps(stats),flush=True)
 write(jobdir/'complete.json',{'actor':actor,'checkpoints':27,'sources':len(state['sources']),
  'atoms':len(state['facts']),'episodes':len(state['episodes']),'observations':len(state['observations'])})
except Exception:
 append(jobdir/'errors.jsonl',{**active,'traceback':traceback.format_exc()});raise
