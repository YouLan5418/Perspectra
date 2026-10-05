"""Regressions for body delivery, partial evidence honesty and necessary authorization boundaries."""
import copy, unittest
from unittest.mock import patch
import cognition_lineage as lineage
import notice_board_action_loop as loop
import minimal_delivery as minimal
import minimal_delivery_contrast as contrast
import immediate_delivery

class MinimalDeliveryTest(unittest.TestCase):
    def setUp(self):
        initial,_,_=lineage.fixture_archive({'id':'minimal-delivery','oldText':'原认识',
            'oldEvidence':[{'text':'牌A写登记去A。','tick':1},{'text':'牌B写登记去B。','tick':2}],
            'newEvidence':[{'text':'character:staff said: 我记得去A，但没有核实。','tick':3}]})
        sources=copy.deepcopy(initial['sources']);sources[-1]['epistemicKind']='reported_speech'
        self.archive=loop.archive_from({'scope':initial['scope'],'sources':sources})
        a,b,c=[a['id'] for a in self.archive['facts']]
        self.observation=lineage.observation(self.archive,'cognition:local:current','两块牌面有分歧，工作人员只是回忆。',[a,c],[b])
        self.archive['observations']=[self.observation]
        self.pool=[{'id':self.observation['id'],'relevance':.2,'score':0.,'rank':1,'matches':[]}]
        self.request={'context':{'character':{'characterId':'character:npc'},'observations':[],'selfObservations':[]}}
        self.query={'originalText':'办理材料，接下来怎么办？','entitySeeds':[]}

    def deliver(self, **kwargs):
        return minimal.deliver(self.archive,self.pool,[self.observation['id']],self.request,4,self.query,**kwargs)

    def test_mixed_speech_body_is_delivered_as_subjective_with_counter_and_source_types(self):
        before=copy.deepcopy((self.archive,self.pool,self.request,self.query))
        old=loop.bridge.activity.deliver(self.archive,self.pool,self.request,4,copy.deepcopy(self.query))
        self.assertNotIn(self.observation['id'],[m['memoryId'] for m in old['memories']])
        new=self.deliver();item=new['memories'][0]
        self.assertTrue(item['text'].endswith(self.observation['text']))
        self.assertEqual(item['epistemicKind'],'subjective_inference')
        self.assertEqual(item['sourceTypes'],['direct_observation','reported_speech'])
        self.assertTrue(item['hasUnresolvedCounterEvidence'])
        self.assertEqual([e['role'] for e in item['keyEvidence']],['counter','support'])
        self.assertEqual(item['keyEvidence'][1]['epistemicKind'],'reported_speech')
        self.assertIn('未经独立核实',item['keyEvidence'][1]['text'])
        self.assertFalse(item['evidenceCoverage']['complete'])
        self.assertEqual(before,(self.archive,self.pool,self.request,self.query))

    def test_evidence_that_cannot_fit_does_not_cancel_body(self):
        high=self.deliver()['memories'][0]
        high['keyEvidence']=[]
        high['evidenceCoverage'].update({'included':0,'counterIncluded':0,'complete':False})
        budget=loop.bridge.projections.chars([high])
        new=self.deliver(max_json_chars=budget)
        self.assertEqual(len(new['memories']),1)
        self.assertEqual(new['memories'][0]['keyEvidence'],[])
        self.assertTrue(new['memories'][0]['hasUnresolvedCounterEvidence'])
        self.assertEqual(new['memories'][0]['evidenceCoverage']['counterIncluded'],0)
        self.assertEqual(new['trace']['jsonChars'],budget)
        self.assertEqual(self.deliver(max_json_chars=budget-1)['memories'],[])

    def test_complete_evidence_does_not_claim_unshown_evidence_exists(self):
        a,b,_=[a['id'] for a in self.archive['facts']]
        self.observation=lineage.observation(self.archive,self.observation['id'],'双牌分歧仍未核实。',[a],[b])
        self.archive['observations']=[self.observation]
        item=self.deliver()['memories'][0]
        self.assertTrue(item['evidenceCoverage']['complete'])
        self.assertTrue(item['hasUnresolvedCounterEvidence'])
        self.assertIn('已全部展示',item['evidenceCoverage']['note'])
        self.assertNotIn('未展示的证据和反证仍存在',item['evidenceCoverage']['note'])

    def test_immediate_reuse_rejects_frozen_sources_outside_host_snapshot(self):
        doc={'initial':{'archive':self.archive,'record':{'current':self.archive['observations']}},
             'snapshot':{'scope':self.archive['scope'],'sources':self.archive['sources'],'tick':4},'request':self.request}
        for kind in ('owner','missing-source','hash'):
            with self.subTest(kind=kind):
                bad=copy.deepcopy(doc)
                # Copies retain shared references; replace the host values independently.
                bad['snapshot']=copy.deepcopy(doc['snapshot'])
                if kind=='owner':bad['snapshot']['scope']['characterId']='character:bob'
                if kind=='missing-source':bad['snapshot']['sources'].pop()
                if kind=='hash':bad['snapshot']['sources'][0]['sourceHash']='sha256:other-world-prefix'
                with self.assertRaises(ValueError):immediate_delivery.prepare(bad)

    def test_unselected_observation_is_not_delivered(self):
        self.assertEqual(minimal.deliver(self.archive,self.pool,[],self.request,4,self.query)['memories'],[])
        with self.assertRaises(ValueError):minimal.deliver(self.archive,self.pool,['cognition:foreign'],self.request,4,self.query)

    def test_owner_world_future_and_forged_citations_fail_closed(self):
        for kind in ('owner','world','future-seq','future-tick','citation-hash'):
            with self.subTest(kind=kind):
                archive,request=copy.deepcopy((self.archive,self.request))
                if kind=='owner':request['context']['character']['characterId']='character:bob'
                if kind=='world':request['context']['cognition']={'address':{**archive['scope']['worldAddress'],'branchId':'branch:other'}}
                if kind=='future-seq':archive['sources'][0]['worldSeq']=archive['scope']['asOfWorldSeq']+1
                if kind=='future-tick':archive['sources'][0]['knownTick']=5
                if kind=='citation-hash':archive['observations'][0]['sourceRefs'][0]['sourceHash']='sha256:forged'
                with self.assertRaises(ValueError):minimal.deliver(archive,self.pool,[self.observation['id']],request,4,self.query)

    def test_jev_ablation_bypasses_selection_without_fabricating_jev_acceptance(self):
        answer={'related':False,'choice':'UNRELATED','probabilities':{'RELATED':.01,'UNRELATED':.98,'UNCERTAIN':.01},
                'confidence':None,'model':loop.jev.MODEL,'usage':{},'latencyMs':0}
        decision={'answers':{self.observation['id']:answer},'usage':{},'latencyMs':3}
        doc={'phase':'jev','input':{'revision':{'archive':self.archive},'scope':self.archive['scope'],
            'variant':'current-cognition','request':self.request,'tick':4},
            'recall':{'retrieval':{'results':self.pool},'sentIds':[self.observation['id']],
                      'query':self.query,'decision':decision}}
        with patch.object(loop.jev,'assess_many',return_value=decision) as call:
            pair=contrast.prepare(doc)
        call.assert_called_once()
        self.assertEqual(pair['with-jev']['delivery']['memories'],[])
        self.assertEqual(pair['without-jev']['delivery']['memories'][0]['memoryId'],self.observation['id'])
        self.assertIsNone(pair['without-jev']['decision'])
        self.assertEqual(pair['with-jev']['retrieval'],pair['without-jev']['retrieval'])

if __name__=='__main__':unittest.main()
