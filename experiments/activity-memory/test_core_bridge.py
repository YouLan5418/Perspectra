import json
import copy
import unittest
from unittest.mock import patch
import core_bridge as bridge

class BridgeTest(unittest.TestCase):
    def source(self,kind,text):
        return {'sourceId':'event:2','sourceHash':'sha256:2','epistemicKind':kind,'worldSeq':2,'knownTick':1,'characterId':'character:gpt',
                'worldAddress':{'tenantId':'t','worldId':'w','branchId':'b'},'text':text}
    def test_authorized_result_is_kept_but_interpretation_is_not_completion(self):
        source=self.source('observed_action',json.dumps({'actorId':'character:claude','actionType':'interact','status':'accepted',
           'resultDescription':'Claude 主持人对猜测 50 裁决为偏大。','playerInput':{'sourceText':'我获胜了'},'reason':'我真的获胜了'},ensure_ascii=False))
        scope={'worldAddress':source['worldAddress'],'characterId':source['characterId'],'asOfWorldSeq':2}
        with patch.object(bridge.core,'llm') as model:
            data=bridge.episode.retain({'scope':scope,'sources':[source]})
        model.assert_not_called()
        atom=data['facts'][0]
        self.assertIn('猜测 50',atom['text'])
        self.assertNotIn('获胜',atom['text'])
        self.assertIn('猜测 50',bridge.projections.atom_search_text(atom))
        self.assertEqual(data['sources'],[source])
        self.assertEqual(atom['sourceRefs'],[bridge.core.source_ref(source)])
        bridge.episode.validate_units(data)
    def test_spoken_guess_stays_speech_and_foreign_source_is_rejected(self):
        source=self.source('reported_speech','character:player said: 我先口头猜 1，但还没提交。')
        scope={'worldAddress':source['worldAddress'],'characterId':source['characterId'],'asOfWorldSeq':2}
        with patch.object(bridge.core,'llm',return_value={'atoms':[]}):
            data=bridge.episode.retain({'scope':scope,'sources':[source]})
        self.assertEqual(data['facts'][0]['evidence']['channel'],'speech')
        self.assertNotIn('executionStatus',data['facts'][0]['evidence'])
        with patch.object(bridge.core,'llm') as model:
            with self.assertRaises(ValueError):
                bridge.episode.retain({'scope':scope,'sources':[{**source,'characterId':'character:deepseek'}]})
        model.assert_not_called()


class ActivityDeliveryTest(unittest.TestCase):
    source=BridgeTest.source
    def archive(self, endings=True, second=False, together=True):
        sources=[]
        def add(seq,ident,revision,active,text,lifecycle):
            source=self.source('observed_action',json.dumps({'status':'accepted','actionType':'interact','actorId':'character:claude',
                'resultDescription':text,'resultMetadata':{'activity':{'id':ident,'revision':revision,'phase':'author-defined-phase',
                'round':revision,'active':active,'lifecycle':lifecycle,'private':{'answer':73}}}},ensure_ascii=False))
            sources.append({**source,'sourceId':'event:'+str(seq),'sourceHash':'hash:'+str(seq),'worldSeq':seq,'knownTick':seq})
        add(1,'activity:first',1,True,'第一局开始','started')
        if endings: add(3,'activity:first',2,False,'第一局因宿主逃生中止','ended')
        if second:
            add(4,'activity:second',1,True,'第二局开始','started')
            add(5,'activity:second',2,False,'第二局主持人宣布结算','ended')
        scope={'worldAddress':sources[0]['worldAddress'],'characterId':'character:gpt','asOfWorldSeq':sources[-1]['worldSeq']}
        data=bridge.episode.retain({'scope':scope,'sources':sources})
        groups=[data['facts']] if together else [[a] for a in data['facts']]
        data['episodes']=[{'id':'episode:'+str(i),'kind':'episode','memoryLevel':'episode','label':'一段经历',
            'eventAtoms':copy.deepcopy(g),'eventAtomIds':[a['id'] for a in g],'sourceRefs':bridge.episode.union_refs(g),
            'text':bridge.episode.episode_text(g)} for i,g in enumerate(groups)]
        data['observations']=[]
        return bridge.activity.bind(data)
    def deliver(self,data,ids,query='',recent=(),**kw):
        request={'context':{'character':{'characterId':'character:gpt'},'observations':[{'sourceSeq':s} for s in recent],'selfObservations':[]}}
        return bridge.activity.deliver(data,[{'id':i} for i in ids],request,10,{'originalText':query},**kw)
    def test_atom_hit_brings_authorized_ending_even_in_another_episode(self):
        data=self.archive(together=False)
        result=self.deliver(data,[data['facts'][0]['id']])
        self.assertEqual(result['memories'][0]['sourceIds'],['event:3'])
        self.assertTrue(result['trace']['activityCoverage'][0]['endingIncluded'])
        self.assertEqual(result['trace']['delivered'][0]['reason'],'same activity ending evidence')
        self.assertNotIn('answer',json.dumps(result['memories'],ensure_ascii=False))
        self.assertEqual(result['trace']['delivered'][0]['sourceRefs'],[bridge.core.source_ref(data['sources'][1])])
    def test_open_prefix_does_not_invent_closed_status_and_future_sources_fail(self):
        data=self.archive(endings=False)
        result=self.deliver(data,[data['facts'][0]['id']])
        self.assertEqual(result['trace']['activityCoverage'][0]['status'],'unknown')
        self.assertIn('尚无结束记录',result['memories'][0]['text'])
        full=self.archive();full['scope']['asOfWorldSeq']=1
        with self.assertRaises(ValueError): self.deliver(full,[full['facts'][0]['id']])
    def test_exact_id_uses_only_its_ending_and_empty_archive_stays_empty(self):
        data=self.archive(second=True)
        result=self.deliver(data,[],query='activity:second 是如何结束的？')
        self.assertEqual(result['memories'][0]['sourceIds'],['event:5'])
        self.assertNotIn('event:3',[s for m in result['memories'] for s in m['sourceIds']])
        self.assertEqual(self.deliver(data,[],query='那局呢？')['memories'],[])
        self.assertEqual(self.deliver(data,[data['facts'][0]['id']],query='activity:unknown')['memories'],[])
        empty={**data,'sources':[],'facts':[],'episodes':[],'representations':[]}
        self.assertEqual(self.deliver(empty,[],query='activity:second')['memories'],[])
    def test_current_context_ending_is_not_duplicated_and_budget_includes_notes(self):
        data=self.archive()
        result=self.deliver(data,[data['facts'][0]['id']],recent=[3])
        self.assertTrue(result['trace']['activityCoverage'][0]['endingIncluded'])
        self.assertNotIn('event:3',[s for m in result['memories'] for s in m['sourceIds']])
        limited=self.deliver(data,[data['facts'][0]['id']],max_items=1)
        self.assertEqual(len(limited['memories']),1)
        self.assertEqual(limited['memories'][0]['sourceIds'],['event:3'])
        size=bridge.projections.chars(limited['memories'])
        tiny=self.deliver(data,[data['facts'][0]['id']],max_json_chars=size-1)
        self.assertLessEqual(bridge.projections.chars(tiny['memories']),size-1)
    def test_untagged_atom_does_not_inherit_game_and_foreign_evidence_fails(self):
        data=self.archive(endings=False)
        source={**self.source('direct_observation','主持人继续等玩家猜数'),'sourceId':'event:2','worldSeq':2,'knownTick':2}
        data['scope']['asOfWorldSeq']=2;data['sources'].append(source)
        atom=bridge.episode.make_atom(source,bridge.episode.segments(source)[0],source['text'],0)
        data['facts'].append(atom)
        unit=data['episodes'][0];unit['eventAtoms'].append(atom);unit['eventAtomIds'].append(atom['id'])
        unit['sourceRefs']=bridge.episode.union_refs(unit['eventAtoms']);unit['text']=bridge.episode.episode_text(unit['eventAtoms'])
        result=self.deliver(data,[atom['id']])
        self.assertEqual(result['trace']['activityCoverage'],[])
        self.assertEqual(result['memories'][0]['sourceIds'],['event:2'])
        self.assertNotIn('deliveryCoverage',result['memories'][0])
        bad=self.archive();bad['sources'][1]['characterId']='character:deepseek'
        with self.assertRaises(ValueError): self.deliver(bad,[bad['facts'][0]['id']])


    def test_mixed_episode_uses_accepted_matching_atoms_instead_of_episode_membership(self):
        data=self.archive()
        source={**self.source('reported_speech','character:player said: 想喝冰乌龙还是气泡水？'),
                'sourceId':'event:4','sourceHash':'hash:4','worldSeq':4,'knownTick':4}
        data['scope']['asOfWorldSeq']=4;data['sources'].append(source)
        part=bridge.episode.segments(source)[0]
        atom=bridge.episode.make_atom(source,part,part['context'],0)
        data['facts'].append(atom)
        unit=data['episodes'][0];unit['eventAtoms'].append(copy.deepcopy(atom));unit['eventAtomIds'].append(atom['id'])
        unit['sourceRefs']=bridge.episode.union_refs(unit['eventAtoms']);unit['text']=bridge.episode.episode_text(unit['eventAtoms'])
        request={'context':{'character':{'characterId':'character:gpt'},'observations':[],'selfObservations':[]}}
        opening=data['facts'][0]
        def candidate(scores):
            ids=[r['atomId'] for r in scores]
            return {'id':unit['id'],'matches':[{'atomIds':ids,
                'sourceRefs':bridge.episode.union_refs([a for a in data['facts'] if a['id'] in ids]),'atomScores':scores}]}
        scores=[{'atomId':opening['id'],'accepted':False,'relevance':0.1},
                {'atomId':atom['id'],'accepted':True,'relevance':0.8}]
        result=bridge.activity.deliver(data,[candidate(scores)],request,10,{'originalText':'喝什么饮料？'})
        self.assertEqual(result['trace']['activityCoverage'],[])
        self.assertEqual([m['sourceIds'] for m in result['memories']],[['event:4']])
        scores=[{'atomId':opening['id'],'accepted':True,'relevance':0.8}]
        result=bridge.activity.deliver(data,[candidate(scores)],request,10,{'originalText':'回忆那局猜数'})
        self.assertEqual(result['memories'][0]['sourceIds'],['event:3'])
        self.assertTrue(result['trace']['activityCoverage'][0]['endingIncluded'])


class CoreDeliveryBudgetTest(unittest.TestCase):
    def test_host_budget_reaches_minimal_delivery(self):
        import candidate_admission
        import minimal_delivery
        data = ActivityDeliveryTest().archive()
        doc = {'operation':'recall', 'archive':data, 'index':{'scope':data['scope'], 'units':[], 'vectors':[]},
               'request':{'context':{'character':{'characterId':'character:gpt'}}}, 'tick':10,
               'observations':True, 'deliveryMode':'minimal', 'deliveryBudget':{'maxItems':6,'maxJsonChars':12000}}
        with patch.object(bridge.queries, 'project', return_value={'semanticQuery':'旧礼物'}) as query, \
             patch.object(bridge.projections, 'search', return_value={'results':[]}), \
             patch.object(candidate_admission, 'admit', return_value=([],{})), \
             patch.object(minimal_delivery, 'deliver', return_value={'memories':[],'trace':{}}) as delivery:
            bridge.dispatch(doc)
            self.assertEqual(delivery.call_args.kwargs, {'max_items':6,'max_json_chars':12000})
            doc['deliveryBudget']['unexpected'] = 1
            with self.assertRaisesRegex(ValueError, 'invalid Delivery budget'): bridge.dispatch(doc)


class UtilityTransportTest(unittest.TestCase):
    def response(self, text, finish='stop'):
        import io
        return io.StringIO(json.dumps({'choices':[{'finish_reason':finish,'message':{'content':text}}]}))

    def test_gemini_memory_requests_low_first(self):
        with patch('urllib.request.urlopen', return_value=self.response('{"atoms":[]}')) as network:
            self.assertEqual(bridge.utility_llm('system', 'authorized evidence'), {'atoms':[]})
        body = json.loads(network.call_args.args[0].data)
        self.assertEqual(body['reasoning_effort'], 'low')
        self.assertNotIn('thinking', body)
        self.assertEqual(body['response_format'], {'type':'json_object'})

    def test_timeout_retries_once_with_disabled_thinking_and_same_evidence(self):
        import urllib.error
        for timeout in (TimeoutError('timeout'), urllib.error.URLError(TimeoutError('timeout'))):
            with self.subTest(timeout=type(timeout).__name__), \
                 patch('urllib.request.urlopen',side_effect=[timeout,self.response('{"atoms":[]}')]) as network, \
                 patch.object(bridge.time,'sleep'):
                self.assertEqual(bridge.utility_llm('system','authorized evidence'),{'atoms':[]})
                first,second=[json.loads(call.args[0].data) for call in network.call_args_list]
                self.assertEqual(first.pop('reasoning_effort'),'low')
                self.assertEqual(second.pop('thinking'),{'type':'disabled'})
                self.assertEqual(first,second)

    def test_second_timeout_stops_without_third_request(self):
        with patch('urllib.request.urlopen',side_effect=TimeoutError('timeout')) as network, patch.object(bridge.time,'sleep'):
            with self.assertRaises(TimeoutError): bridge.utility_llm('system','authorized evidence')
        self.assertEqual(network.call_count,2)

    def test_other_errors_do_not_trigger_gemini_fallback(self):
        import urllib.error
        for error in (ConnectionRefusedError('refused'), urllib.error.HTTPError('http://fixture',503,'unavailable',{},None)):
            with self.subTest(error=type(error).__name__), patch('urllib.request.urlopen',side_effect=error) as network:
                with self.assertRaises(OSError): bridge.utility_llm('system','authorized evidence')
                self.assertEqual(network.call_count,1)

    def test_deepseek_keeps_disabled_thinking(self):
        import os
        with patch.dict(os.environ,{'HCW_LOCAL_MODEL':'deepseek-flash'}), \
             patch('urllib.request.urlopen',return_value=self.response('{"atoms":[]}')) as network:
            bridge.utility_llm('system','authorized evidence')
        body=json.loads(network.call_args.args[0].data)
        self.assertEqual(body['thinking'],{'type':'disabled'})
        self.assertNotIn('reasoning_effort',body)

    def test_reasoning_only_budget_failure_records_safe_diagnostics(self):
        rows = []
        with patch('urllib.request.urlopen', return_value=self.response('', 'length')), \
             patch.object(bridge, 'attempt_trace', side_effect=rows.append):
            with self.assertRaisesRegex(ValueError, 'exceeded output budget'):
                bridge.utility_llm('PRIVATE_PROMPT_MARKER', 'PRIVATE_SOURCE_MARKER')
        failure = rows[-1]
        self.assertEqual(failure['event'], 'rejected')
        self.assertEqual(failure['finishReason'], 'length')
        self.assertEqual(failure['responseChars'], 0)
        self.assertNotIn('PRIVATE_', json.dumps(rows))

    def test_truncated_json_is_rejected_even_if_the_visible_object_parses(self):
        with patch('urllib.request.urlopen',return_value=self.response('{"atoms":[]}', 'length')):
            with self.assertRaisesRegex(ValueError,'exceeded output budget'):
                bridge.utility_llm('system','authorized evidence')

    def test_malformed_json_is_not_repaired_or_accepted(self):
        with patch('urllib.request.urlopen',return_value=self.response('{"atoms":[{"text":"unfinished"}')):
            with self.assertRaises(json.JSONDecodeError):
                bridge.utility_llm('system','authorized evidence')

    def test_transport_trace_excludes_credentials_and_records_rejection(self):
        import os
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            trace=Path(directory)/'utility.jsonl'
            key='transport-test-placeholder'
            with patch.dict(os.environ,{'HCW_LOCAL_API_KEY':key,'HCW_HINDSIGHT_UTILITY_TRACE':str(trace)}):
                with patch('urllib.request.urlopen',return_value=self.response('{"atoms":[]}')) as network:
                    self.assertEqual(bridge.utility_llm('system','authorized evidence'),{'atoms':[]})
                self.assertEqual(network.call_args.args[0].get_header('Authorization'),'Bearer '+key)
                with patch('urllib.request.urlopen',return_value=self.response('{"atoms":')):
                    with self.assertRaises(json.JSONDecodeError):
                        bridge.utility_llm('system','authorized evidence')
            text=trace.read_text(encoding='utf-8')
            self.assertNotIn(key,text)
            self.assertNotIn('authorization',text.lower())
            rows=[json.loads(line) for line in text.splitlines()]
            self.assertEqual([row['status'] for row in rows],['returned','rejected'])
            self.assertIn('error',rows[1])


class PrefixBatchTest(unittest.TestCase):
    source=BridgeTest.source
    def test_all_sources_and_atom_ids_survive_quote_selection_batches(self):
        first=self.source('reported_speech','第一句。第二句。')
        second={**self.source('direct_observation','我看见窗外的树。'),'sourceId':'event:3',
                'sourceHash':'hash:3','worldSeq':3,'knownTick':2}
        doc={'scope':{'worldAddress':first['worldAddress'],'characterId':first['characterId'],'asOfWorldSeq':3},
             'sources':[first,second]}
        before=copy.deepcopy(doc)
        with patch.object(bridge.core,'llm',side_effect=[
            {'atoms':[{'segment_id':'event:2/part:0','quote':'第一句。'},
                      {'segment_id':'event:2/part:0','quote':'第二句。'}]},
            {'atoms':[{'segment_id':'event:3/part:0','quote':'我看见窗外的树。'}]}]) as model:
            result=bridge.retain_prefix(doc,max_prose_chars=1)
        self.assertEqual(model.call_count,2)
        self.assertEqual(doc,before)
        self.assertEqual(result['sources'],doc['sources'])
        self.assertEqual([a['id'] for a in result['facts']],['atom:event:2:0','atom:event:2:1','atom:event:3:0'])
        self.assertEqual([a['sourceRefs'] for a in result['facts']],
                         [[bridge.core.source_ref(first)],[bridge.core.source_ref(first)],[bridge.core.source_ref(second)]])
        bridge.episode.validate_units(result)

    def test_foreign_later_source_fails_before_any_batch_model_call(self):
        first=self.source('reported_speech','我先发言。')
        foreign={**first,'sourceId':'event:3','worldSeq':3,'characterId':'character:deepseek'}
        doc={'scope':{'worldAddress':first['worldAddress'],'characterId':first['characterId'],'asOfWorldSeq':3},
             'sources':[first,foreign]}
        with patch.object(bridge.core,'llm') as model:
            with self.assertRaises(ValueError): bridge.retain_prefix(doc,max_prose_chars=1)
        model.assert_not_called()


class AsyncBuildTests(unittest.TestCase):
    def test_parallel_batches_preserve_order_ids_and_source_mapping(self):
        import threading
        from concurrent.futures import ThreadPoolExecutor
        first = BridgeTest().source('reported_speech', '第一批明确原句。')
        sources = [{**first, 'sourceId':f'event:{i}', 'sourceHash':f'hash:{i}', 'worldSeq':i, 'text':f'第{i}批完整原句。'} for i in range(2,5)]
        doc = {'scope':{'worldAddress':first['worldAddress'], 'characterId':first['characterId'], 'asOfWorldSeq':4}, 'sources':sources}
        active, peak = 0, 0
        lock = threading.Lock()
        first_started, second_done, release = threading.Event(), threading.Event(), threading.Event()
        def quote(system, user, *args):
            nonlocal active, peak
            parts = json.loads(user)
            with lock: active += 1; peak = max(peak, active)
            try:
                if parts[0]['sourceId'] == 'event:2':
                    first_started.set(); self.assertTrue(release.wait(5))
                else: second_done.set()
                return {'atoms':[{'segment_id':p['id'], 'quote':p['context']} for p in parts]}
            finally:
                with lock: active -= 1
        with patch.object(bridge.core, 'llm', side_effect=quote), ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(bridge.retain_prefix, {**doc, 'retainConcurrency':2}, 1)
            self.assertTrue(first_started.wait(5)); self.assertTrue(second_done.wait(5)); release.set()
            parallel = pending.result(5)
        self.assertEqual(peak, 2)
        with patch.object(bridge.core, 'llm', side_effect=lambda _s,u,*_a: {'atoms':[{'segment_id':p['id'],'quote':p['context']} for p in json.loads(u)]}):
            sequential = bridge.retain_prefix(doc, 1)
        self.assertEqual(parallel, sequential)
        bridge.episode.validate_units(parallel)
        self.assertEqual([a['id'] for a in parallel['facts']], ['atom:event:2:0','atom:event:3:0','atom:event:4:0'])

    def test_group_consolidate_and_index_wait_for_complete_validated_atoms(self):
        source = BridgeTest().source('reported_speech', '完整原句。')
        scope = {'worldAddress':source['worldAddress'],'characterId':source['characterId'],'asOfWorldSeq':2}
        order = []
        def group(data):
            bridge.episode.validate_units(data)
            self.assertEqual([a['sourceRefs'][0]['sourceId'] for a in data['facts']], ['event:2'])
            order.append('group'); return {'episodes':[], 'actions':[]}
        def consolidate(data):
            self.assertEqual(order, ['group']); self.assertEqual(data['episodes'], [])
            bridge.episode.validate_units(data)
            order.append('consolidate'); return {'observations':[], 'actions':[]}
        def index(data):
            self.assertEqual(order, ['group','consolidate']); order.append('index')
            return {'scope':scope}
        with patch.object(bridge, 'utility_llm', return_value={'atoms':[]}), \
             patch.object(bridge.episode, 'group', side_effect=group), \
             patch.object(bridge.episode, 'consolidate', side_effect=consolidate), \
             patch.object(bridge.vector_core, 'index', side_effect=index):
            result = bridge.dispatch({'operation':'build','scope':scope,'sources':[source],'retainConcurrency':2})
        self.assertEqual(order, ['group','consolidate','index'])
        bridge.episode.validate_units(result['archive'])

    def test_http_attempts_record_timeout_retry_model_usage_and_exclude_content(self):
        import tempfile
        import os
        from pathlib import Path
        import io
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory)/'attempts.jsonl'
            response = io.StringIO(json.dumps({'model':'returned-alias','usage':{'prompt_tokens':13},
                'choices':[{'finish_reason':'stop','message':{'content':'{"atoms":[]}'}}]}))
            with patch.dict(os.environ, {'HCW_HINDSIGHT_UTILITY_ATTEMPTS':str(trace),'HCW_LOCAL_API_KEY':'PRIVATE_KEY_MARKER'}), \
                 patch('urllib.request.urlopen', side_effect=[TimeoutError('fixture timeout'), response]), \
                 patch.object(bridge.time, 'sleep') as sleep:
                self.assertEqual(bridge.utility_llm('PRIVATE_PROMPT_MARKER','authorized source'), {'atoms':[]})
            text = next(Path(directory).glob('attempts-*.jsonl')).read_text(encoding='utf-8')
            self.assertNotIn('PRIVATE_KEY_MARKER',text); self.assertNotIn('PRIVATE_PROMPT_MARKER',text)
            rows = [json.loads(line) for line in text.splitlines()]
            self.assertEqual([r['event'] for r in rows], ['started','finished','started','finished'])
            self.assertTrue(rows[1]['timedOut']); self.assertTrue(rows[1]['willRetry']); sleep.assert_called_once_with(2)
            self.assertEqual(rows[3]['attempt'], 2); self.assertFalse(rows[3]['willRetry'])
            self.assertEqual(rows[3]['returnedModel'], 'returned-alias')
            self.assertEqual(rows[3]['usage'], {'prompt_tokens':13})
            self.assertGreaterEqual(rows[3]['durationMs'],0)


class UtilityPromptTest(unittest.TestCase):
    def test_metadata_dedup_preserves_all_atom_context_and_episode_membership(self):
        archive=ActivityDeliveryTest().archive()
        doc={'atoms':archive['facts'],'episodes':archive['episodes'],'existingObservationsWithEvidence':[],
             'mission':'保留未证实和规则结果的区别'}
        original=copy.deepcopy(doc)
        text=json.dumps(doc,ensure_ascii=False)
        compact=json.loads(bridge.utility_prompt(text))
        self.assertEqual(doc,original)
        self.assertEqual([a['text'] for a in compact['atoms']],[a['text'] for a in doc['atoms']])
        self.assertEqual([e['eventAtomIds'] for e in compact['episodes']],[e['eventAtomIds'] for e in doc['episodes']])
        self.assertEqual(compact['mission'],doc['mission'])
        self.assertLess(len(bridge.utility_prompt(text)),len(text))
        for before,after in zip(doc['atoms'],compact['atoms']):
            self.assertEqual(after['evidence']['channel'],before['evidence']['channel'])
            self.assertEqual(after['evidence']['actorId'],before['evidence']['actorId'])
            self.assertEqual(after['sourceRefs'],[{k:r[k] for k in ('sourceId','epistemicKind','worldSeq')} for r in before['sourceRefs']])
            self.assertIn('"status": "accepted"',after['text'])
        bridge.episode.validate_units(archive)

    def test_verbatim_retain_segments_are_not_changed(self):
        user=json.dumps([{'id':'event:2/part:0','context':'他说：我可能稍后回来。不是已经回来了。'}],ensure_ascii=False)
        self.assertEqual(bridge.utility_prompt(user),user)


class RetainedPrefixTest(unittest.TestCase):
    def fixture(self):
        previous=ActivityDeliveryTest().archive()
        source={**BridgeTest().source('reported_speech','我还记得刚才的游戏。'),
                'sourceId':'event:4','sourceHash':'hash:4','worldSeq':4,'knownTick':4}
        return previous,source

    def test_unchanged_atoms_are_reused_and_only_new_source_is_selected(self):
        previous,source=self.fixture()
        before=copy.deepcopy(previous)
        doc={'scope':{**previous['scope'],'asOfWorldSeq':4},'sources':previous['sources']+[source],'retainedPrefix':previous}
        with patch.object(bridge.core,'llm',return_value={'atoms':[]}) as model:
            data=bridge.retain_prefix(doc)
        self.assertEqual(model.call_count,1)
        self.assertEqual({r['sourceId'] for r in json.loads(model.call_args.args[1])},{'event:4'})
        self.assertEqual(previous,before)
        self.assertEqual(data['facts'][:len(previous['facts'])],previous['facts'])
        self.assertEqual(data['sources'],doc['sources'])
        self.assertEqual(data['stats']['reusedAtoms'],len(previous['facts']))
        bridge.episode.validate_units(data)

    def test_identical_completed_prefix_does_not_regenerate_episodes_or_observations(self):
        previous,_=self.fixture()
        for key in ('facts','episodes','observations'):
            previous[key]=bridge.timed(previous[key],previous['sources'])
        doc={'operation':'build','scope':previous['scope'],'sources':previous['sources'],'retainedPrefix':previous}
        before=copy.deepcopy(previous)
        with patch.object(bridge.core,'llm'), patch.object(bridge,'utility_llm') as model:
            with patch.object(bridge.vector_core,'index',return_value={'scope':previous['scope']}):
                result=bridge.dispatch(doc)
        model.assert_not_called()
        self.assertEqual(previous,before)
        self.assertTrue(result['reusedIdenticalArchive'])
        self.assertEqual(result['archive']['facts'],previous['facts'])
        self.assertEqual(result['archive']['episodes'],previous['episodes'])
        self.assertEqual(result['consolidation'],[])

    def test_changed_source_and_foreign_prefix_fail_before_model(self):
        previous,source=self.fixture()
        doc={'scope':{**previous['scope'],'asOfWorldSeq':4},'sources':previous['sources']+[source],'retainedPrefix':previous}
        changed=copy.deepcopy(doc);changed['sources'][0]['sourceHash']='changed'
        foreign=copy.deepcopy(doc);foreign['retainedPrefix']['scope']['characterId']='character:deepseek'
        with patch.object(bridge.core,'llm') as model:
            for invalid in (changed,foreign):
                with self.assertRaises(ValueError):bridge.retain_prefix(invalid)
        model.assert_not_called()

if __name__ == '__main__': unittest.main()
