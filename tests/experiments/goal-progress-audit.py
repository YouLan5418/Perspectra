"""Source/authority and cost audit only. Natural strategy quality requires reading the proposals."""
import json
import sys
import sqlite3
from pathlib import Path

def read(path):
    return json.loads(path.read_text(encoding='utf-8'))

def estimate(text):
    import math
    return math.ceil(sum(1 if ord(c)>127 else 1/3 for c in text))

def inspect_call(call, enabled, events, failures, label):
    context=call['hostRequest']['context']
    actor=context['character']['characterId']
    prefix=context['cognition']['asOfWorldSeq']
    evidence=context.get('recentExecutionEvidence')
    if not enabled and evidence:
        failures.append(label+': disabled projection present')
    if evidence:
        # JavaScript counts UTF-16 units; this conservative supplementary-character check matches it.
        text=json.dumps(evidence,ensure_ascii=False,separators=(',',':'))
        if len(text.encode('utf-16-le'))//2>1200 or len(evidence['items'])>6:
            failures.append(label+': evidence exceeds budget')
        visible=call['input']['context'].get('recentExecutionEvidence')
        clean=[{k:v for k,v in e.items() if k not in ['sourceSeq','observationId','actionId']} for e in evidence['items']]
        if visible != {'items':clean}:
            failures.append(label+': model presentation differs from host evidence')
        for item in evidence['items']:
            record=next((r for r in context.get('observations',[]) if r['id']==item['observationId'] and r['sourceSeq']==item['sourceSeq']),None)
            event=next((e for e in events if e['seq']==item['sourceSeq']),None)
            if not record or not event or item['sourceSeq']>prefix or event['eventType']!='observation.upsert' or event['data']['id']!=item['observationId']:
                failures.append(label+': absent/future/uncommitted source');continue
            value=record['value'];content=value['content']
            if value['observerId']!=actor or event['data']['value']['observerId']!=actor or value['actionId']!=item['actionId'] or content['actorId']!=item['actorId'] or content['status']!=item['result']:
                failures.append(label+': foreign reader, actor or result')
            resolved=next((e for e in events if e['eventType']=='action.resolved' and e['data']['actionId']==item['actionId']),None)
            if not resolved or resolved['seq']>prefix or ('accepted' if resolved['data']['accepted'] else 'rejected')!=item['result'] or resolved['data']['actorId']!=item['actorId']:
                failures.append(label+': evidence has no actual resolved operation')
            if 'resultMetadata' in item and item['resultMetadata']!=content.get('resultMetadata'):
                failures.append(label+': invented custom outcome')
            if 'toLocationId' in item and item['toLocationId']!=content.get('movement',{}).get('toLocationId',content.get('interaction',{}).get('toLocationId')):
                failures.append(label+': invented destination')
            if 'entityId' in item and item['entityId']!=content.get('interaction',{}).get('entityId'):
                failures.append(label+': invented transfer target')
    return {'items':len(evidence['items']) if evidence else 0,
            'modelCharacters':len(json.dumps(call['input']['context'].get('recentExecutionEvidence',{}),ensure_ascii=False,separators=(',',':'))),
            'estimatedModelTokens':estimate(json.dumps(call['input']['context'].get('recentExecutionEvidence',{}),ensure_ascii=False,separators=(',',':')))}

def main(root):
    frozen=read(root/'frozen.json');replay=read(root/'replay.json');summaries=read(root/'summary.json')
    failures=[];rows=[];budgets=[]
    for scenario in frozen:
        for repetition in range(1,4):
            pair=[r for r in replay['results'] if r['scenario']==scenario and r['repetition']==repetition]
            if len(pair)!=2:failures.append(f'{scenario}/{repetition}: incomplete replay');continue
            a=next(r for r in pair if r['mode']=='A');b=next(r for r in pair if r['mode']=='B')
            cleaned=json.loads(json.dumps(b['input']));cleaned['context'].pop('recentExecutionEvidence',None)
            if a['input']!=cleaned or a['schema']!=b['schema']:
                failures.append(f'{scenario}/{repetition}: frozen pair changes another input or schema')
            for call in pair:
                budgets.append(inspect_call(call,call['mode']=='B',frozen[scenario]['initial']['events'],failures,f"replay/{scenario}/{call['mode']}/{repetition}"))
    for summary in summaries:
        scenario=summary['scenario'];mode=summary['mode'];repetition=summary['repetition']
        path=root/f'{mode}-{scenario}-{repetition}'
        record=read(path/'record.json');events=summary['final']['events']
        for database in (path/'world').glob('*.sqlite'):
            with sqlite3.connect(database.resolve().as_uri()+'?mode=ro',uri=True) as connection:
                if connection.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]:
                    failures.append(path.name+': failed SQLite integrity check: '+database.name)
        if record['initial']['events']!=frozen[scenario]['initial']['events'] or len(record['rounds'])!=4:
            failures.append(path.name+': initial state or planned rounds mismatch')
        for i,call in enumerate(record['calls']):
            budgets.append(inspect_call(call,mode=='B',events,failures,f'{path.name}/{i}'))
            context=call['hostRequest']['context'];actor=context['character']['characterId'];prefix=context['cognition']['asOfWorldSeq']
            for observation in context.get('observations',[]):
                source=next((e for e in events if e['seq']==observation['sourceSeq']),None)
                if not source or source['seq']>prefix or source['eventType']!='observation.upsert' or source['data']['value']['observerId']!=actor or observation['value']['observerId']!=actor:
                    failures.append(f'{path.name}/{i}: unauthorized source in original context')
            if call['generation'].get('max_tokens')!=32768 or call['generation'].get('reasoning_effort')!='low':
                failures.append(path.name+': changed model settings')
        for turn in record['rounds']:
            debug=turn['debug'];ordinary=debug.get('activationCycle') or {};autonomy=debug.get('autonomy') or {}
            actual=turn['callRange'][1]-turn['callRange'][0]
            counted=ordinary.get('calls',0)+autonomy.get('autonomousCalls',0)+autonomy.get('reactionCalls',0)
            if actual!=counted:failures.append(path.name+': call accounting mismatch')
            settings=record['meta']['settings']
            if ordinary.get('calls',0)>settings['maximumNpcCalls'] or autonomy.get('autonomousCalls',0)>settings['autonomyNpcCalls'] or autonomy.get('reactionCalls',0)>settings['autonomyReactionCalls']:
                failures.append(path.name+': exceeded call budget')
        live=[e for e in events if e['seq']>record['initial']['head']['headSeq']]
        inspections=[{'seq':e['seq'],**e['data']['value']['content']} for e in live if e['eventType']=='observation.upsert' and e['data']['id'].endswith(':inspection') and e['data']['value']['observerId']=='character:friend']
        transfers=[{'seq':e['seq'],**e['data']} for e in live if e['eventType']=='entity.transferred']
        rows.append({k:summary[k] for k in ['scenario','repetition','mode','calls','elapsedMs','knownTotalTokens','callsWithUsage','errorRounds']})
        rows[-1].update({'inspectionResults':inspections,'transfers':transfers,'finalHolder':summary['final']['document']['holderId'],
                        'moves':[{'seq':e['seq'],**e['data']} for e in live if e['eventType']=='character.moved' and e['data']['characterId']=='character:friend'],
                        'decisions':{d:sum((c.get('proposal') or {}).get('decision')==d for c in record['calls'] if c['actor']=='character:friend') for d in ['perform','publish','abstain','recall']},
                        'formatRepairs':sum(c['formatRepair'] for c in record['calls']),
                        'httpFailures':[i for i,c in enumerate(record['calls']) if c.get('httpStatus')!=200]})
    if len(rows)!=12 or len(replay['results'])!=18:failures.append('incomplete formal experiment')
    for repetition in range(1,3):
        for scenario in frozen:
            a=read(root/f'A-{scenario}-{repetition}'/'record.json');b=read(root/f'B-{scenario}-{repetition}'/'record.json')
            if [r['playerInput'] for r in a['rounds']]!=[r['playerInput'] for r in b['rounds']] or a['meta']['settings']!=b['meta']['settings']:
                failures.append(f'{scenario}/{repetition}: player policy or settings changed')
    totals={mode:{'calls':sum(r['calls'] for r in rows if r['mode']==mode),'elapsedMs':sum(r['elapsedMs'] for r in rows if r['mode']==mode),
                  'knownTotalTokens':sum(r['knownTotalTokens'] for r in rows if r['mode']==mode),'errorRounds':sum(len(r['errorRounds']) for r in rows if r['mode']==mode)} for mode in ['A','B']}
    report={'rows':rows,'totals':totals,'failures':failures,'projectionBudgetMaxima':{k:max(b[k] for b in budgets) for k in budgets[0]},
            'limits':'Two four-round natural trajectories per condition; finite authored feedback and fixed player input, not general strategy acceptance. Read prose and actual authority separately.'}
    (root/'comparison.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'totals':totals,'projectionBudgetMaxima':report['projectionBudgetMaxima'],'failures':failures},ensure_ascii=False))
    return bool(failures)

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    raise SystemExit(int(main(Path(sys.argv[1]))))
