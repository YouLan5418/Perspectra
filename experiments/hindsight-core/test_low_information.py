import copy,json,unittest
from unittest.mock import patch
import queries,projections as projection,vector_core as vector
from test_episode_core import SCOPE,source,retain,grouped
from test_projections import request
from test_recall_quality import make_index

class LowInformationTest(unittest.TestCase):
    def test_punctuation_skips_query_and_atom_episode_index_without_deleting_evidence(self):
        data=grouped(retain([source(4,'character:player said: ……'),source(8,'character:player said: 泡茶。')]))
        before=copy.deepcopy(data)
        views=projection.retrieval_projection(data,len)
        ignored=data['facts'][0]['id']
        self.assertEqual(data,before)
        self.assertTrue(views['facts'])
        self.assertTrue(all(ignored not in v['atomIds'] for v in views['facts']+views['episodes']))
        req=request();req['context']['stimulus']=[{'content':{'speech':{'characterId':'character:player','text':'……'}}}]
        with patch.object(queries,'tokenizer',side_effect=AssertionError('no query encoding')):
            q=queries.project(req,views['retrievalAliases'])
        self.assertEqual(q['mode'],'skip')
        self.assertEqual(q['keywordTerms'],[])
        req['context']['scene']={'people':[{'characterId':'character:player','name':'旅人'}]}
        req['context']['stimulus'][0]['content']['speech']['text']='旅人，……'
        with patch.object(queries,'tokenizer',side_effect=AssertionError('no query encoding')):
            self.assertEqual(queries.project(req,views['retrievalAliases'])['mode'],'skip')
        with patch.object(vector,'encode',side_effect=AssertionError('no semantic query')):
            result=projection.search(make_index(data),SCOPE,'',queryProjection=q,quality=True)
        self.assertEqual(result['results'],[])

    def test_item_actions_match_exact_object_and_exclude_old_action_reading(self):
        action={'actorId':'character:player','actionType':'interact','status':'accepted',
                'interaction':{'interactionId':'drop','entityId':'entity:tea-box'}}
        data=retain([source(2,json.dumps(action),'observed_action'),
                     source(4,'character:player said: entity:notebook 是旧笔记本。'),
                     source(8,'character:player said: entity:tea-box 需要小心保管。')])
        req=request();req['context']['stimulus']=[{'content':action}]
        q=queries.project(req)
        self.assertEqual(q['mode'],'entity')
        self.assertEqual(q['requiredEntityIds'],['entity:tea-box'])
        idx=make_index(data)
        with patch.object(vector,'encode',side_effect=AssertionError('object route must not encode')):
            result=projection.search(idx,SCOPE,q['semanticQuery'],queryProjection=q,quality=True)
        self.assertEqual([c['id'] for c in result['results']],[data['facts'][2]['id']])
        self.assertEqual(result['armResults']['semantic'],[])
        self.assertEqual(result['armResults']['bm25'],[])
        self.assertTrue(all(not s['semanticScored'] for s in result['rawScores']))
        req['recallEvidence']={'query':'旧约定'}
        self.assertEqual(queries.project(req)['mode'],'search')

if __name__=='__main__':unittest.main()
