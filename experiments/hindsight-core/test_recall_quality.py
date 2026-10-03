import copy,json,runpy,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import core,queries,projections as projection,vector_core as vector
from test_episode_core import SCOPE,source,retain,grouped
from test_projections import request
def make_index(data):
    views=projection.retrieval_projection(data,len,max_tokens=100)
    n=sum(len(views[k]) for k in ('facts','episodes','observations'))
    with patch.object(vector,'encode',return_value=np.array([[1,0]]*n,dtype=np.float32)):
        return vector.index(views)
def query(text):
    return {'semanticQuery':text,'keywordTerms':queries.lexical_terms(text),'entitySeeds':[],
            'mode':'search','tokenCount':20,'truncated':False}
class QualityTest(unittest.TestCase):
    def test_worker_rejects_another_character_before_query_or_embedding(self):
        worker=runpy.run_path(str(Path(__file__).with_name('vector-worker.py')))
        data=retain([source(4,'character:player said: 私下的经历。')])
        wrong=copy.deepcopy(request());wrong['context']['character']['characterId']='character:other'
        with patch.object(queries,'project',side_effect=AssertionError('must not prepare foreign query')), patch.object(vector,'encode',side_effect=AssertionError('must not encode')):
            with self.assertRaisesRegex(ValueError,'another character'):
                worker['projected_recall']({'scope':SCOPE,'archive':data,'request':wrong})
    def test_successful_movement_only_uses_entities_and_does_not_retell_old_actions(self):
        action={'actorId':'character:player','actionType':'move','status':'accepted',
                'movement':{'fromLocationId':'location:room','toLocationId':'location:garden'}}
        data=retain([source(4,json.dumps(action),kind='observed_action'),
                     source(8,'character:player said: 离开room进入garden前，要记得那次约定。')])
        req=copy.deepcopy(request());req['context']['stimulus']=[{'content':action}]
        q=queries.project(req)
        self.assertEqual(q['mode'],'entity')
        idx=make_index(data)
        # A genuine reminder has a semantic signal, while the old action is just a record.
        idx['vectors']=[[0,1],[1,0]]
        result=projection.search(idx,SCOPE,q['semanticQuery'],queryProjection=q,quality=True,queryVector=[1,0])
        self.assertEqual(result['armResults']['semantic'],[])
        self.assertEqual(result['armResults']['bm25'],[])
        self.assertTrue(result['results'])
        self.assertNotIn(data['facts'][0]['id'],[c['id'] for c in result['results']])
    def test_entity_only_cannot_admit_irrelevant_memories_and_raw_scores_survive(self):
        data=retain([source(4,'character:player said: 下雨。'),source(8,'character:player said: 睡觉。')])
        idx=make_index(data);q=query('泡茶');q['entitySeeds']=[{'id':'character:player','roles':['actor']}]
        result=projection.search(idx,SCOPE,'泡茶',queryProjection=q,quality=True,queryVector=[1,0])
        self.assertEqual(result['results'],[])
        self.assertEqual(result['armResults']['graph'],[])
        self.assertTrue(all('bm25Score' in r and 'keywordCoverage' in r for r in result['rawScores']))
    def test_semantic_paraphrase_survives_without_keyword_overlap(self):
        data=retain([source(2,'character:player said: 必须兑现诺言。'),
                     source(4,'character:player said: 下雨。'),source(8,'character:player said: 睡觉。')])
        idx=make_index(data);idx['vectors']=[[1,0],[0,1],[0,1]]
        result=projection.search(idx,SCOPE,'承诺',queryProjection=query('承诺'),quality=True,queryVector=[1,0])
        self.assertEqual(len(result['results']),1)
        self.assertEqual(result['results'][0]['matches'][0]['bm25Score'],0)
    def test_duplicate_windows_do_not_consume_32_memory_slots(self):
        data=retain([source(4,'character:player said: 泡茶。'),source(8,'character:friend said: 泡茶。')])
        idx=make_index(data);first,last=idx['units']
        idx['units']=[{**first,'id':'copy:'+str(i)} for i in range(40)]+[last]
        idx['vectors']=[[1,0]]*40+[[0.8,0.6]];idx['links']=[]
        result=projection.search(idx,SCOPE,'泡茶',queryProjection=query('泡茶'),quality=True,queryVector=[1,0])
        self.assertEqual(len(result['memoryArmResults']['semantic']),2)
        self.assertEqual(len(result['graphSeeds']),2)
    def test_temporal_window_and_owner_apply_before_quality_search(self):
        data=retain([source(4,'character:player said: 泡茶。'),source(8,'character:friend said: 泡茶。')])
        idx=make_index(data)
        result=projection.search(idx,SCOPE,'泡茶',queryProjection=query('泡茶'),quality=True,queryVector=[1,0],tickWindow={'start':0,'end':5})
        self.assertTrue(all(r['worldSeq']<=5 for c in result['results'] for m in c['matches'] for r in m['sourceRefs']))
        with self.assertRaisesRegex(ValueError,'scope'):
            projection.search(idx,{**SCOPE,'characterId':'other'},'泡茶',queryProjection=query('泡茶'),quality=True,queryVector=[1,0])
    def test_episode_cannot_fill_budget_before_other_memories(self):
        data=grouped(retain([source(n,'character:player said: 第'+str(n)+'次邀请。') for n in [2,4,6,8]]))
        other=retain([source(10,'character:friend said: 我不确定。')]);data['sources']+=other['sources'];data['facts']+=other['facts']
        ep=data['episodes'][0];atoms=data['facts'][:4];ident=data['facts'][-1]['id']
        candidate={'id':ep['id'],'matches':[{'atomIds':ep['eventAtomIds'],'sourceRefs':ep['sourceRefs']}]}
        result=projection.delivery_projection(data,[candidate,{'id':ident}],request(),12,max_items=3,fair=True)
        self.assertEqual(result['memories'][1]['memoryId'],ident)
        self.assertEqual(len(result['memories']),3)
    def test_single_character_topic_matches_inside_longer_passage(self):
        data=retain([source(4,'character:player said: 我喜欢热茶。')])
        result=projection.search(make_index(data),SCOPE,'茶',queryProjection=query('茶'),quality=True,queryVector=[1,0])
        self.assertTrue(result['results'])
        self.assertGreater(result['results'][0]['matches'][0]['bm25Score'],0)
    def test_quality_rejects_forged_hash(self):
        data=retain([source(4,'character:player said: 泡茶。')]);idx=make_index(data)
        idx['units'][0]['sourceRefs'][0]['sourceHash']='tampered'
        with self.assertRaisesRegex(ValueError,'reference'):
            projection.search(idx,SCOPE,'泡茶',queryProjection=query('泡茶'),quality=True,queryVector=[1,0])
    def test_counter_evidence_remains_atomic_under_fair_budget(self):
        data=grouped(retain([source(4,'character:player said: 我泡了茶。'),source(8,'character:player said: 我没有泡茶。')]))
        first,second=[a['id'] for a in data['facts']]
        with patch.object(core,'llm',return_value={'observations':[{'text':'泡茶的说法矛盾。','supporting_atom_ids':[first],'contradicting_atom_ids':[second]}]}):
            data={**data,**projection.episode.consolidate({**data,'observations':[]})}
        result=projection.delivery_projection(data,[{'id':'obs:1'}],request(),10,max_items=1,fair=True)
        self.assertEqual(result['memories'],[])
if __name__=='__main__':unittest.main()
