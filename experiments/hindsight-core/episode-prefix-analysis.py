"""Objective study aggregates. Manual judgments remain in a separate assessment."""
import argparse, hashlib, json, statistics
from collections import Counter
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('study',type=Path);a=p.parse_args();s=a.study
read=lambda p:json.loads(p.read_text(encoding='utf-8'))
write=lambda p,v:p.write_text(json.dumps(v,ensure_ascii=False,indent=2),encoding='utf-8')
retrieval=read(s/'retrieval-summary.json');compression=read(s/'compression.json')
def describe(values):
 return {'n':len(values),'mean':statistics.mean(values) if values else None,
         'median':statistics.median(values) if values else None,'sum':sum(values)}
def signature(response):
 if not isinstance(response,dict):return ('invalid',)
 if response.get('decision')=='perform':return ('perform',response.get('actionType'),json.dumps(response.get('parameters'),sort_keys=True,ensure_ascii=False))
 return (response.get('decision'),)
summary={'retrievalCalls':retrieval['calls'],'oldRecordedReproduced':retrieval['oldReproducedRecordedIds'],
 'finalCompression':[x for x in compression if x['checkpoint']=='turn-0120'],
 'retrieval':{},'behavior':{}}
for mode in ['old','new']:
 rows=[x[mode] for x in retrieval['callsMetrics']]
 counts=Counter();graph=0
 for path in (s/'retrieval').glob('*.json'):
  result=read(path)[mode]
  for unit in result['results']:counts.update([unit.get('memoryLevel',unit['kind'])]);graph+=int('graph_rank' in unit['sourceRanks'])
 summary['retrieval'][mode]={'nonemptyCalls':sum(x['units']>0 for x in rows),
  'units':describe([x['units'] for x in rows]),'textChars':describe([x['textChars'] for x in rows]),
  'payloadJsonChars':describe([x['payloadJsonChars'] for x in rows]),
  'duplicateSourceOccurrences':describe([x['duplicateSourceOccurrences'] for x in rows]),
  'recentSourceOccurrences':describe([x['recentSourceOccurrences'] for x in rows]),
  'maxSourceAgeTicks':max((x['maxSourceAgeTicks'] or 0 for x in rows),default=0),
  'selectedLevels':dict(counts),'selectedWithGraphContribution':graph}
summary['retrieval']['native']={'payloadJsonChars':describe([x['nativeMemoryJsonChars'] for x in retrieval['callsMetrics']]),
 'nonemptyCalls':sum(x['nativeMemoryUnits']>0 for x in retrieval['callsMetrics'])}
summary['retrieval']['sameSourceSetCalls']=sum(x['oldNewSameSourceSet'] for x in retrieval['callsMetrics'])
summary['retrieval']['sourceJaccard']=describe([x['sourceJaccard'] for x in retrieval['callsMetrics']])
summary['retrieval']['nonemptySourceJaccard']=describe([x['sourceJaccard'] for x in retrieval['callsMetrics'] if x['old']['units'] or x['new']['units']])
behavior_files=list((s/'behavior').glob('*.json')) if (s/'behavior').exists() else []
records={}
for path in behavior_files:
 if '.attempt-' in path.name:continue
 record=read(path)
 if record.get('response') is not None:records[(record['traceId'],record['mode'])]=record
for mode in ['native','old','new']:
 rows=[r for (_,m),r in records.items() if m==mode]
 summary['behavior'][mode]={'returned':len(rows),'decisions':dict(Counter(r['response'].get('decision') for r in rows)),
  'performTargets':dict(Counter(json.dumps(signature(r['response'])[1:],ensure_ascii=False) for r in rows if r['response'].get('decision')=='perform')),
  'schemaValid':sum(r['validation']['wireSchemaValid'] for r in rows),'structureValid':sum(r['validation']['structureValid'] for r in rows)}
paired=[];sameinput=[];recordedrift=[]
for path in sorted((s/'retrieval').glob('*.json')):
 c=read(path);ident=c['traceId']
 if all((ident,m) in records for m in ['native','old','new']):
  row={'traceId':ident,**{m:signature(records[(ident,m)]['response']) for m in ['native','old','new']},
       'recorded':signature(c['originalResponse']),
       'oldNewInputIdentical':records[(ident,'old')]['inputHash']==records[(ident,'new')]['inputHash']}
  paired.append(row)
  if row['oldNewInputIdentical']:sameinput.append(row)
  if row['recorded']!=row['old']:recordedrift.append(row)
summary['behavior']['pairedCalls']=len(paired)
summary['behavior']['oldNewDecisionDisagreements']=sum(r['old'][0]!=r['new'][0] for r in paired)
summary['behavior']['oldNewActionSignatureDisagreements']=[r for r in paired if r['old']!=r['new']]
summary['behavior']['nativeNewActionSignatureDisagreements']=[r for r in paired if r['native']!=r['new']]
summary['behavior']['recordedOldFreshOldDisagreements']=recordedrift
summary['behavior']['identicalOldNewInputs']={'calls':len(sameinput),'signatureDisagreements':sum(r['old']!=r['new'] for r in sameinput)}
write(s/'analysis-summary.json',summary)





# Verify the final delivered source mappings and that only memory fields changed.
original=Path(read(s/'protocol.json')['original'])
def without_memory(request):
 result={**request,'context':{k:v for k,v in request['context'].items() if k!='memories'}}
 if 'recallEvidence' in request:
  result['recallEvidence']={k:v for k,v in request['recallEvidence'].items() if k!='memories'}
 return result
audit={'savedRequestPairs':0,'changedNonMemoryRequestFields':[],
 'freshOldModelCallMismatchTraceIds':[],'deliveredSourceReferencesChecked':0,
 'newObservationSelectedTraceIds':[],'changedOriginalFiles':[]}
for path in sorted((s/'retrieval').glob('*.json')):
 c=read(path);t=read(original/'traces'/path.name);audit['savedRequestPairs']+=1
 if without_memory(c['requests']['old'])!=without_memory(c['requests']['new']):
  audit['changedNonMemoryRequestFields'].append(c['traceId'])
 old_record=records.get((c['traceId'],'old'))
 if old_record is not None and old_record['modelCall']!=t['modelCall']:
  audit['freshOldModelCallMismatchTraceIds'].append(c['traceId'])
 if any(u['kind']=='observation' for u in c['new']['results']):audit['newObservationSelectedTraceIds'].append(c['traceId'])
 doc=read(s/c['snapshot'].replace('index.json','prepared.json'));by_id={x['sourceId']:x for x in doc['sources']}
 for unit in c['requests']['new']['context']['memories']:
  for ref in unit['sourceRefs']:
   source=by_id[ref['sourceId']]
   assert ref['characterId']==t['actorId'] and ref['worldAddress']==doc['scope']['worldAddress']
   assert ref['worldSeq']<=t['headSeq'] and source['knownTick']<=t['tick']
   assert {k:source[k] for k in ref}==ref
   audit['deliveredSourceReferencesChecked']+=1
protocol=read(s/'protocol.json')
for rel,expected in protocol['originalHashes'].items():
 if hashlib.sha256((original/rel).read_bytes()).hexdigest()!=expected:audit['changedOriginalFiles'].append(rel)
audit['frozenOriginalFiles']=len(protocol['originalHashes'])
audit['coreHashesUnchanged']=all(hashlib.sha256((Path(__file__).parent/name).read_bytes()).hexdigest()==expected for name,expected in protocol['codeHashes'].items())
audit['observationsMissionMatchesOriginal']=protocol['observationsMission']==read(original/'protocol.json')['observationsMission']
assert audit['coreHashesUnchanged'] and audit['observationsMissionMatchesOriginal']
assert not audit['changedOriginalFiles'] and not audit['changedNonMemoryRequestFields'] and not audit['freshOldModelCallMismatchTraceIds']
write(s/'final-audit.json',audit)
summary['audit']=audit
for key,file in [('manualAssessment','manual-assessment.json'),('embeddingLengths','embedding-lengths.json'),('behaviorConfirmation','behavior-confirmation-summary.json')]:
 if (s/file).exists():summary[key]=read(s/file)
write(s/'analysis-summary.json',summary)



print(json.dumps({'retrievalCalls':summary['retrievalCalls'],'oldReproduced':summary['oldRecordedReproduced'],'behaviorPairs':summary['behavior']['pairedCalls'],'audit':audit},ensure_ascii=False))
