"""Author-only comparison; reuse the existing world/permission audit and check actual call accounting."""
import importlib.util
import json
import sys
from pathlib import Path


def offers_perform(call):
    decision = call['schema'].get('properties', {}).get('decision', {})
    return 'perform' in decision.get('enum', []) or decision.get('const') == 'perform'


def main(directory):
    build = json.loads((directory / 'build.json').read_text(encoding='utf-8'))
    spec = importlib.util.spec_from_file_location('existing_audit', Path(__file__).with_name('hidden-cure-next-audit.py'))
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    rows, failures = [], []
    for mode in [arm['mode'] for arm in build['executions']]:
        runs = sorted((directory / mode).glob('live-*'))
        for run in runs:
            if not (run / 'summary.json').exists():
                failures.append(f'{mode}/{run.name}: missing completed summary')
                continue
            if checker.audit(run):
                failures.append(f'{mode}/{run.name}: authority/source audit failed')
            for summary in json.loads((run / 'summary.json').read_text(encoding='utf-8')):
                case = summary['name']
                record = json.loads((run / case / 'record.json').read_text(encoding='utf-8'))
                settings = record['meta']['settings']
                explained_calls, explained_options = 0, 0
                if build.get('actionSemantics'):
                    for index, call in enumerate(record['calls']):
                        context=call['input']['context']
                        explanations=context.get('actionExplanations', [])
                        if mode=='baseline' and explanations:
                            failures.append(f'{mode}/{case} call {index}: baseline has semantic options')
                        if explanations:
                            explained_calls+=1
                            explained_options+=len(explanations)
                            if not offers_perform(call):
                                failures.append(f'{mode}/{case} call {index}: semantics expose unavailable perform')
                        destinations=[d['locationId'] for offer in context.get('affordances', []) if offer['actionType']=='move' for d in offer.get('destinations', [])]
                        interactions=[{key:option.get(key, {}) if key=='arguments' else option[key] for key in ['targetRef','bindingId','definitionRef','arguments']}
                                      for offer in context.get('affordances', []) if offer['actionType']=='interact' for option in offer.get('interactions', [])]
                        if mode!='baseline' and call['input'].get('canPerform') and not call.get('formatRepair') and len(explanations)!=len(destinations)+len(interactions):
                            failures.append(f'{mode}/{case} call {index}: explanation coverage differs from offered operations')
                        for explanation in explanations:
                            operation=explanation['operation']
                            valid=operation['decision']=='perform' and (
                                operation['actionType']=='move' and operation['parameters']=={'locationId':operation['parameters'].get('locationId')} and operation['parameters'].get('locationId') in destinations
                                or operation['actionType']=='interact' and operation['parameters'] in interactions)
                            if not valid:
                                failures.append(f'{mode}/{case} call {index}: explanation invents an operation or parameter')
                if build.get('beforeAction'):
                    if record['meta'].get('beforeActionExpression') != (mode=='experiment'):
                        failures.append(f'{mode}/{case}: pre-action switch mismatch')
                    for index, call in enumerate(record['calls']):
                        offered='before' in call['schema'].get('properties', {})
                        expected=mode=='experiment' and offers_perform(call)
                        if offered!=expected:
                            failures.append(f'{mode}/{case} call {index}: pre-action schema availability mismatch')
                        if (call.get('proposal') or {}).get('before') and not offered:
                            failures.append(f'{mode}/{case} call {index}: pre-action expression not offered')
                if build.get('decisionThinking') or build.get('intentClarity') or build.get('actionSemantics') or build.get('beforeAction'):
                    arm=next(arm for arm in build['executions'] if arm['mode']==mode)
                    if record['meta']['thinkingLevel'] != arm['thinking'] or record['meta']['continueAfterPublish']:
                        failures.append(f'{mode}/{case}: thinking or publication setting mismatch')
                    for index, call in enumerate(record['calls']):
                        if call['generation'].get('reasoning_effort') != arm['thinking'] or call['generation'].get('max_tokens') != 32768:
                            failures.append(f'{mode}/{case} call {index}: thinking request or output cap mismatch')
                accounting = []
                for turn in record['rounds']:
                    debug = turn['debug']
                    ordinary = debug.get('activationCycle') or {}
                    autonomy = debug.get('autonomy') or {}
                    counted = ordinary.get('calls', 0) + autonomy.get('autonomousCalls', 0) + autonomy.get('reactionCalls', 0)
                    actual = turn['calls'][1] - turn['calls'][0]
                    if counted != actual:
                        accounting.append({'round': turn['round'], 'counted': counted, 'actual': actual})
                    for value, maximum in [(ordinary.get('calls', 0), settings['maximumNpcCalls']),
                                           (autonomy.get('autonomousCalls', 0), settings['autonomyNpcCalls']),
                                           (autonomy.get('reactionCalls', 0), settings['autonomyReactionCalls'])]:
                        if value > maximum:
                            failures.append(f'{mode}/{case} round {turn["round"]}: exceeded call budget')
                if accounting:
                    failures.append(f'{mode}/{case}: actual/count mismatch')
                events = [e for e in record['final']['events'] if e['seq'] > record['initial']['seq']]
                actions = [a for a in record['final']['actions'] if a['seq'] > record['initial']['seq']]
                pre_action_commits=[]
                if build.get('beforeAction'):
                    for event in events:
                        if event['eventType']!='action.resolved' or ':before:action' not in event['data'].get('actionId',''):
                            continue
                        prior=event['data']
                        operation_id=prior['actionId'].replace(':before:action',':action')
                        actual=next((e for e in events if e['eventType']=='action.resolved' and e['data']['actionId']==operation_id),None)
                        expression=next((e for e in events if e['transactionId']==event['transactionId'] and e['eventType']=='character.speak'),None)
                        if not expression or not prior['accepted'] or not actual or actual['seq']<=event['seq'] or actual['data']['actorId']!=prior['actorId'] or actual['data']['actionType'] not in ['move','interact']:
                            failures.append(f'{mode}/{case}: pre-action commit is not followed by its own adjudicated operation')
                        pre_action_commits.append({'actor':prior['actorId'],'expressionSeq':expression['seq'] if expression else None,
                            'operationSeq':actual['seq'] if actual else None,'accepted':actual['data']['accepted'] if actual else None,
                            'expression':expression['data'] if expression else None,'operationId':operation_id})
                        if expression and actual:
                            turn=next(r for r in record['rounds'] if any(e['seq']==event['seq'] for e in r['newEvents']))
                            texts=[s['text'] for s in expression['data']['segments']]
                            matched=next(((i,c) for i,c in enumerate(record['calls']) if c['round']==turn['round'] and c['actor']==prior['actorId']
                                and [s['text'] for s in (c.get('proposal') or {}).get('before',{}).get('segments',[]) if isinstance(s,dict)]==texts),None)
                            continuation=next((c for c in record['calls'][matched[0]+1:] if c['round']==turn['round'] and c['actor']==prior['actorId'] and c['input'].get('result')),None) if matched else None
                            pre_action_commits[-1]['round']=turn['round']
                            pre_action_commits[-1]['resultSeen']=continuation['input']['result'] if continuation else None
                            if not matched or not continuation or continuation['input']['result']['action']!={k:matched[1]['proposal'][k] for k in ['actionType','parameters']} or any(t not in json.dumps(continuation['input'],ensure_ascii=False) for t in texts):
                                failures.append(f'{mode}/{case}: result request misses its own pre-action expression or real operation result')
                moves = [{'seq': e['seq'], **e['data']} for e in events if e['eventType'] == 'character.moved']
                transfers = [{'seq': e['seq'], **e['data']} for e in events if e['eventType'] == 'entity.transferred']
                continuations = []
                publications = []
                for index, call in enumerate(record['calls']):
                    if call['input'].get('afterPublication'):
                        next_call = next((c for c in record['calls'][index+1:]
                                          if c['round']==call['round'] and c['actor']==call['actor']), None)
                        publications.append({'call':index,'round':call['round'],'actor':call['actor'],
                                             'decision':(call.get('proposal') or {}).get('decision'),
                                             'nextResult':next_call['input'].get('result') if next_call else None})
                    result = call['input'].get('result', {})
                    if result.get('status') == 'accepted' and result.get('action', {}).get('actionType') == 'move':
                        context = call['input']['context']
                        continuations.append({'call': index, 'round': call['round'], 'actor': call['actor'],
                                              'people': context.get('scene', {}).get('people', []),
                                              'highlightedScene': call['input'].get('currentSceneAfterMove'),
                                              'proposal': call.get('proposal')})
                (run / case / 'move-review.json').write_text(json.dumps(continuations, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
                rows.append({'mode': mode, 'case': case, 'directory': str(run), **summary,
                             'thinkingLevel': record['meta']['thinkingLevel'],
                             'semanticExplanations': {'calls':explained_calls,'options':explained_options},
                             'performAvailability': {
                                 'offered': sum(offers_perform(call) for call in record['calls']),
                                 'notOfferedAfterAction': sum(not offers_perform(call) and bool(call['input'].get('result')) for call in record['calls']),
                                 'notOfferedFormatRepair': sum(not offers_perform(call) and bool(call.get('formatRepair')) for call in record['calls']),
                                 'notOfferedOther': sum(not offers_perform(call) and not call['input'].get('result') and not call.get('formatRepair') for call in record['calls']),
                             },
                             'decisions': {decision:sum((call.get('proposal') or {}).get('decision')==decision for call in record['calls'])
                                           for decision in ['perform','publish','abstain','recall']},
                             'reasoningTokens':sum(c.get('usage', {}).get('completion_tokens_details', {}).get('reasoning_tokens', 0) or 0 for c in record['calls']),
                             'callsWithReasoningUsage':sum('reasoning_tokens' in (c.get('usage', {}).get('completion_tokens_details') or {}) for c in record['calls']),
                             'formatRepairs': sum(bool(c.get('formatRepair')) for c in record['calls']),
                             'failedHttp': [i for i, c in enumerate(record['calls']) if c.get('httpStatus') != 200],
                             'accountingFailures': accounting, 'moves': moves, 'transfers': transfers,
                             'rejectedActions': [a for a in actions if not a.get('accepted')],
                             'staleActivations': sum(a['result']['status'] == 'stale' for r in record['rounds']
                                for group in [r['debug'].get('activationCycle') or {}, r['debug'].get('autonomy') or {}]
                                for a in group.get('activations', [])),
                             'moveContinuations': len(continuations)})
                rows[-1]['postPublicationDecisions'] = publications
                rows[-1]['preActionExpressions'] = [{'call':index,'round':call['round'],'actor':call['actor'],'proposal':call['proposal']}
                    for index,call in enumerate(record['calls']) if (call.get('proposal') or {}).get('before')]
                rows[-1]['preActionCommits']=pre_action_commits
    if build.get('decisionThinking') or build.get('intentClarity') or build.get('actionSemantics'):
        changed=[path for path, value in build['sources'].items() if value['baseline']!=value['experiment']]
        expected_change='packages/provider-chat/src/character-context-text.ts' if build.get('actionSemantics') else 'packages/provider-chat/src/prototype-turn.ts'
        if changed!=[expected_change] or len({arm['bundleHash'] for arm in build['executions'] if arm['mode']!='baseline'})!=1:
            failures.append('thinking comparison changes more than the prompt or uses different improved executables')
    if build.get('publishLoop') or build.get('beforeAction'):
        if any(value['baseline'] != value['experiment'] for value in build['sources'].values()) or len({item['bundleHash'] for item in build['executions']}) != 1:
            failures.append('publish-loop comparison uses different source or executable')
    for case in build['cases']:
        pair = [r for r in rows if r['case'] == case]
        expected={arm['mode'] for arm in build['executions']}
        if len(pair) != len(expected) or {r['mode'] for r in pair} != expected:
            failures.append(f'{case}: missing or duplicate comparison arms')
        else:
            records = [json.loads((Path(r['directory']) / case / 'record.json').read_text(encoding='utf-8')) for r in pair]
            if build.get('publishLoop'):
                for row, record in zip(pair, records):
                    if record['meta'].get('continueAfterPublish') != (row['mode'] == 'experiment'):
                        failures.append(f'{case}: publication switch does not match comparison arm')
            for key in ['model', 'settings', 'playerPolicy', 'goal']+([] if build.get('decisionThinking') else ['thinkingLevel']):
                if any(records[0]['meta'][key]!=record['meta'][key] for record in records[1:]):
                    failures.append(f'{case}: comparison mismatch for {key}')
            for key in ['locations', 'record']:
                if any(records[0]['initial'][key]!=record['initial'][key] for record in records[1:]):
                    failures.append(f'{case}: initial state mismatch for {key}')
    report = {'rows': rows, 'failures': failures,
              'limits': 'One paired synthetic trajectory per case; semantic review required; no general reliability or latency claim.'}
    (directory / 'comparison.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'results': [{k: r[k] for k in ['mode','case','rounds','calls','elapsedMs','totalTokens','formatRepairs','errorRounds','moveContinuations']} for r in rows], 'failures': failures}, ensure_ascii=False))
    return bool(failures)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    raise SystemExit(int(main(Path(sys.argv[1]))))
