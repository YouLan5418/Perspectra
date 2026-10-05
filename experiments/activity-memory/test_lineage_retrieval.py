"""Regression checks for projection continuity and bounded family search."""
import copy
import unittest
from unittest.mock import patch
import numpy as np
import lineage_retrieval as exp

class RetrievalLineageTest(unittest.TestCase):
    def setUp(self):
        self.subject={'name':'旅人','characterId':'character:player'}
        self.old={'facets':{'subjects':[self.subject],**{f:['旧入口'+f] for f in exp.FIELDS}}}
        self.answer={'subjects':[self.subject],
            'retained':{f:self.old['facets'][f][:] for f in exp.FIELDS},
            'removed':{f:[] for f in exp.FIELDS},'added':{f:[] for f in exp.FIELDS}}

    def entry(self,ident,subject='character:player',scenario_count=1):
        return {'memoryId':ident,'facets':{'subjects':[{'characterId':subject}]},
            'bodyText':'带路','bodyVector':[1.,0.],
            'scenarios':[{'text':'陌生地点带路','retrievalText':'陌生地点带路',
                          'kind':'context','vector':[1.,0.]} for _ in range(scenario_count)]}

    def test_continuity_requires_exact_partition_and_authorized_subject(self):
        result=exp.continuity_answer(self.answer,self.old,{'text':'旅人使用旧材料带路。'},[self.subject])
        self.assertEqual(result,self.old['facets'])
        missing=copy.deepcopy(self.answer);missing['retained']['contexts']=[]
        renamed=copy.deepcopy(self.answer);renamed['retained']['contexts']=['换个入口']
        foreign=copy.deepcopy(self.answer);foreign['subjects']=[{'name':'旅人','characterId':'character:bob'}]
        for answer in (missing,renamed,foreign):
            with self.assertRaises(ValueError):
                exp.continuity_answer(answer,self.old,{'text':'旅人使用旧材料带路。'},[self.subject])

    def test_many_scenarios_and_two_branches_still_produce_one_vote_per_route(self):
        prepared={'archive':{'scope':{}},'entries':[self.entry('current',scenario_count=4),
                  self.entry('opposite',scenario_count=4),self.entry('other','character:bob')]}
        family={'familyId':'navigation','currentVersionIds':['current','opposite'],'revision':{'old':'current'}}
        query={'semanticQuery':'带路','keywordTerms':['带路'],'entitySeeds':[
            {'id':'character:player','roles':['actor']},{'id':'character:bob','roles':['scene']}]}
        with patch.object(exp.bank.bridge.vector_core,'encode',return_value=np.asarray([[1.,0.]],dtype=np.float32)):
            rows=exp.rank(prepared,query,family,True,True)
        nav=next(r for r in rows if r['groupId']=='navigation')
        self.assertLessEqual(nav['rrfScore'],2/61)
        self.assertEqual(nav['semanticRank'],1)
        self.assertEqual(nav['bm25Rank'],1)
        self.assertFalse(next(r for r in rows if r['groupId']=='other')['subjectMatched'])
        simple=copy.deepcopy(prepared)
        for e in simple['entries']:e['scenarios']=e['scenarios'][:1]
        with patch.object(exp.bank.bridge.vector_core,'encode',return_value=np.asarray([[1.,0.]],dtype=np.float32)):
            again=exp.rank(simple,query,family,True,True)
        nav2=next(r for r in again if r['groupId']=='navigation')
        self.assertEqual(nav['rrfScore'],nav2['rrfScore'])
        self.assertEqual(nav['bm25Score'],nav2['bm25Score'])

    def test_candidate_budget_never_partially_opens_conflict_group(self):
        rows=[{'groupId':'navigation','subjectMatched':True,'readingIds':['current','opposite']},
              {'groupId':'background','subjectMatched':True,'readingIds':['background']}]
        ids,selected,rejected=exp.shortlist(rows,1)
        self.assertEqual(ids,['background'])
        self.assertNotIn('navigation',selected)
        self.assertEqual(rejected[0]['groupId'],'navigation')
        self.assertEqual(exp.shortlist(rows,2)[0],['current','opposite'])

    def test_history_opens_only_revision_endpoint_and_keeps_current_conflict(self):
        prepared={'entries':[self.entry('current'),self.entry('opposite'),self.entry('unrelated')]}
        family={'familyId':'navigation','currentVersionIds':['current','opposite'],
                'revision':{'old':'current'},'absorbedAspectIds':['old-aspect']}
        default=exp.groups(prepared,family,True)
        historical=exp.groups(prepared,family,True,True)
        self.assertNotIn('old',[i for r in default for i in r['readingIds']])
        nav=next(r for r in historical if r['groupId']=='navigation')
        self.assertEqual(nav['readingIds'],['old','current','opposite'])
        self.assertNotIn('old-aspect',nav['readingIds'])


    def test_foreign_request_is_rejected_before_external_judge(self):
        data={'archive':{'scope':{'characterId':'character:npc','worldAddress':{'worldId':'one'}}}}
        for context in ({'character':{'characterId':'character:bob'}},
                        {'character':{'characterId':'character:npc'},'cognition':{'address':{'worldId':'two'}}}):
            with patch.object(exp.bank.jev,'assess_many') as model:
                with self.assertRaisesRegex(ValueError,'before JEV'):
                    exp.evaluate(data,{}, {'context':context},{},[],[])
                model.assert_not_called()

if __name__=='__main__':
    unittest.main()
