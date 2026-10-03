import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import core

ADDRESS = {'tenantId':'t','worldId':'w','branchId':'b'}
SCOPE = {'worldAddress':ADDRESS,'characterId':'alice','asOfWorldSeq':9}
SOURCE = {'sourceId':'event:4','sourceHash':'sha256:known','epistemicKind':'reported_speech',
          'worldSeq':4,'characterId':'alice','worldAddress':ADDRESS,'text':'Bob said he gave the cup to Alice.'}

class BoundaryTest(unittest.TestCase):
    def test_closed_loop_preserves_evidence_and_epistemics(self):
        with patch.object(core,'llm',side_effect=[
            {'facts':[{'what':'Bob claimed he gave the cup to Alice.',
                       'source_id':'event:4','evidence_quote':'Bob said he gave the cup to Alice.',
                       'entities':['Bob','cup']}]},
            {'creates':[{'text':'Bob said he gave the cup to Alice.','source_fact_ids':['fact:event:4:0'],
                         'reason':'same reported claim'}], 'updates':[], 'deletes':[]}
        ]):
            retained=core.retain({'scope':SCOPE,'sources':[SOURCE]})
            consolidated=core.consolidate({**retained,'observations':[]})
        observation=consolidated['observations'][0]
        self.assertEqual(observation['sourceRefs'], [core.source_ref(SOURCE)])
        self.assertEqual(observation['sourceRefs'][0]['epistemicKind'],'reported_speech')
        result=core.recall({**retained, 'observations':[observation], 'query':'cup Bob'})
        self.assertEqual([r['id'] for r in result['results']], [observation['id']])
        self.assertEqual(result['results'][0]['sourceRefs'][0]['sourceHash'],'sha256:known')

    def test_cross_character_source_rejected_before_retain(self):
        with self.assertRaisesRegex(ValueError,'cross-character'):
            core.retain({'scope':SCOPE,'sources':[{**SOURCE,'characterId':'bob'}]})

    def test_future_source_rejected_before_retain(self):
        with self.assertRaisesRegex(ValueError,'future'):
            core.retain({'scope':SCOPE,'sources':[{**SOURCE,'worldSeq':10}]})

    def test_extraction_requires_exact_quote(self):
        with patch.object(core,'llm',return_value={'facts':[{'what':'Alice owns the cup.',
                 'source_id':'event:4','evidence_quote':'Alice owns the cup.','entities':[]}] }):
            result=core.retain({'scope':SCOPE,'sources':[SOURCE]})
        self.assertEqual(result['facts'],[])
        self.assertEqual(len(result['representations']),1)

    def test_empty_fact_batch_keeps_existing_observations(self):
        old={'id':'obs:1','text':'Bob reported the cup transfer.',
             'sourceRefs':[core.source_ref(SOURCE)],'kind':'observation'}
        result=core.consolidate({'scope':SCOPE,'representations':[],
                                 'facts':[],'observations':[old]})
        self.assertEqual(result['observations'],[old])

    def test_observation_update_unions_source_references(self):
        later={**SOURCE,'sourceId':'event:6','sourceHash':'sha256:later','worldSeq':6,
               'text':'Bob repeated that he gave the cup to Alice.'}
        old={'id':'obs:1','text':'Bob claimed he gave away the cup.',
             'sourceRefs':[core.source_ref(SOURCE)],'sourceFactIds':['fact:event:4:0'],
             'kind':'observation'}
        fact={'id':'fact:event:6:0','text':'Bob repeated the claim.',
              'sourceRefs':[core.source_ref(later)],'kind':'fact'}
        with patch.object(core,'llm',return_value={'creates':[],
             'updates':[{'observation_id':'obs:1','text':'Bob twice claimed he gave away the cup.',
                         'source_fact_ids':['fact:event:6:0'],'reason':'same claim'}],
             'deletes':[]}):
            result=core.consolidate({'scope':SCOPE,'representations':[],
                                     'facts':[fact],'observations':[old]})
        self.assertEqual(len(result['observations']),1)
        self.assertEqual({r['sourceId'] for r in result['observations'][0]['sourceRefs']},
                         {'event:4','event:6'})
if __name__=='__main__': unittest.main()
