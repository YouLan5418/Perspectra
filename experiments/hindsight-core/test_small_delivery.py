"""Regression checks for the small, conservative playtest delivery policy."""
import copy,json,runpy,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import core,episode_core as episode,projections as projection,vector_core as vector,queries
from test_episode_core import SCOPE,source,retain,grouped
from test_projections import request

def observation(data,support,counter=()):
    with patch.object(core,'llm',return_value={'observations':[{'text':'他泡好茶并照顾了我。',
                'supporting_atom_ids':support,'contradicting_atom_ids':list(counter)}]}):
        return {**data,**episode.consolidate({**data,'observations':[]})}

class SmallDeliveryTest(unittest.TestCase):
    def test_runtime_encodes_clean_text_bm25_excludes_names_and_keeps_entity_seed(self):
        data=retain([source(4,'character:player said: 林晓，我没泡茶。')])
        history=[{'scope':SCOPE,'worldSeq':4,'people':[{'characterId':'character:companion','name':'林晓'}]}]
        views=projection.retrieval_projection(data,len,alias_history=history)
        with patch.object(vector,'encode',return_value=np.array([[1,0]],dtype=np.float32)) as encoded:
            idx=vector.index(views)
        self.assertEqual(encoded.call_args.args[0],['我没泡茶。'])
        self.assertIn('林晓',idx['units'][0]['text'])
        self.assertIn('character:companion',idx['units'][0]['entities'])
        req=request();req['context']['stimulus']=[{'content':{'speech':{'characterId':'character:player','text':'林晓，我没泡茶。'}}}]
        q=queries.project(req,idx['retrievalAliases'])
        self.assertNotIn('林晓',q['semanticQuery']);self.assertNotIn('林晓',q['keywordTerms'])
        self.assertIn('character:companion',[e['id'] for e in q['entitySeeds']])
        names=queries.project({**req,'recallEvidence':{'query':'林晓'}},idx['retrievalAliases'])
        result=projection.search(idx,SCOPE,names['semanticQuery'],queryProjection=names,quality=True,queryVector=[1,0])
        self.assertEqual(result['results'],[])

    def test_default_cap_is_three_complete_items(self):
        data=retain([source(n,'character:player said: 第'+str(n)+'条原话。') for n in [2,4,6,8,10]])
        result=projection.delivery_projection(data,[{'id':a['id']} for a in data['facts']],request(),12)
        self.assertEqual(len(result['memories']),3)
        self.assertEqual(result['trace']['budget']['maxItems'],3)

    def test_mixed_confirmed_action_cannot_validate_speech_claim(self):
        action={'actorId':'character:player','actionType':'move','status':'accepted','movement':{'toLocationId':'location:garden'}}
        data=retain([source(4,json.dumps(action),kind='observed_action'),source(8,'character:player said: 我泡好了茶。')])
        data=observation(data,[a['id'] for a in data['facts']])
        before=copy.deepcopy(data)
        result=projection.delivery_projection(data,[{'id':'obs:1'}],request(),10)
        self.assertFalse(any(m['memoryLevel']=='observation' for m in result['memories']))
        self.assertNotIn('他泡好茶',json.dumps(result['memories'],ensure_ascii=False))
        self.assertEqual(data,before)

    def test_rejected_action_cannot_support_free_observation(self):
        action={'actorId':'character:player','actionType':'move','status':'rejected','movement':{'toLocationId':'location:garden'}}
        data=retain([source(4,json.dumps(action),kind='observed_action')])
        data=observation(data,[data['facts'][0]['id']])
        result=projection.delivery_projection(data,[{'id':'obs:1'}],request(),10)
        self.assertEqual(result['memories'][0]['memoryLevel'],'event_atom')
        self.assertIn('rejected',result['memories'][0]['text'])

    def test_confirmed_action_observation_keeps_counter_evidence_as_one_budget_group(self):
        action={'actorId':'character:player','actionType':'move','status':'accepted','movement':{'toLocationId':'location:garden'}}
        data=retain([source(4,json.dumps(action),kind='observed_action'),source(8,'character:player said: 我没有去院子。')])
        support,counter=[a['id'] for a in data['facts']]
        data=observation(data,[support],[counter])
        data['observations'][0]['text']='【主观认识，可修正】我观察到他去了院子，但听到另一种说法。'
        result=projection.delivery_projection(data,[{'id':'obs:1'}],request(),10)
        self.assertEqual([m['memoryLevel'] for m in result['memories']],['observation','event_atom'])
        self.assertEqual(projection.delivery_projection(data,[{'id':'obs:1'}],request(),10,max_items=1)['memories'],[])

    def test_fallback_does_not_pick_unrelated_support_when_atom_scores_reject_it(self):
        data=retain([source(4,'character:player said: 我泡好了茶。')])
        ident=data['facts'][0]['id'];data=observation(data,[ident])
        match={'atomIds':[ident],'sourceRefs':data['facts'][0]['sourceRefs'],
               'atomScores':[{'atomId':ident,'accepted':False,'relevance':0}]}
        result=projection.delivery_projection(data,[{'id':'obs:1','matches':[match]}],request(),10)
        self.assertEqual(result['memories'],[])

    def test_worker_rejects_foreign_alias_world_before_query(self):
        worker=runpy.run_path(str(Path(__file__).with_name('vector-worker.py')))
        data=retain([source(4,'character:player said: 私下。')])
        idx={'scope':SCOPE,'retrievalAliases':{'scope':{**SCOPE,'worldAddress':{**SCOPE['worldAddress'],'worldId':'other'}}}}
        with patch.object(queries,'project',side_effect=AssertionError('must not query')):
            with self.assertRaisesRegex(ValueError,'alias scope'):
                worker['projected_recall']({'archive':data,'scope':SCOPE,'index':idx,'request':request(),'tick':10})
if __name__=='__main__':unittest.main()
