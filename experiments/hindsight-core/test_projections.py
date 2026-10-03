import copy
import unittest
import runpy
from pathlib import Path
from unittest.mock import patch
import numpy as np
import core
import episode_core as episode
import projections as projection
import vector_core as vector
from test_episode_core import SCOPE, source, retain, grouped


def request(recent=()):
    return {'context':{'character':{'characterId':SCOPE['characterId']},
        'observations':[{'sourceSeq':n} for n in recent], 'selfObservations':[]}}


class ProjectionTest(unittest.TestCase):
    def test_archive_is_unchanged_and_search_views_are_bounded(self):
        data=grouped(retain([source(4,'character:player said: '+'完整的否定语境。'*80)]))
        before=copy.deepcopy(data)
        views=projection.retrieval_projection(data,len,max_tokens=100)
        self.assertEqual(data,before)
        self.assertTrue(all(len(v['text'])<=100 for v in views['facts']+views['episodes']))
        self.assertTrue(all('eventAtoms' not in v for v in views['facts']+views['episodes']))
        self.assertGreater(len(views['episodes']),1)

    def test_partial_atoms_share_one_complete_context_delivery(self):
        s=source(4,'character:player said: 我喜欢茶。但如果下雨，我就不去门廊。')
        with patch.object(core,'llm',return_value={'atoms':[
            {'segment_id':'event:4/part:0','quote':'我喜欢茶。'},
            {'segment_id':'event:4/part:0','quote':'但如果下雨，我就不去门廊。'}]}):
            data=episode.retain({'scope':SCOPE,'sources':[s]})
        result=projection.delivery_projection(data,[{'id':a['id']} for a in data['facts']],request(),10)
        self.assertEqual(len(result['memories']),1)
        self.assertIn('但如果下雨，我就不去门廊。',result['memories'][0]['text'])
        self.assertEqual(len(result['trace']['delivered'][0]['coveredAtomIds']),2)

    def test_same_source_distinct_events_are_not_collapsed(self):
        data=retain([source(4,'character:player said: 去喝茶吗？; character:friend said: 我先看书。')])
        result=projection.delivery_projection(data,[{'id':a['id']} for a in data['facts']],request(),10)
        self.assertEqual(len(result['memories']),2)

    def test_player_speech_and_input_duplicates_keep_provenance(self):
        text='我不确定有没有伞。'
        data=retain([source(4,'character:player said: '+text+
            '; original player input (interpretation evidence, not an adjudicated outcome): '+text)])
        result=projection.delivery_projection(data,[{'id':a['id']} for a in data['facts']],request(),10)
        self.assertEqual(len(result['memories']),1)
        self.assertIn('character:player',result['memories'][0]['text'])
        self.assertIn('未经独立核实',result['memories'][0]['text'])
        self.assertEqual(result['trace']['delivered'][0]['sourceRefs'],[core.source_ref(data['sources'][0])])

    def test_episode_delivers_only_matched_nonrecent_evidence(self):
        data=grouped(retain([source(4,'character:player said: 旧邀请。'),source(8,'character:friend said: 新回答。')]))
        atoms=data['facts'];e=data['episodes'][0]
        match={'atomIds':[a['id'] for a in atoms],'sourceRefs':episode.union_refs(atoms)}
        result=projection.delivery_projection(data,[{'id':e['id'],'matches':[match]}],request([8]),10)
        self.assertEqual(len(result['memories']),1)
        self.assertNotIn('新回答',result['memories'][0]['text'])
        self.assertEqual(result['memories'][0]['sourceAgeTicks'],6)

    def test_speech_observation_falls_back_without_repeating_its_evidence(self):
        data=grouped(retain([source(4,'character:player said: 我喜欢茶。')]))
        ident=data['facts'][0]['id']
        with patch.object(core,'llm',return_value={'observations':[{'text':'他似乎喜欢茶。','supporting_atom_ids':[ident]}]}):
            data={**data,**episode.consolidate({**data,'observations':[]})}
        result=projection.delivery_projection(data,[{'id':'obs:1'},{'id':ident}],request(),10)
        self.assertEqual([m['memoryLevel'] for m in result['memories']],['event_atom'])
        self.assertNotIn('他似乎喜欢茶。',result['memories'][0]['text'])
        self.assertIn('未经独立核实',result['memories'][0]['text'])
        self.assertEqual(result['trace']['delivered'][0]['fallbackObservationId'],'obs:1')

    def test_counter_evidence_survives_or_observation_is_omitted(self):
        data=grouped(retain([source(4,'character:player said: 我泡了茶。'),source(8,'character:player said: 我没有泡茶。')]))
        first,second=[a['id'] for a in data['facts']]
        with patch.object(core,'llm',return_value={'observations':[{'text':'泡茶的说法存在矛盾。',
            'supporting_atom_ids':[first],'contradicting_atom_ids':[second]}]}):
            data={**data,**episode.consolidate({**data,'observations':[]})}
        result=projection.delivery_projection(data,[{'id':'obs:1'}],request(),10)
        self.assertEqual(len(result['memories']),2)
        self.assertIn('没有泡茶',result['memories'][1]['text'])
        limited=projection.delivery_projection(data,[{'id':'obs:1'}],request(),10,max_items=1)
        self.assertEqual(limited['memories'],[])

    def test_budget_never_truncates_negation(self):
        data=retain([source(4,'character:player said: 我没有泡茶。')])
        result=projection.delivery_projection(data,[{'id':data['facts'][0]['id']}],request(),10,max_json_chars=5)
        self.assertEqual(result['memories'],[])

    def test_repeated_events_at_different_times_remain_distinct(self):
        data=retain([source(4,'character:player said: 我会回来。'),source(8,'character:player said: 我会回来。')])
        result=projection.delivery_projection(data,[{'id':a['id']} for a in data['facts']],request(),10)
        self.assertEqual(len(result['memories']),2)
        self.assertEqual(len(projection.candidate_clusters([{'id':a['id']} for a in data['facts']],projection.archive(data)[0])),2)

    def test_delivery_rejects_wrong_character_future_and_forged_mapping(self):
        data=retain([source(4,'character:player said: 记忆。')]);ident=data['facts'][0]['id']
        with self.assertRaisesRegex(ValueError,'character'):
            projection.delivery_projection(data,[{'id':ident}],{'context':{'character':{'characterId':'other'}}},10)
        with self.assertRaisesRegex(ValueError,'future'):
            projection.delivery_projection(data,[{'id':ident}],request(),3)
        refs=copy.deepcopy(data['facts'][0]['sourceRefs']);refs[0]['sourceHash']='tampered'
        with self.assertRaisesRegex(ValueError,'mapping'):
            projection.delivery_projection(data,[{'id':ident,'matches':[{'atomIds':[ident],'sourceRefs':refs}]}],request(),10)
        forged=copy.deepcopy(data);forged['sources'][0]['characterId']='other'
        with self.assertRaisesRegex(ValueError,'cross-character'):
            projection.retrieval_projection(forged,len)

    def test_multiple_search_views_vote_once_per_memory_per_arm(self):
        data=grouped(retain([source(4,'character:player said: 泡茶。'),source(8,'character:friend said: 看书。')]))
        views=projection.retrieval_projection(data,len,max_tokens=4)
        n=sum(len(views[k]) for k in ('facts','episodes','observations'))
        with patch.object(vector,'encode',return_value=np.array([[1,0]]*n,dtype=np.float32)):
            idx=vector.index(views)
        result=projection.search(idx,SCOPE,'unmatched',queryVector=[1,0],disableArms=['bm25','graph','temporal'])
        for ids in result['memoryArmResults'].values(): self.assertEqual(len(ids),len(set(ids)))
        for row in result['results']: self.assertEqual(row['score'],1/(60+row['rank']))
        self.assertTrue(any(len(row['matches'])>1 for row in result['results']))

    def test_warm_worker_delivers_from_archive_not_search_text(self):
        worker=runpy.run_path(str(Path(__file__).with_name('vector-worker.py')))
        data=grouped(retain([source(4,'character:player said: 我没有泡茶。')]))
        with patch.object(vector,'encode',return_value=np.array([[1,0],[1,0]],dtype=np.float32)):
            idx=worker['dispatch']({'operation':'projected_index',**data})
        with patch.object(vector,'encode',return_value=np.array([[1,0]],dtype=np.float32)):
            result=worker['dispatch']({'operation':'projected_recall','scope':SCOPE,'archive':data,
                'index':idx,'query':'茶','request':{**request(), 'recallEvidence':{'query':'泡茶'}},'tick':10})
        self.assertEqual(len(result['delivery']),1)
        self.assertIn('我没有泡茶。',result['delivery'][0]['text'])
        self.assertNotIn('eventAtoms',result['delivery'][0])
        self.assertEqual(result['projectionTrace']['delivery']['delivered'][0]['sourceRefs'],
                         [core.source_ref(data['sources'][0])])

    def test_scope_and_future_window_apply_to_projected_graph(self):
        data=grouped(retain([source(4,'character:player said: 泡茶。'),source(8,'character:friend said: 泡茶。')]))
        views=projection.retrieval_projection(data,len,max_tokens=60)
        n=sum(len(views[k]) for k in ('facts','episodes','observations'))
        with patch.object(vector,'encode',return_value=np.array([[1,0]]*n,dtype=np.float32)):
            idx=vector.index(views)
        result=projection.search(idx,SCOPE,'茶',queryVector=[1,0],tickWindow={'start':0,'end':5})
        self.assertTrue(all(r['worldSeq']<=5 for c in result['results'] for m in c['matches'] for r in m['sourceRefs']))
        with self.assertRaisesRegex(ValueError,'scope'):
            projection.search(idx,{**SCOPE,'characterId':'other'},'茶',queryVector=[1,0])

if __name__=='__main__':unittest.main()
