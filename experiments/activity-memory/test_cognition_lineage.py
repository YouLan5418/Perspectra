"""Lineage provenance, no-evidence guard and the observed conflict-delivery limit."""
import copy
import json
import unittest
from pathlib import Path
from unittest.mock import Mock
import cognition_lineage as lineage

class LineageTest(unittest.TestCase):
    def setUp(self):
        cases=json.loads(Path(__file__).with_name('observation-lineage-fixture.json').read_text(encoding='utf-8'))['cases']
        self.archive,self.old,self.new=lineage.fixture_archive(cases[0])

    def call(self, answer, archive=None, new=None):
        return lineage.update(archive or self.archive,self.old,self.new if new is None else new,
                              'family:A',20,20,55,Mock(return_value=answer))

    def answer(self):
        return {'relation':'reinforcement','reason':'same understanding, independent evidence',
                'current':[{'text':self.old['text'],'supportingAtomIds':self.old['sourceFactIds'] + self.new,
                            'contradictingAtomIds':[]}]}

    def test_no_new_evidence_does_not_call_model_or_rewrite(self):
        model=Mock(side_effect=AssertionError('must not call'))
        for ids in ([],self.old['sourceFactIds']):
            result=lineage.update(self.archive,self.old,ids,'family:A',20,20,55,model)
            self.assertEqual(result['current'],[self.old])
            self.assertEqual(result['lastRevisedTick'],20)
        model.assert_not_called()

    def test_reinforcement_one_current_old_retained_times_distinct(self):
        before=copy.deepcopy(self.archive);result=self.call(self.answer())
        self.assertEqual(self.archive,before)
        self.assertEqual(len(lineage.select(result)),1)
        self.assertEqual(lineage.select(result,'historical')[0],self.old)
        self.assertEqual(result['firstFormedTick'],20)
        self.assertEqual(result['lastRevisedTick'],20)
        self.assertEqual(result['evidenceUpdatedTick'],55)
        self.assertEqual(result['current'][0]['knownTickEnd'],49)

    def test_lost_or_foreign_evidence_and_cross_owner_rejected(self):
        lost=self.answer();lost['current'][0]['supportingAtomIds']=self.new
        foreign=self.answer();foreign['current'][0]['supportingAtomIds'].append('atom:foreign')
        owner=copy.deepcopy(self.archive);owner['sources'][0]['characterId']='character:bob'
        for answer,archive in ((lost,self.archive),(foreign,self.archive),(self.answer(),owner)):
            with self.assertRaises(ValueError):
                self.call(answer,archive)

    def test_reinforcement_cannot_change_body(self):
        answer=self.answer();answer['current'][0]['text']='旅人总是故意带错路。'
        with self.assertRaisesRegex(ValueError,'rewrote'):
            self.call(answer)


    def test_conflict_keeps_two_branches_and_exposes_delivery_budget(self):
        cases=json.loads(Path(__file__).with_name('observation-lineage-fixture.json').read_text(encoding='utf-8'))['cases']
        archive,old,new=lineage.fixture_archive(cases[3])
        answer={'relation':'unresolved_conflict','reason':'two independently supported opposite patterns',
                'current':[{'text':'旅人使用旧图可能出错。','supportingAtomIds':old['sourceFactIds'],
                            'contradictingAtomIds':new},
                           {'text':'旅人使用旧图也有准确指路的经历。','supportingAtomIds':new,
                            'contradictingAtomIds':old['sourceFactIds']}]}
        result=lineage.update(archive,old,new,'family:D',20,20,55,Mock(return_value=answer))
        self.assertEqual(len(lineage.select(result)),2)
        self.assertEqual(len(lineage.select(result,'historical')),3)
        self.assertTrue(result['hasUnresolvedConflict'])
        from audit_cognition_lineage import delivery_probe
        delivery=delivery_probe(archive,result)
        self.assertEqual(delivery['3']['deliveredUnderstandingIds'],[])
        self.assertEqual(len(delivery['12']['deliveredUnderstandingIds']),2)
        self.assertEqual(delivery['12']['itemCount'],8)
        self.assertEqual(result['versionMetadata'][result['current'][1]['id']]['firstFormedTick'],55)

    def test_repeated_atoms_from_old_source_do_not_count_as_independent_new_sources(self):
        archive=copy.deepcopy(self.archive)
        source=archive['sources'][0]
        segment=lineage.bridge.episode.segments(source)[0]
        duplicate=lineage.bridge.episode.make_atom(source,segment,segment['context'],1)
        duplicate=lineage.bridge.timed([duplicate],archive['sources'])[0]
        archive['facts'].append(duplicate)
        ids=self.new+[duplicate['id']]
        answer=self.answer();answer['current'][0]['supportingAtomIds'].append(duplicate['id'])
        result=lineage.update(archive,self.old,ids,'family:A',20,20,55,Mock(return_value=answer))
        self.assertEqual(result['generationInput']['independentSourceCounts'],{'old':3,'new':3})

if __name__=='__main__':
    unittest.main()
