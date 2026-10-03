import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parent))
import core
import vector_core as vector

SCOPE={'worldAddress':{'tenantId':'t','worldId':'w','branchId':'b'},'characterId':'npc','asOfWorldSeq':100}
def source(n,text):
    return {'sourceId':'event:'+str(n),'sourceHash':'sha256:'+str(n),'epistemicKind':'reported_speech',
            'worldSeq':n,'knownTick':n,'characterId':'npc','worldAddress':SCOPE['worldAddress'],'text':text}
def prepared():
    sources=[source(2,'semantic paraphrase'),source(4,'a linked earlier episode'),source(90,'private later correction')]
    facts=[{'id':'fact:'+str(i),'text':s['text'],'kind':'fact','entities':['same person'],
            'sourceRefs':[core.source_ref(s)]} for i,s in enumerate(sources)]
    with patch.object(vector,'encode',return_value=np.asarray([[1,0],[0,1],[0.8,0.6]],dtype=np.float32)):
        return vector.index({'scope':SCOPE,'sources':sources,'representations':[],'facts':facts,'observations':[]})

class SearchTest(unittest.TestCase):
    def test_empty_cold_memory_after_recent_sources_excluded(self):
        idx=prepared()
        idx.update(units=[],vectors=[],links=[])
        result=vector.recall({'scope':SCOPE,'index':idx,'query':'current stimulus','queryVector':[1,0]})
        self.assertEqual(result['results'],[])
        self.assertEqual(result['arms'],{'semantic':0,'bm25':0,'graph':0,'temporal':0})

    def test_semantic_candidate_without_keyword_overlap(self):
        idx=prepared()
        result=vector.recall({'scope':SCOPE,'index':idx,'query':'unrelated words',
                             'queryVector':[1,0],'disableArms':['bm25','graph','temporal']})
        self.assertEqual(result['results'][0]['id'],'fact:0')
        self.assertEqual(result['arms']['bm25'],0)

    def test_graph_recovers_nonsemantic_neighbor(self):
        idx=prepared()
        result=vector.recall({'scope':SCOPE,'index':idx,'query':'unrelated words',
                             'queryVector':[1,0],'graphSeedLimit':1})
        ids=[r['id'] for r in result['armResults']['graph']]
        self.assertIn('fact:1',ids)
        self.assertNotIn('fact:1',[r['id'] for r in result['armResults']['semantic']])

    def test_time_window_applies_to_all_arms_and_neighbors(self):
        idx=prepared()
        idx['links'].append(['fact:0','fact:2','semantic',0.99,None])
        result=vector.recall({'scope':SCOPE,'index':idx,'query':'correction episode',
                             'queryVector':[1,0],'tickWindow':{'start':0,'end':10}})
        for arm in result['armResults'].values():
            self.assertNotIn('fact:2',[r['id'] for r in arm])
        self.assertGreater(result['arms']['temporal'],0)
        self.assertTrue(all(ref['worldSeq']<=10 for u in result['results'] for ref in u['sourceRefs']))

    def test_tampered_hash_and_foreign_source_rejected(self):
        idx=prepared()
        idx['units'][0]['sourceRefs'][0]['sourceHash']='sha256:tampered'
        with self.assertRaisesRegex(ValueError,'reference'):
            vector.recall({'scope':SCOPE,'index':idx,'query':'a','queryVector':[1,0]})
        idx=prepared()
        idx['sources'][0]['characterId']='other'
        with self.assertRaisesRegex(ValueError,'cross-character'):
            vector.recall({'scope':SCOPE,'index':idx,'query':'a','queryVector':[1,0]})

    def test_foreign_graph_edge_rejected(self):
        idx=prepared()
        idx['links'].append(['fact:0','other-character-unit','semantic',1,None])
        with self.assertRaisesRegex(ValueError,'foreign graph'):
            vector.recall({'scope':SCOPE,'index':idx,'query':'a','queryVector':[1,0]})

if __name__=='__main__': unittest.main()
