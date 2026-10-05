"""Reading-group invariants and existing counterevidence clipping regression."""
import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch
import delivery_groups as exp

class GroupDeliveryTest(unittest.TestCase):
    def archive(self,case='A'):
        cases=json.loads(Path(__file__).with_name('observation-lineage-fixture.json').read_text(encoding='utf-8'))['cases']
        return exp.exp.lineage.fixture_archive(next(c for c in cases if c['id']==case))

    def request(self,doc,recent=()):
        return {'context':{'character':{'characterId':doc['scope']['characterId']},
            'observations':[{'sourceSeq':i} for i in recent],'selfObservations':[]}}

    def candidates(self,units):
        from audit_cognition_lineage import candidates
        return candidates(units)

    def historical_doc(self):
        doc,old,new=self.archive()
        current=exp.exp.lineage.observation(doc,'current',old['text'],old['supportingAtomIds']+new,[])
        doc['observations'].append(current)
        family={'revision':{old['id']:current['id']},'currentVersionIds':[current['id']],'hasUnresolvedConflict':False}
        return doc,old,current,family

    def test_history_pair_is_old_first_and_costs_two_actual_items(self):
        doc,old,current,family=self.historical_doc()
        units=[current,old];before=copy.deepcopy(doc)
        result=exp.deliver(doc,self.candidates(units),exp.simple_decision(units),self.request(doc),55,
            {'originalText':'history','cognitionQueryMode':'historical'},family,'history_pairs')
        self.assertEqual([m['memoryId'] for m in result['memories']],[old['id'],current['id']])
        self.assertEqual(result['trace']['readingGroups'][0]['additionalItems'],2)
        self.assertEqual(doc,before)

    def test_pair_is_not_partially_read_and_missing_endpoint_not_invented(self):
        doc,old,current,family=self.historical_doc()
        units=[current,old];query={'originalText':'history','cognitionQueryMode':'historical'}
        result=exp.deliver(doc,self.candidates(units),exp.simple_decision(units),self.request(doc),55,
            query,family,'history_pairs',max_items=1)
        self.assertEqual(result['memories'],[])
        self.assertEqual(len(result['trace']['omitted']),1)
        groups=exp.make_groups(self.candidates([current]),exp.simple_decision([current]),family,'history_pairs',True)
        self.assertEqual(groups[0]['memberIds'],[current['id']])
        self.assertNotIn('historical_revision',groups[0]['kinds'])

    def test_unresolved_conflict_deduplicates_shared_counters_without_hiding_budget_cost(self):
        doc,old,new=self.archive('D')
        units=[exp.exp.lineage.observation(doc,'negative',old['text'],old['sourceFactIds'],new),
               exp.exp.lineage.observation(doc,'positive',old['text'],new,old['sourceFactIds'])]
        doc['observations']+=units
        family={'revision':{},'currentVersionIds':[u['id'] for u in units],'hasUnresolvedConflict':True}
        common=(doc,self.candidates(units),exp.simple_decision(units),self.request(doc),55,
                {'originalText':'navigation'},family,'history_and_conflict')
        small=exp.deliver(*common)
        self.assertEqual(small['memories'],[])
        large=exp.deliver(*common,max_items=12)
        self.assertEqual(len(large['memories']),8)
        self.assertEqual(large['trace']['readingGroups'][0]['requiredItemsBeforeSharedDedup'],8)
        self.assertEqual(large['trace']['distinctEvidenceSegments'],6)
        # Whole group must also fit the character limit, not merely item count.
        chars=large['trace']['jsonChars']
        blocked=exp.deliver(*common,max_items=12,max_json_chars=chars-1)
        self.assertEqual(blocked['memories'],[])

    def test_repaired_runtime_and_final_group_never_expose_summary_without_counter(self):
        control=exp.anchor_control()
        runtime=control['runtimeDelivery'];new=control['groupedDelivery'];large=control['largerBudgetDiagnosticOnly']
        self.assertIn(control['summaryId'],[m['memoryId'] for m in runtime['memories']])
        self.assertTrue(any(control['counterAtomId'] in t['coveredAtomIds'] for t in runtime['trace']['delivered']))
        self.assertEqual(new['memories'],[])
        self.assertEqual(len(large['memories']),4)
        self.assertTrue(any(control['counterAtomId'] in t['coveredAtomIds'] for t in large['trace']['delivered']))

    def test_current_context_counter_satisfies_dependency_without_duplicate_reading(self):
        doc,old,new=self.archive('C')
        current=exp.exp.lineage.observation(doc,'current',old['text'],old['sourceFactIds'],new)
        doc['observations'].append(current)
        family={'revision':{},'currentVersionIds':[current['id']],'hasUnresolvedConflict':False}
        recent=[r['worldSeq'] for a in doc['facts'] if a['id'] in new for r in a['sourceRefs']]
        result=exp.deliver(doc,self.candidates([current]),exp.simple_decision([current]),self.request(doc,recent),
            55,{'originalText':''},family,'history_pairs')
        self.assertEqual([m['memoryId'] for m in result['memories']],[current['id']])

    def test_foreign_scope_and_future_evidence_fail_before_materialization(self):
        doc,old,current,family=self.historical_doc()
        for context,tick in (({'character':{'characterId':'character:other'}},55),
                             (self.request(doc)['context'],1)):
            with patch.object(exp,'bundle') as projection:
                with self.assertRaises(ValueError):
                    exp.deliver(doc,self.candidates([current]),exp.simple_decision([current]),
                        {'context':context},tick,{'originalText':''},family,'history_pairs')
                projection.assert_not_called()

    def test_unjudged_raw_evidence_remains_deliverable_without_fabricated_probability(self):
        doc,old,new=self.archive()
        ident=doc['facts'][0]['id']
        candidate={'id':ident,'relevance':.02,'score':.8}
        family={'revision':{},'currentVersionIds':[],'hasUnresolvedConflict':False}
        result=exp.deliver(doc,[candidate],{'answers':{}},self.request(doc),55,
            {'originalText':''},family,'history_pairs')
        self.assertEqual(len(result['memories']),1)
        self.assertEqual(result['memories'][0]['memoryId'],ident)
        self.assertIsNone(result['trace']['readingGroups'][0]['relatedProbability'])

    def test_blind_conflict_grouping_can_reintroduce_a_weak_related_branch(self):
        candidates=[{'id':i,'relevance':.03,'score':.9} for i in ('current','context','required','opposite')]
        decision={'answers':{i:{'choice':'RELATED','related':True,'probabilities':{'RELATED':p}}
            for i,p in (('current',.99),('context',.93),('required',.87),('opposite',.58))}}
        family={'revision':{},'currentVersionIds':['current','opposite'],'hasUnresolvedConflict':True}
        groups=exp.make_groups(candidates,decision,family,'history_and_conflict',False)
        self.assertEqual(groups[0]['memberIds'],['current','opposite'])
        self.assertEqual(groups[0]['relatedProbability'],.99)
        self.assertEqual(groups[1]['memberIds'],['context'])

if __name__=='__main__':
    unittest.main()
