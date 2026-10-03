"""Compare all saved queries using their exact historical source prefixes."""
import argparse, copy, hashlib, json, statistics, time
from collections import Counter
from pathlib import Path
import episode_core as episode
import vector_core as vector

p=argparse.ArgumentParser();p.add_argument('original',type=Path);p.add_argument('study',type=Path)
a=p.parse_args();original=a.original.resolve();study=a.study.resolve()
read=lambda path:json.loads(path.read_text(encoding='utf-8'))

def write(path,value):
 path.parent.mkdir(parents=True,exist_ok=True)
 path.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')

def filtered(index,request):
 recent={int(o['sourceSeq']) for o in request['context'].get('observations',[])+request['context'].get('selfObservations',[])}
 positions=[i for i,u in enumerate(index['units']) if not all(r['worldSeq'] in recent for r in u['sourceRefs'])]
 units=[index['units'][i] for i in positions];ids={u['id'] for u in units}
 return {**index,'units':units,'vectors':[index['vectors'][i] for i in positions],
  'links':[e for e in index['links'] if e[0] in ids and e[1] in ids]},recent

def memory_payload(selected,sources,tick):
 by_id={s['sourceId']:s for s in sources}
 return [{**u,'memoryId':u['id'],'sourceMaxSeq':max(r['worldSeq'] for r in u['sourceRefs']),
  'sourceAgeTicks':tick-max(by_id[r['sourceId']]['knownTick'] for r in u['sourceRefs']),
  'sourceAges':[{'sourceId':r['sourceId'],'knownTick':by_id[r['sourceId']]['knownTick'],
                'sourceAgeTicks':tick-by_id[r['sourceId']]['knownTick']} for r in u['sourceRefs']],
  'note':'本角色已授权来源的非权威记忆；归纳可能有误，转述、计划、承诺不证明已完成。'} for u in selected]

def chars(value):return len(json.dumps(value,ensure_ascii=False,separators=(',',':')))

def metrics(results,payload,recent,tick,sources):
 refs=[r['sourceId'] for u in results for r in u['sourceRefs']]
 known={s['sourceId']:s['knownTick'] for s in sources}
 return {'units':len(results),'sourceOccurrences':len(refs),'uniqueSources':len(set(refs)),
  'duplicateSourceOccurrences':len(refs)-len(set(refs)),
  'recentSourceOccurrences':sum(known_id['worldSeq'] in recent for u in results for known_id in u['sourceRefs']),
  'textChars':sum(len(u['text']) for u in results),'payloadJsonChars':chars(payload),
  'meanSourceAgeTicks':statistics.mean(tick-known[i] for i in refs) if refs else None,
  'maxSourceAgeTicks':max((tick-known[i] for i in refs),default=None),
  'levels':dict(Counter(u.get('memoryLevel',u['kind']) for u in results))}

protocol=read(study/'protocol.json')
for actor in protocol['actors']:
 if not (study/'actors'/actor/'complete.json').exists():raise SystemExit('rebuild not complete: '+actor)
compress=[]
for oldpath in sorted((original/'snapshots').glob('*/*/prepared.json')):
 rel=oldpath.relative_to(original);newpath=study/rel
 old,new=read(oldpath),read(newpath)
 assert old['scope']==new['scope'] and old['sources']==new['sources']
 episode.validate_units(new)
 raw=sum(len(s['text']) for s in old['sources'])
 for mode,data in [('old',old),('new',new)]:
  source_texts={s['sourceId']:len(s['text']) for s in data['sources']}
  units=data['facts']+data.get('episodes',[])+data['observations']
  atomchars=sum(len(u['text']) for u in data['facts'])
  episodechars=sum(len(u['text']) for u in data.get('episodes',[]))
  obschars=sum(len(u['text']) for u in data['observations'])
  backing={r['sourceId'] for u in data['observations'] for r in u['sourceRefs']}
  compress.append({'checkpoint':oldpath.parent.parent.name,'actorId':data['scope']['characterId'],'mode':mode,
   'sourceCount':len(data['sources']),'rawSourceChars':raw,'factOrAtomCount':len(data['facts']),
   'episodeCount':len(data.get('episodes',[])),'observationCount':len(data['observations']),
   'factOrAtomTextChars':atomchars,'episodeTextChars':episodechars,'observationTextChars':obschars,
   'derivedTextRatio':(atomchars+episodechars+obschars)/raw if raw else 0,
   'derivedJsonRatio':chars(units)/chars(data['sources']) if data['sources'] else 0,
   'observationTextRatioToCitedSources':obschars/sum(source_texts[i] for i in backing) if backing else 0,
   'observationJsonChars':chars(data['observations']),
   'widestObservationSources':max((len(u['sourceRefs']) for u in data['observations']),default=0),
   'widestEpisodeAtoms':max((len(u['eventAtoms']) for u in data.get('episodes',[])),default=0)})
write(study/'compression.json',compress)

comparisons=[];old_matches=0;old_mismatch=[]
for path in sorted((original/'traces').glob('*.json')):
 trace=read(path);out=study/'retrieval'/(trace['id']+'.json')
 if out.exists():
  comparison=read(out)
  comparisons.append(comparison['metrics'])
  old_matches+=comparison['oldReproducedRecordedIds']
  if not comparison['oldReproducedRecordedIds']:old_mismatch.append(trace['id'])
  continue
 old=read(original/trace['snapshot']);new=read(study/trace['snapshot'])
 assert old['scope']==new['scope']
 assert int(new['scope']['asOfWorldSeq'])<=trace['headSeq']
 assert all(s['knownTick']<=trace['tick'] for s in new['sources'])
 old_index,recent=filtered(old,trace['hostRequest']);new_index,_=filtered(new,trace['hostRequest'])
 start=time.perf_counter()
 old_result=vector.recall({'scope':old['scope'],'index':old_index,'query':trace['query'],'limit':8})
 new_result=vector.recall({'scope':new['scope'],'index':new_index,'query':trace['query'],'limit':8})
 reproduced=[u['id'] for u in old_result['results']]==[u['id'] for u in trace['selected']]
 old_matches+=reproduced
 if not reproduced:old_mismatch.append(trace['id'])
 new_payload=memory_payload(new_result['results'],new['sources'],trace['tick'])
 # Use the exact original delivery for the fresh old control. New replaces only its memory.
 delivered=copy.deepcopy(trace['deliveredRequest']);delivered['context']['memories']=new_payload
 if 'recallEvidence' in delivered:delivered['recallEvidence']['memories']=new_payload
 old_ids={r['sourceId'] for u in old_result['results'] for r in u['sourceRefs']}
 new_ids={r['sourceId'] for u in new_result['results'] for r in u['sourceRefs']}
 native=trace['hostRequest']['context'].get('memories',[])
 measure={'traceId':trace['id'],'playerTurn':trace['playerTurn'],'actorId':trace['actorId'],
  'old':metrics(old_result['results'],trace['deliveredRequest']['context']['memories'],recent,trace['tick'],old['sources']),
  'new':metrics(new_result['results'],new_payload,recent,trace['tick'],new['sources']),
  'nativeMemoryUnits':len(native),'nativeMemoryJsonChars':chars(native),
  'sourceJaccard':len(old_ids&new_ids)/len(old_ids|new_ids) if old_ids|new_ids else 1,
  'oldNewSameSourceSet':old_ids==new_ids,'retrievalWallMs':round((time.perf_counter()-start)*1000)}
 comparison={'traceId':trace['id'],'query':trace['query'],'snapshot':trace['snapshot'],'tick':trace['tick'],
  'headSeq':trace['headSeq'],'recentExcludedSeqs':sorted(recent),'oldReproducedRecordedIds':reproduced,
  'old':old_result,'new':new_result,'metrics':measure,
  'requests':{'native':trace['hostRequest'],'old':trace['deliveredRequest'],'new':delivered},
  'originalResponse':trace['modelResponse']}
 write(out,comparison);comparisons.append(measure)
 print(json.dumps({'retrieved':trace['id'],'old':len(old_result['results']),'new':len(new_result['results']),
                   'oldMatches':reproduced}),flush=True)
write(study/'retrieval-summary.json',{'calls':len(comparisons),'oldReproducedRecordedIds':old_matches,
 'oldMismatchTraceIds':old_mismatch,'callsMetrics':comparisons})
# Original files, including both SQLite databases, must remain byte-identical.
changed=[rel for rel,expected in protocol['originalHashes'].items() if hashlib.sha256((original/rel).read_bytes()).hexdigest()!=expected]
assert not changed,changed
write(study/'original-integrity.json',{'frozenFiles':len(protocol['originalHashes']),'changedFiles':changed})
