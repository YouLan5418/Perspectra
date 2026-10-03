"""Audit the new continuous play directory. Host commit diagnostics never enter memory."""
import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path
import core_bridge as bridge

root=Path(sys.argv[1]).resolve()
def read(path): return json.loads(path.read_text(encoding='utf-8'))
def lines(name):
    path=root/name
    return [json.loads(s) for s in path.read_text(encoding='utf-8').splitlines() if s] if path.exists() else []
archives={};source_history={};checkpoints=[]
for directory in sorted(root.glob('checkpoint-*'),key=lambda p:int(p.name.split('-')[1])):
    for path in directory.glob('*-archive.json'):
        actor=path.name.split('-')[0];data=read(path);number=int(directory.name.split('-')[1])
        bridge.episode.validate_units(data);bridge.vector_core.check_mapping(data,bridge.core.check_units(data))
        assert data['sources']==read(directory/(actor+'-input.json'))['sources']
        archives[number,actor]=data
        for s in data['sources']:
            key=actor,s['sourceId']
            if key in source_history: assert source_history[key]==s
            source_history[key]=s
        direct={ident for a in data['facts'] for ident in a.get('activityIds',[])}
        if actor in ('deepseek','glm'): assert not direct, 'nonparticipant received direct game metadata'
        checkpoints.append({'checkpoint':number,'actor':actor,'headSeq':data['scope']['asOfWorldSeq'],
            'sources':len(data['sources']),'atoms':len(data['facts']),'episodes':len(data['episodes']),
            'observations':len(data['observations']),'activities':sorted(direct)})
# This host-side diagnostic reads commits; those events are never fed to retain or recall.
with sqlite3.connect('file:'+str(root/'base/world.sqlite').replace('\\','/')+'?mode=ro',uri=True) as db:
    events=[{'seq':seq,'tick':tick,'type':kind,'value':json.loads(value)} for seq,tick,kind,value in db.execute('SELECT seq,tick,event_type,data_json FROM events ORDER BY seq')]
request_rows=[];records=[];delivered=0;nonempty=0;obs_delivered=0;suppressed=0;game_mentions=[];failures=[];native=[];uncommitted_speech=[]
for path in sorted(root.glob('character-call-*.json'),key=lambda p:int(p.stem.split('-')[-1])):
    row=read(path)
    if row.get('request'):request_rows.append(row)
    if row['status']!='returned':failures.append(row);continue
    actor=row['actor'].split(':')[1];memories=row['request']['context'].get('memories',[])
    game=row['request']['context'].get('activity')
    if actor!='claude' and isinstance(game,dict):assert 'answer' not in game['game']['private']
    output=row.get('response',{})
    speech=output.get('speech') if isinstance(output,dict) else None
    if isinstance(speech,str):
        matching=[e['seq'] for e in events if e['seq']>row['headSeq'] and e['type']=='character.speak' and
                  e['value']['characterId']==row['actor'] and e['value']['text']==speech]
        if not matching:uncommitted_speech.append(row['id'])
    if row['recall'] is None:
        native.append({'call':row['id'],'actor':row['actor'],'rootInput':row['rootInput'],'reason':'no experimental archive at this checkpoint'})
        continue
    data=archives[row['checkpoint'],actor];sources={s['sourceId']:s for s in data['sources']}
    assert row['memoryPrefix']==data['scope']['asOfWorldSeq']<=row['headSeq']
    assert len(memories)<=3 and bridge.projections.chars(memories)<=4500
    nonempty+=bool(memories);delivered+=len(memories);obs_delivered+=sum(m.get('memoryLevel')=='observation' for m in memories)
    trace=row['recall']['deliveryTrace']
    suppressed+=sum('observation' in o['reason'] for o in trace['omitted'])
    for item in trace['delivered']:
        for ref in item['sourceRefs']+item.get('relationSourceRefs',[]):assert ref==bridge.core.source_ref(sources[ref['sourceId']])
    for coverage in trace.get('activityCoverage',[]):
        for ref in coverage['endingSourceRefs']:assert ref==bridge.core.source_ref(sources[ref['sourceId']])
    if isinstance(speech,str) and any(term in speech for term in ('猜数','猜中','主持','逃生','中止','退出','上局','上一局','上次','30','7轮')):
        game_mentions.append({'call':row['id'],'rootInput':row['rootInput'],'actor':row['actor'],'speech':speech,
            'sources':[s for m in memories for s in m.get('sourceIds',[])],'activityCoverage':trace.get('activityCoverage',[])})
    records.append({'call':row['id'],'actor':row['actor'],'rootInput':row['rootInput'],'tick':row['tick'],'prefix':row['memoryPrefix'],
        'nonempty':bool(memories),'items':len(memories),'decision':output.get('decision') if isinstance(output,dict) else 'invalid output',
        'observationOmissions':sum('observation' in o['reason'] for o in trace['omitted']),
        'activityActive':isinstance(game,dict) and game.get('game',{}).get('active') is True,
        'activityAnchorItems':sum(str(t.get('reason','')).startswith('same activity ') for t in trace['delivered']),
        'activityCoverage':trace.get('activityCoverage',[])})
for path in root.glob('player-call-*.json'):
    row=read(path);state=row['request'];game=state.get('activity')
    if isinstance(game,dict):assert 'answer' not in game['game']['private']
    assert not any(k in state for k in ('debug','packVariables'))
inputs=lines('inputs.jsonl');games=lines('games.jsonl');completion=read(root/'completion.json') if (root/'completion.json').exists() else None
windows=[];maximum=max([r['rootInput'] for r in inputs] or [0])
for start in range(1,maximum+1,20):
    block=[r for r in records if start<=r['rootInput']<start+20]
    windows.append({'inputs':str(start)+'-'+str(min(start+19,maximum)),'calls':len(block),'nonempty':sum(r['nonempty'] for r in block),
                    'deliveredItems':sum(r['items'] for r in block),'observationOmissions':sum(r['observationOmissions'] for r in block),
                    'activityAnchorItems':sum(r['activityAnchorItems'] for r in block)})
exact_delivery=[]
if completion or (root/'stopped.json').exists():
    for actor in sorted({actor for _,actor in archives}):
        number=max(n for n,a in archives if a==actor and (root/('checkpoint-'+str(n))/(actor+'-index.json')).exists());data=archives[number,actor]
        index=read(root/('checkpoint-'+str(number))/(actor+'-index.json'))
        own=[r for r in request_rows if r['actor']=='character:'+actor]
        latest=max(own,key=lambda r:r['id'])['request']['context']
        tick=max(s['knownTick'] for s in data['sources'])
        for game in games:
            request={'context':{'character':latest['character'],'scene':latest['scene'],'items':[],
                     'stimulus':[],'observations':[],'selfObservations':[]},
                     'recallEvidence':{'query':'这局是怎么结束的 '+game['activityId']}}
            result=bridge.dispatch({'operation':'recall','archive':data,'index':index,'request':request,'tick':tick,'observations':True})
            coverage=result['deliveryTrace']['activityCoverage']
            if actor in ('gpt','claude'):
                assert len(coverage)==1 and coverage[0]['activityId']==game['activityId'] and coverage[0]['endingIncluded']
            else:assert result['delivery']==[] and coverage==[]
            exact_delivery.append({'actor':actor,'checkpoint':number,'game':game['game'],'activityId':game['activityId'],
                     'delivery':result['delivery'],'coverage':coverage})
    (root/'activity-delivery-new-games.json').write_text(json.dumps(exact_delivery,ensure_ascii=False,indent=2),encoding='utf-8')
resolved=[e for e in events if e['type']=='action.resolved']
report={'completed':bool(completion),'completion':completion,'stopped':read(root/'stopped.json') if (root/'stopped.json').exists() else None,'sourceLineageVerified':True,'sourcesImmutableAcrossCheckpoints':True,
    'noDirectGameMetadataForNonparticipants':True,'noPrivateAnswerPropertyForGuesserOrPlayer':True,
    'returnedCharacterCalls':len(records)+len(native),'experimentalReturnedCalls':len(records),'nativeCalls':native,
    'failedCharacterCalls':len(failures),'nonemptyCalls':nonempty,'deliveredItems':delivered,
    'observationSummariesDelivered':obs_delivered,'observationOmissionEntries':suppressed,
    'decisionCounts':dict(Counter(r['decision'] for r in records)),
    'returnedSpeechWithoutMatchingCommittedEvent':uncommitted_speech,
    'hostCommittedActionCounts':dict(Counter((e['value']['sourceRole']+':'+e['value']['actionType']+':'+str(e['value']['accepted'])) for e in resolved)),
    'committedMoves':[{'seq':e['seq'],**e['value']} for e in events if e['type']=='character.moved'],
    'inputs':len(inputs),'inputErrors':sum(bool(s['error']) for s in inputs),'games':games,'windows':windows,
    'checkpoints':checkpoints,'records':records,'gameMentions':game_mentions,'failures':failures,'resumes':lines('resumes.jsonl'),
    'skippedGames':lines('skipped-games.jsonl'),'exactActivityChecks':len(exact_delivery)}
(root/'live-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k not in {'checkpoints','records','gameMentions','failures','games','committedMoves'}},ensure_ascii=False))
