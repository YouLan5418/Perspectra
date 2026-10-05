"""Normal live-play audit. Reads recorded caches and committed owner events, never calls a model."""
import copy,json,sys
from pathlib import Path
import candidate_admission,minimal_delivery
bridge=candidate_admission.bridge
load=lambda p:json.loads(p.read_text(encoding='utf-8'))
def lines(p):return [json.loads(s) for s in p.read_text(encoding='utf-8').splitlines()] if p.exists() else []
def audit(root):
 stages=load(root/'normal-stages.json');events=load(root/'normal-events.json');sources=load(root/'normal-source-rows.json')
 byseq={e['seq']:e for e in events}
 for a,b in zip(stages,stages[1:]):assert a['afterSeq']==b['beforeSeq']
 for s in sources:
  e=byseq[s['source_seq']];v=e['data']['value'];owner=s['namespace_key'].split('\x1f')[-1]
  if e['event_type']=='observation.upsert':assert v['observerId']==owner
  elif e['event_type']=='character-goal.upsert':
   assert e['data']['characterId']==owner and s['epistemic_kind']=='self_intention'
  else:raise AssertionError('unexpected source event type')
  assert s['source_id']=='event:'+str(e['seq']) and s['source_hash']==e['event_hash']
  assert s['namespace_key']==e['address_key']+'\x1f'+owner
 caches={}
 for p in list(root.glob('refresh-*.json'))+list((root/'memory-core').glob('*.json')):
  cached=load(p);archive=cached['archive'];scope=archive['scope'];owner=scope['characterId'];prefix=scope['asOfWorldSeq']
  key=(owner,prefix)
  if key in caches:assert caches[key]==cached
  caches[key]=cached;bridge.episode.validate_units(archive)
  assert cached['index']['scope']==scope
  for source in archive['sources']:
   row=next(s for s in sources if s['source_id']==source['sourceId'] and s['namespace_key'].split('\x1f')[-1]==owner)
   assert source['text']==row['text_value'] and source['sourceHash']==row['source_hash']
   assert source['worldSeq']==row['source_seq']<=prefix and source['characterId']==owner
   assert source['worldAddress']==scope['worldAddress'] and source['knownTick']==byseq[row['source_seq']]['tick']
 for owner in sorted({key[0] for key in caches}):
  versions=sorted([(prefix,cached['archive']) for (who,prefix),cached in caches.items() if who==owner])
  for (_,old),(_,new) in zip(versions,versions[1:]):
   new_sources={s['sourceId']:s for s in new['sources']};new_atoms={a['id']:a for a in new['facts']}
   assert all(new_sources[s['sourceId']]==s for s in old['sources'])
   assert all(new_atoms[a['id']]==a for a in old['facts'])
 decisions=lines(root/'memory-core/model-trace.jsonl');recalls=lines(root/'memory-core/recall-trace.jsonl')
 assert len(decisions)==len(recalls), 'missing model or recall trace'
 for d,r in zip(decisions,recalls):
  assert d['request']['context']['character']['characterId']==r['actor']
  assert d['request'].get('canRecall') is False and 'recallEvidence' not in d['request']
  projected=(r['result'] or {}).get('delivery',[])
  assert d['request']['context'].get('memories',[])==projected
  for name,value in r['request']['context'].items():
   if name!='memories':assert d['request']['context'][name]==value
 metrics=[]
 for recall in recalls:
  owner=recall['actor'];request=recall['request'];result=recall['result']
  assert request['canRecall'] is False and 'recallEvidence' not in request
  assert not request['context'].get('memories')
  if result is None:continue
  cached=caches[(owner,recall['memoryPrefix'])];archive,index=cached['archive'],cached['index']
  context=request['context'];query_request={'context':{k:context.get(k,[]) for k in ['character','scene','items','stimulus','observations','selfObservations']}}
  candidates,admission=candidate_admission.admit(archive,index,result['baselineRetrieval'],query_request,result['query'])
  assert candidates==result['retrieval']['results'] and admission==result['admission']
  observations={o['id']:o for o in archive['observations']}
  selected=[c['id'] for c in candidates if c['id'] in observations]
  replay=minimal_delivery.deliver(archive,candidates,selected,query_request,recall['tick'],copy.deepcopy(result['query']))
  assert replay['memories']==result['delivery'] and replay['trace']==result['deliveryTrace']
  assert result['jevCalls']==0
  bodies=[m for m in result['delivery'] if m['memoryLevel']=='observation']
  metrics.append({'actor':owner,'headSeq':recall['headSeq'],'memoryPrefix':recall['memoryPrefix'],
   'observationBodies':len(bodies),'incompleteBodies':sum(not m['evidenceCoverage']['complete'] for m in bodies),
   'originalObservationCandidates':sum(c['id'] in observations for c in result['baselineRetrieval']['results']),
   'admittedObservationCandidates':len(selected),'jsonChars':result['deliveryTrace']['jsonChars']})
  for row in result['deliveryTrace']['delivered']:
   for ref in row['sourceRefs']:
    assert ref['characterId']==owner and ref['worldSeq']<=recall['headSeq']
    assert ref['sourceHash']==byseq[ref['worldSeq']]['event_hash']
 for s in stages:
  if s['label'].startswith('refresh'):assert s['beforeSeq']==s['afterSeq'],'refresh modified authoritative facts'
 native=[]
 for e in events:
  if e['event_type']!='action.resolved' or not e['data']['accepted'] or e['data']['actorId']=='character:player':continue
  if e['data']['actionType']=='speak':continue
  action=e['data']['actionId'];owner=e['data']['actorId']
  observed=[v for v in events if v['event_type']=='observation.upsert' and v['data']['value'].get('actionId')==action and v['data']['value']['observerId']==owner]
  assert observed and all(v['transaction_id']==e['transaction_id'] for v in observed)
  native.append({'actor':owner,'actionType':e['data']['actionType'],'seq':e['seq'],'sourceSeqs':[v['seq'] for v in observed]})
 for d,recall in zip(decisions,recalls):
  owner=d['request']['context']['character']['characterId']
  if '青柠七号' not in json.dumps(d['request'],ensure_ascii=False):continue
  # A matching model request is authorized only if the owner had actually received the literal.
  known=[s for s in sources if s['namespace_key'].split('\x1f')[-1]==owner and s['source_seq']<=recall['headSeq'] and '青柠七号' in s['text_value']]
  assert known,'private literal entered a role with no authorized Source'
 actors=sorted({d['request']['context']['character']['characterId'] for d in decisions})
 failures=[{'label':s['label'],'headSeq':s['afterSeq'],'notice':s['state']['notice']} for s in stages if s['state']['error']]
 secret_rows=[s for s in sources if '青柠七号' in s['text_value']]
 secret_owners=sorted({s['namespace_key'].split('\x1f')[-1] for s in secret_rows})
 result={'passed':True,'stages':len(stages),'sourceRows':len(sources),'recordedCharacterDecisions':len(decisions),
  'actors':actors,'failures':failures,'nativeActions':native,'recallRows':metrics,'secretSourceOwners':secret_owners,
  'limits':['mechanical source isolation does not prove narrative consistency','utility call/token traces not enabled on initial live server','single real trajectory, no controlled benefit estimate']}
 (root/'normal-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
 return result
if __name__=='__main__':
 result=audit(Path(sys.argv[1]));print(json.dumps({k:v for k,v in result.items() if k!='recallRows'},ensure_ascii=False))
