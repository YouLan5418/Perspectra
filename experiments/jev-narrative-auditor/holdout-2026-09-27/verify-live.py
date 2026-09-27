from pathlib import Path
import json,hashlib,statistics,math
root=Path('experiments/jev-narrative-auditor/holdout-2026-09-27')
def read(name):return json.loads((root/name).read_text(encoding='utf-8'))
def lines(name):return [json.loads(x)for x in (root/name).read_text(encoding='utf-8').splitlines()]
def save(name,value):
 with (root/name).open('x',encoding='utf-8')as f:json.dump(value,f,ensure_ascii=False,indent=2)
def metrics(values):
 values=sorted(values)
 return {'n':len(values),'median':statistics.median(values),'p90':values[math.ceil(len(values)*.9)-1]}
review={j['id']:j for j in read('review-judgments.json')['judgments']}
mapping=read('review-mapping.json')
repair_review=[];verification=[];all_inputs=[]
for name in ['a1','a2','b1','b2']:
 summary=read(name+'-summary.json');events=read(name+'-events.json');drafts=lines(name+'-interventions.jsonl');shadow=lines(name+'-jev-shadow.jsonl');turns=lines(name+'-turns.jsonl')
 all_inputs.append([t['submitted']for t in turns])
 js=[review[m['id']]for m in mapping if m['run']==name]
 for draft in drafts:
  if draft['final']['decision']=='publish':
   next_event=next(e for e in events if e['seq']>draft['baseHeadSeq']and e['eventType']=='character.speak')
   assert next_event['data']['characterId']==draft['actorId']
   assert next_event['data'].get('text','')==draft['final'].get('speech','')
   assert next_event['data'].get('narration','')==draft['final'].get('narration','')
  if not draft['repairAttempted']:continue
  head=draft['baseHeadSeq']
  if name=='b1'and head in [233,327,357]:
   category='correct';reason='Explicit unsupported ground (233) or pickup (327/357) removed.'
  elif name=='b2':
   category='temporal_ambiguous_bad_repair';reason='Draft repeats prior completed release seq281/287 in next player window. Whether a new release or recap is ambiguous. Rewrite explicitly reintroduces current holding, contrary to World; published seq328.'
  else:
   category='unnecessary';reason='Turning/spreading pages, touching a surface, or seeing open pages does not assert holding the book. Flipping watch on tabletop (339) likewise does not establish possession.'
  repair_review.append({'run':name,'head':head,'category':category,'reason':reason,'outcome':draft['outcome'],'changed':draft['original']!=draft['final'],'original':draft['original'],'final':draft['final']})
 npc_no_reply=[];previous=summary['initialSeq']
 for turn in turns:
  head=turn['state']['debug']['headSeq']
  if not any(e['eventType']=='character.speak'and e['data']['characterId']!='character:player'and previous<e['seq']<=head for e in events):npc_no_reply.append(turn['round'])
  previous=head
 verification.append({'name':name,'rounds':summary['rounds'],'npcPublications':len(js),'personConflicts':sum(j['personConflict']for j in js),'groundConflicts':sum(j['groundConflict']for j in js),'repairs':summary['repairCalls'],'primaryCalls':summary['providerCalls'],'roundLatencyMs':metrics([t['elapsedMs']for t in turns]),'preAuditLatencyMs':metrics([d['elapsedMs']for d in drafts]) if name.startswith('b')else None,'characterLimitRounds':summary['activationTerminals'].count('character_limit'),'noNpcReplyRounds':npc_no_reply,'shadowConflicts':sum(r['status']=='CONFLICT'for r in shadow),'shadowErrors':sum(r['status']in ['CALL_FAILED','AUDIT_FAILED','QUEUE_SKIPPED']for r in shadow),'costUsd':summary['jevCostUsd']+summary['preAuditCostUsd'],'failedRounds':summary['failedRounds'],'preAuditFailures':summary['preAuditFailures'],'auditComplete':summary['auditComplete'],'worldUnchangedDuringDrain':summary['unchangedDuringAuditDrain'],'finalsMatchPublication':True})
assert all(x==all_inputs[0]for x in all_inputs)
protocol=read('protocol.json')
unchanged={p:hashlib.sha256(Path(p).read_bytes()).hexdigest()==h for p,h in protocol['sourceHashes'].items()}
assert all(unchanged.values())
summary={'runs':verification,'repairReviewCounts':{c:sum(r['category']==c for r in repair_review)for c in sorted(set(r['category']for r in repair_review))},'frozenSourcesUnchanged':unchanged,'identicalPlayerInputs':True,'totalNpcPublications':sum(r['npcPublications']for r in verification),'liveJevCostUsd':sum(r['costUsd']for r in verification),'liveGatePassed':False,'reason':'Corrected group retains four explicit holder conflicts; ten unnecessary repair attempts and one ambiguous temporal repair that introduces a new current-holder contradiction.','independentHumanReview':False,'causalReductionAccepted':False}
save('repair-review.json',repair_review);save('live-verification.json',summary)
for group in ['a','b']:
 print(group,json.dumps({'roundLatencyMs':metrics([t['elapsedMs']for name in [group+'1',group+'2']for t in lines(name+'-turns.jsonl')]),'preAuditLatencyMs':metrics([d['elapsedMs']for name in [group+'1',group+'2']for d in lines(name+'-interventions.jsonl')])},ensure_ascii=False))
print(json.dumps(summary,ensure_ascii=False,indent=2))
