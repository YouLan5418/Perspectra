"""Read-only stage 6.4 audit of revision, real gaps, natural reading, action and further update."""
import copy, json, sys
from pathlib import Path
from audit_simplification import audit as audit_host, load
from audit_notice_board_action_loop import events, source_rows, check_refs
import delayed_loop
bridge = delayed_loop.bridge
CAPS = ('experiment:inspect-notice-board','experiment:ask_staff','experiment:inspect_terminal')


def revision_check(doc, revision, es):
    before = doc['initial']['archive']; archive = revision['archive']; record = revision['record']
    check_refs(archive,es); bridge.projections.archive(archive)
    assert archive['sources']==doc['sources'] and archive['scope']==doc['scope']
    for key in ('facts','episodes'):
        actual = {u['id']:u for u in archive[key]}
        assert all(actual[u['id']]==u for u in before[key]), 'old evidence changed'
    assert revision['previousCurrent']==before['observations']
    old = before['observations'][0]; generation = record['generationInput']
    assert generation['oldUnderstanding']==old and generation['owner']==doc['scope']
    by_id = {a['id']:a for a in archive['facts']}
    assert generation['oldEvidence']==[by_id[i] for i in old['sourceFactIds']]
    expected_new = {s['sourceId'] for s in archive['sources']} - {s['sourceId'] for s in before['sources']}
    assert set(record['revisionSourceIds'])==expected_new
    assert {r['sourceId'] for a in generation['newEvidence'] for r in a['sourceRefs']}==expected_new
    assert record['firstFormedTick']==doc['firstFormedTick']
    assert doc['firstFormedTick']<=doc['lastRevisedTick']<=doc['tick']
    covered = {i for o in record['current'] for i in o['sourceFactIds']}
    assert covered==set(by_id) and record['current']==archive['observations']
    if record['relation']=='reinforcement': assert record['current'][0]['text']==old['text']
    for source in archive['sources']:
        e = es[source['worldSeq']]; value=e['data']['value']; content=value['content']
        assert content['capabilityId'] in CAPS
        resolution=next(e for e in es.values() if e['eventType']=='action.resolved' and e['data']['actionId']==value['actionId'])
        assert resolution['data']['accepted'] and resolution['transactionId']==e['transactionId']
        assert content['sourceActionId']==value['actionId']
        assert source['epistemicKind']==('reported_speech' if content['capabilityId']=='experiment:ask_staff' else 'direct_observation')
    return {'relation':record['relation'],'currentCount':len(record['current']),'newSourceIds':record['revisionSourceIds'],
        'bodyChanged':[o['text'] for o in record['current']]!=[o['text'] for o in before['observations']],
        'counterAtomIds':[o['contradictingAtomIds'] for o in record['current']], 'modelLatencyMs':record['latencyMs']}


def check_update_trace(root,tag,revision):
    logs=[json.loads(line) for line in (root/(tag+'-utility.jsonl')).read_text(encoding='utf-8').splitlines()]
    assert len(logs)==1 and logs[0]['status']=='returned'
    record=revision['record']; response=logs[0]['responseText'].strip().removeprefix('```json').removesuffix('```').strip()
    assert json.loads(response)==record['rawAnswer']
    assert logs[0]['originalInputChars']==len(json.dumps(record['generationInput'],ensure_ascii=False))


def audit(root):
    root=Path(root); protocol=load(root/'protocol.json'); result=audit_host(root)
    assert protocol['phase']=='6.4'
    selected=load(root/'selected.json'); old=Path(protocol['previousRoot']); prior_trials=load(old/'trials.json')
    revisions=[]; stages=[]; gap_rows=[]; utility=[]
    for selection in selected:
        first=next(r for r in prior_trials if r['seed']==selection['previousSeed'] and r['acquiredEvidence'])
        assert first['path']==selection['path'] and first['sample']==selection['sample']
        folder=root/selection['seed']; doc=load(folder/'revision-input.json')
        assert doc['initial']==load(old/selection['previousSeed']/'preparation-input.json')['initial']
        if not (folder/'revision.json').exists():continue
        revision=load(folder/'revision.json'); es=events(folder/'trajectory'/'world.sqlite')
        checked=revision_check(doc,revision,es);check_update_trace(root,selection['seed']+'-initial',revision)
        checked['seed']=selection['seed']; revisions.append(checked)
        gaps=load(folder/'gaps.json'); assert len(gaps)==8
        for index,row in enumerate(gaps):
            call=load(folder/'trajectory'/f'gap-{index}-call.json')
            request=call['request']; response=call['response']
            assert call['status']=='returned' and request['canRecall'] is False and request['context']['memories']==[]
            stimulus=request['context']['stimulus']
            assert any(s['content'].get('speech',{}).get('text')==protocol['gaps'][index] for s in stimulus)
            transport=load(folder/'trajectory'/f'gap-{index}-transport.json')
            assert transport['status']==200
            body=json.loads(transport['body'])
            published=[e['data']['value']['content']['speech'] for seq,e in es.items()
                if seq>row['before']['headSeq'] and seq <= (gaps[index+1]['before']['headSeq'] if index<7 else max(es))
                and e['eventType']=='observation.upsert' and e['data']['value']['observerId']=='character:npc'
                and isinstance(e['data']['value'].get('content'),dict)
                and e['data']['value']['content'].get('speech',{}).get('characterId')=='character:npc']
            gap_rows.append({'seed':selection['seed'],'gap':index,'status':row['result']['status'],'response':response,
                'publishedSpeech':published,'usage':body.get('usage',{}),'durationMs':row['durationMs']})
        if selection['seed'] not in protocol['seeds']:continue
        snapshot=load(folder/'snapshot.json'); request=load(folder/'request.json')
        expected_sources={s['sourceId']:s for s in snapshot['sources']}
        assert sum(s['worldSeq']>doc['scope']['asOfWorldSeq'] for s in snapshot['sources'])>=16
        nonmemory=json.dumps({**request,'context':{**request['context'],'memories':[]}},ensure_ascii=False)
        assert '登记处：二楼203' not in nonmemory and '登记处：一楼105' not in nonmemory
        for path in protocol['paths']:
            input_doc=load(folder/(path+'-input.json')); recall=load(folder/(path+'.json'))
            assert input_doc['authorizedHistory']==snapshot['sources'] and input_doc['request']==request
            archive=delayed_loop.loop.archive_for_recall(input_doc)
            assert archive==recall['archive']
            assert {s['sourceId'] for s in archive['sources']}==set(expected_sources)
            assert all(all(expected_sources[s['sourceId']].get(k)==v for k,v in s.items()) for s in archive['sources'])
            check_refs(archive,es)
            aliases=[{'scope':archive['scope'],'worldSeq':archive['scope']['asOfWorldSeq'],'people':request['context']['scene']['people']}]
            projection=bridge.projections.retrieval_projection(archive,alias_history=aliases)
            projected=bridge.activity.index_metadata(projection,archive)
            views=sum([projected[k] for k in ('facts','episodes','observations')],[])
            assert len(views)==len(recall['indexUnits'])
            for view,stored in zip(views,recall['indexUnits']):
                assert all(stored[k]==v for k,v in view.items()), 'index projection changed'
            index={'scope':archive['scope'],'units':recall['indexUnits']}
            rows,admission=delayed_loop.candidate_admission.admit(archive,index,recall['baselineRetrieval'],request,recall['query'])
            assert rows==recall['retrieval']['results'] and admission==recall['admission']
            expected_query=bridge.queries.project(request,projection.get('retrievalAliases'))
            activities=bridge.activity.associations(archive)[2]
            expected_query['activitySeeds']=[i for i in dict.fromkeys(bridge.activity.ACTIVITY_ID.findall(expected_query['originalText'])) if i in activities]
            assert expected_query==recall['query']
            targets={o['id'] for o in archive['observations']}; selected_ids=[r['id'] for r in rows if r['id'] in targets][:7]
            assert selected_ids==recall['selectedIds'] and recall['decision'] is None and recall['jevCalls']==0 and not recall['forcedTarget']
            delivery=delayed_loop.minimal_delivery.deliver(archive,rows,selected_ids,request,input_doc['tick'],copy.deepcopy(recall['query']))
            assert delivery==recall['delivery']
            if path=='no-cognition': assert targets==set() and not any(m['memoryLevel']=='observation' for m in delivery['memories'])
            stages.append({'seed':selection['seed'],'path':path,'authorizedSources':len(archive['sources']),
                'candidates':len(rows),'targetCandidates':len(selected_ids),'bodyDeliveredIds':recall['targetDeliveredIds'],
                'materialIds':[m['memoryId'] for m in delivery['memories']],
                'coverage':[m['evidenceCoverage'] for m in delivery['memories'] if 'evidenceCoverage' in m],
                'preparation':load(folder/(path+'-timing.json'))})
    checked_sources=0
    for db in root.rglob('world.sqlite'):
        es=events(db)
        for ns,sid,seq,h,kind,text in source_rows(db.with_name('memory.sqlite')):
            event=es[seq]; value=event['data']['value']; content=value.get('content',{}); owner=ns.split(chr(31))[-1]
            assert event['eventType']=='observation.upsert' and sid=='event:'+str(seq) and h==event['eventHash'] and owner==value['observerId']
            if isinstance(content,dict) and content.get('capabilityId') in CAPS: assert owner=='character:npc'
            checked_sources+=1
    for row in result['rows']:
        folder=root/row['seed']/f"sample-{row['sample']}-{row['path']}"; es=events(folder/'world.sqlite')
        prefix=events(root/row['seed']/'prefix'/'world.sqlite')
        assert all(es[seq]==e for seq,e in prefix.items())
        row['publishedSpeech']=[e['data']['value']['content']['speech'] for seq,e in es.items()
            if seq>max(prefix) and e['eventType']=='observation.upsert' and e['data']['value']['observerId']=='character:npc'
            and isinstance(e['data']['value'].get('content'),dict)
            and e['data']['value']['content'].get('speech',{}).get('characterId')=='character:npc']
        for i in range(row['calls']):
            call=load(folder/f'call-{i}.json'); encoded=json.dumps(call['request'],ensure_ascii=False)
            assert '仅陆舟可读的内部名单：青杉' not in encoded and call['request']['canRecall'] is False
    for p in sorted(root.glob('*-utility.jsonl')):
        for line in p.read_text(encoding='utf-8').splitlines():
            value=json.loads(line); utility.append({'file':p.name,'status':value['status'],'model':value['model'],'usage':value.get('usage',{})})
    closure=[]
    if (root/'closure.json').exists():
        for row in load(root/'closure.json'):
            if row['status']!='accepted':closure.append(row);continue
            first=next(r for r in load(root/'trials.json') if r['path']==row['path'] and r['acquiredEvidence'])
            assert first['seed']==row['seed'] and first['sample']==row['sample']
            folder=root/row['seed']/f"sample-{row['sample']}-{row['path']}"
            revision=load(folder/'closure-revision.json')
            checked=revision_check(load(folder/'closure-input.json'),revision,events(folder/'world.sqlite'))
            check_update_trace(root,row['seed']+'-'+row['path']+'-closure',revision)
            closure.append({**row,'checked':checked})
    result.update({'phase':'6.4','selectedTrajectories':len(selected),'preparedTrajectories':len(protocol['seeds']),
        'allSelectedTrajectoriesPrepared':len(selected)==len(protocol['seeds']),
        'initialRevisions':revisions,'gapRows':gap_rows,'gapCharacterCalls':len(gap_rows),'stages':stages,
        'revisionAndOldEvidencePreservationVerified':True,'naturalIDAdmissionAndMinimalDeliveryReplayVerified':True,
        'privateSourceRowsVerified':checked_sources,'utilityCalls':utility,'closure':closure,
        'limits':['known-family canonical branch update, no automatic family discovery or general merge',
            'same full authorized history; material wording, selected branches and budgets differ across variants',
            'Character and offline revision/recall timing are separate; no total production latency claim',
            'small repeated samples establish observed paths, not a stable causal benefit of cognition',
            'model semantics need per-dialogue review; reported speech and display text are not world truth']})
    return result

if __name__=='__main__':
    result=audit(sys.argv[1]);(Path(sys.argv[1])/'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k not in ('rows','gapRows','stages','initialRevisions','utilityCalls','closure')},ensure_ascii=False))
