"""Stage 6.3: read-only Source, body, request and native action audit; no semantic scorer."""
import json, sys
from pathlib import Path
from audit_simplification import audit as host_audit, load
from audit_notice_board_action_loop import events, source_rows, check_refs
from immediate_delivery import prepare


def audit(root):
    root = Path(root); protocol = load(root/'protocol.json')
    assert protocol['phase'] == '6.3'
    result = host_audit(root); stages = []
    labels = {'entity:hall-board': '大厅公告牌', 'entity:distant-board': '窗口指示牌'}
    for i,seed in enumerate(protocol['seeds']):
        folder = root/seed; doc = load(folder/'preparation-input.json')
        assert doc['initial'] == load(Path(protocol['previousRoot'])/f'seed-{i}'/'initial.json')
        assert doc['snapshot'] == load(folder/'snapshot.json') and doc['request'] == load(folder/'request.json')
        current = load(folder/'existing-cognition.json')
        assert prepare(doc) == current
        archive = current['archive']; check_refs(archive, events(folder/'prefix'/'world.sqlite'))
        raw = load(folder/'raw-direct.json'); rebuilt = []
        sources = {s['sourceId']:s for s in archive['sources']}
        for atom in archive['facts']:
            assert len(atom['sourceRefs']) == 1
            source = sources[atom['sourceRefs'][0]['sourceId']]; content = json.loads(source['text'])
            assert content['description'] == '你亲眼看到公告牌上写着：'+content['observedText']
            assert source['epistemicKind'] == 'direct_observation'
            rebuilt.append({'memoryId': atom['id'], 'memoryLevel': 'event_atom', 'epistemicKind': 'direct_observation',
                'text': '【本角色的直接观察】'+labels[content['targetId']]+'：'+content['description'],
                'sourceIds': [source['sourceId']], 'sourceRefs': atom['sourceRefs'],
                'sourceAgeTicks': doc['snapshot']['tick']-source['knownTick']})
        assert raw['delivery']['memories'] == rebuilt
        for path,data in [('raw-direct',raw),('existing-cognition',current)]:
            memories = data['delivery']['memories']
            assert data['newModelCalls'] == 0 and len(memories) <= 3
            assert len(json.dumps(memories,ensure_ascii=False,separators=(',',':'))) <= 4500
            assert {s for m in memories for s in m['sourceIds']} == set(sources)
            stages.append({'seed':seed,'path':path,'sourceIds':sorted(sources),'memories':len(memories),
                'jsonChars':len(json.dumps(memories,ensure_ascii=False,separators=(',',':'))),'newPreparationModelCalls':0,
                'coverage':[m['evidenceCoverage'] for m in memories if 'evidenceCoverage' in m]})
    checked_sources = 0
    for row in result['rows']:
        folder = root/row['seed']/f"sample-{row['sample']}-{row['path']}"
        es = events(folder/'world.sqlite')
        prefix = events(root/row['seed']/'prefix'/'world.sqlite')
        assert all(es[seq] == event for seq,event in prefix.items())
        rows = source_rows(folder/'memory.sqlite')
        for ns,sid,seq,hash_value,kind,text in rows:
            event = es[seq]; value = event['data']['value']; owner = ns.split(chr(31))[-1]
            assert sid == 'event:'+str(seq) and hash_value == event['eventHash'] and value['observerId'] == owner
            content = value.get('content',{}); checked_sources += 1
            if isinstance(content,dict) and content.get('capabilityId') in ('experiment:inspect-notice-board','experiment:ask_staff','experiment:inspect_terminal'):
                assert owner == 'character:npc'
                resolution = next(e for e in es.values() if e['eventType']=='action.resolved' and e['data']['actionId']==value['actionId'])
                assert resolution['data']['accepted'] and resolution['transactionId']==event['transactionId']
                assert content['sourceActionId']==value['actionId']
                assert kind==('reported_speech' if content['capabilityId']=='experiment:ask_staff' else 'direct_observation')
        for index in range(row['calls']):
            call = load(folder/f'call-{index}.json'); request = call['request']
            encoded = json.dumps(request,ensure_ascii=False)
            assert '仅陆舟可读的内部名单：青杉' not in encoded and request['canRecall'] is False
            if index==0: assert request['canPerform'] is True and not request.get('continuation')
            for text in ('我记得登记处在二楼203，不过我这周还没去过。','登记业务受理：一楼105；本页未标明更新时间。'):
                if text in encoded:
                    assert any(owner.split(chr(31))[-1]=='character:npc' and seq<=call['head']['headSeq'] and text in value
                               for owner,_,seq,_,_,value in rows), 'unexecuted evidence leaked'
        published = [e['data']['value']['content']['speech'] for seq,e in es.items()
            if seq>prefix[max(prefix)]['seq'] and e['eventType']=='observation.upsert'
            and isinstance(e['data']['value'].get('content'),dict)
            and e['data']['value']['content'].get('speech',{}).get('characterId')=='character:npc'
            and e['data']['value']['observerId']=='character:npc']
        row['publishedSpeech'] = published
    result.update({'phase':'6.3','immediateMaterialsReplayVerified':True,'currentBodiesUnchanged':True,
        'bothSignSourcesReadByBothArms':True,'noPreparationModelCalls':True,'privateAcquisitionIsolationVerified':True,
        'checkedSourceRows':checked_sources,'stages':stages,
        'limits':['both arms already have immediate sign results in the recent window; no delayed recall claim',
                  'two bodies versus two direct atoms differ in wording and length; not a single-component causal proof',
                  'both preparations call no model; prior cognition formation cost is outside this experiment',
                  'activation timing is one recorded sample set, excluding offline preparation; no speed guarantee',
                  'shared budget is JSON characters, not model tokens; provider usage and reasoning are reported without invented prices']})
    return result

if __name__=='__main__':
    result=audit(sys.argv[1]); (Path(sys.argv[1])/'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k not in ('rows','stages')},ensure_ascii=False))
