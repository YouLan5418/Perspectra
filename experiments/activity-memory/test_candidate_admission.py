"""Focused regressions: candidate entry, owner isolation, unchanged scores and counter delivery."""
import copy, json, unittest
import candidate_admission as admission
import cognition_lineage as lineage

class CandidateAdmissionTest(unittest.TestCase):
    def setUp(self):
        self.archive,_,_=lineage.fixture_archive({'id':'candidate',
            'oldText':'牌面位置存在分歧，需要保留不确定。',
            'oldEvidence':[{'text':json.dumps({'actorId':'character:npc','targetId':'entity:board-a','observedText':'牌面说A'},ensure_ascii=False),'tick':1},
                           {'text':json.dumps({'actorId':'character:npc','targetId':'entity:board-b','observedText':'牌面说B'},ensure_ascii=False),'tick':2}],
            'newEvidence':[{'text':'自己的旧经历，没有明确对象关联。','tick':3}]})
        a,b,c=[a['id'] for a in self.archive['facts']]
        self.target=lineage.observation(self.archive,'same-family:current','对两块牌的可修正认识。',[a],[b])
        self.noise=lineage.observation(self.archive,'same-family:noise','另一条无关认识。',[c],[])
        self.archive['observations']=[self.target,self.noise]
        projected=lineage.bridge.projections.retrieval_projection(self.archive,count_tokens=lambda text:1)
        self.index={'scope':copy.deepcopy(self.archive['scope']),
                    'units':projected['facts']+projected['episodes']+projected['observations']}
        self.retrieval={'scope':copy.deepcopy(self.archive['scope']),'results':[],
            'rawScores':[{'id':v['id'],'memoryId':v['memoryId'],'accepted':False,
                          'relevance':.1 if v['projectionLevel']=='observation' else .01,
                          'semanticSimilarity':.89,'semanticLift':.1,'keywordCoverage':.01,
                          'bm25Score':0.,'matchedTerms':[],'semanticScored':True,'graphScore':None}
                         for v in self.index['units']]}
        self.request={'context':{'character':{'characterId':'character:npc'},
            'scene':{'locationId':'location:hall','people':[{'characterId':'character:npc'}]},
            'items':{'current':[{'entityId':'entity:board-a','locationId':'location:hall'},
                                {'entityId':'entity:board-b','locationId':'location:hall'},
                                {'entityId':'entity:terminal','locationId':'location:hall'}]},
            'observations':[],'selfObservations':[]}}
        self.query={'entitySeeds':[{'id':'character:npc','roles':['addressee']},
                                   {'id':'location:hall','roles':['scene']}],
                    'mode':'search','originalText':'办理另一份材料，接下来怎么办？','requiredEntityIds':[]}

    def run_admit(self, request=None, query=None):
        return admission.admit(self.archive,self.index,self.retrieval,request or self.request,query or self.query)

    def test_scene_ids_admit_current_cognition_without_family_expansion_or_score_change(self):
        before=copy.deepcopy((self.archive,self.index,self.retrieval,self.request,self.query))
        rows,trace=self.run_admit()
        self.assertIn(self.target['id'],[r['id'] for r in rows])
        self.assertNotIn(self.noise['id'],[r['id'] for r in rows])
        self.assertFalse(trace['familyExpansion'])
        self.assertNotIn('character:npc',trace['seeds']['entityIds'])
        row=next(r for r in rows if r['id']==self.target['id'])
        self.assertEqual(row['relevance'],.1)
        self.assertEqual(row['matches'][0]['semanticLift'],.1)
        self.assertFalse(row['matches'][0]['originalAccepted'])
        self.assertEqual(before,(self.archive,self.index,self.retrieval,self.request,self.query))

    def test_explicit_other_object_does_not_admit_other_objects_in_same_room(self):
        query=copy.deepcopy(self.query)
        query['entitySeeds'].append({'id':'entity:terminal','roles':['mentioned']})
        rows,trace=self.run_admit(query=query)
        self.assertEqual(rows,[])
        self.assertEqual(trace['seeds']['mode'],'explicit-object')
        self.assertNotIn('entity:board-a',trace['seeds']['entityIds'])

    def test_same_object_topic_is_candidacy_only_and_retains_counter_dependency(self):
        query=copy.deepcopy(self.query)
        query['entitySeeds'].append({'id':'entity:board-a','roles':['mentioned']})
        query['originalText']='只讨论公告牌装饰，不问牌面内容。'
        rows,_=self.run_admit(query=query)
        target=next(r for r in rows if r['id']==self.target['id'])
        self.assertEqual(target['matches'][0]['atomIds'],self.target['sourceFactIds'])
        # The unchanged Delivery still includes all required counter-evidence.
        delivery=lineage.bridge.activity.deliver(self.archive,rows,self.request,4,query,max_items=3,max_json_chars=4500)
        self.assertIn(self.target['id'],[m['memoryId'] for m in delivery['memories']])
        read_ids={i for t in delivery['trace']['delivered'] for i in t['coveredAtomIds']}
        self.assertTrue(set(self.target['contradictingAtomIds']) <= read_ids)

    def test_web_minimal_mode_admits_body_without_running_complex_observation_delivery(self):
        from unittest.mock import patch
        bridge = lineage.bridge
        def raw_only(archive, candidates, *args, **kwargs):
            self.assertTrue(all(c['id'] != self.target['id'] for c in candidates))
            return {'memories':[], 'trace':{'delivered':[], 'omitted':[]}}
        with patch.object(bridge.queries, 'project', return_value={**self.query, 'semanticQuery':'test'}), \
             patch.object(bridge.projections, 'search', return_value=self.retrieval), \
             patch.object(bridge.activity, 'deliver', side_effect=raw_only):
            result=bridge.dispatch({'operation':'recall', 'archive':self.archive, 'index':self.index,
                'request':self.request, 'tick':4, 'observations':True, 'deliveryMode':'minimal'})
        self.assertEqual(result['baselineRetrieval']['results'], [])
        self.assertIn(self.target['id'], [m['memoryId'] for m in result['delivery']])
        self.assertTrue(result['deliveryTrace']['bodyFirst'])
        self.assertFalse(result['deliveryTrace']['truthGate'])
        self.assertFalse(result['deliveryTrace']['completeEvidenceGroupRequired'])
        self.assertEqual(result['jevCalls'], 0)

    def test_low_information_query_does_not_open_scene_history(self):
        query={**self.query,'mode':'skip','originalText':'。'}
        rows,trace=self.run_admit(query=query)
        self.assertEqual(rows,[])
        self.assertTrue(all(r['reason']=='low-information query' for r in trace['units']))

    def test_existing_candidate_and_its_scores_are_preserved(self):
        ident=self.archive['facts'][-1]['id']
        original={'id':ident,'score':.03,'relevance':.9,'matches':[],'rank':1}
        self.retrieval['results']=[original]
        rows,_=self.run_admit()
        self.assertEqual(rows[0],original)

    def test_full_history_indexes_noise_without_rewriting_frozen_cognition(self):
        import notice_board_action_loop as loop
        archive=copy.deepcopy(self.archive)
        archive['sources']=archive['sources'][:2]
        archive['facts']=archive['facts'][:2]
        archive['episodes']=archive['episodes'][:2]
        archive['observations']=[self.target]
        doc={'revision':{'archive':archive},'scope':archive['scope'],'variant':'current-cognition',
             'request':self.request,'tick':4,'authorizedHistory':self.archive['sources']}
        combined=loop.archive_for_recall(doc)
        self.assertEqual(combined['observations'],[self.target])
        self.assertEqual(combined['sources'][:2],archive['sources'])
        self.assertEqual(combined['facts'][:2],archive['facts'])
        self.assertEqual(len(combined['sources']),3)
        self.assertEqual(len(combined['facts']),3)
        self.assertEqual(len(combined['episodes']),3)
        doc['authorizedHistory']=copy.deepcopy(doc['authorizedHistory'])
        doc['authorizedHistory'][0]['text']='changed committed evidence'
        with self.assertRaises(ValueError):loop.archive_for_recall(doc)

    def test_scope_future_and_reference_identity_violations_fail_closed(self):
        for kind in ('owner','world','future','index','source-hash'):
            with self.subTest(kind=kind):
                archive,index,request=copy.deepcopy((self.archive,self.index,self.request))
                if kind=='owner':request['context']['character']['characterId']='character:bob'
                if kind=='world':request['context']['cognition']={'address':{**archive['scope']['worldAddress'],'branchId':'branch:foreign'}}
                if kind=='future':archive['sources'][0]['worldSeq']=archive['scope']['asOfWorldSeq']+1
                if kind=='index':index['scope']['worldAddress']['branchId']='branch:foreign'
                if kind=='source-hash':index['units'][0]['sourceRefs'][0]['sourceHash']='sha256:forged'
                with self.assertRaises(ValueError):
                    admission.admit(archive,index,self.retrieval,request,self.query)

if __name__=='__main__':
    unittest.main()
