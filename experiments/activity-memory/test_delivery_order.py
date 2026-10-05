"""Small regressions for sorting-only Delivery replay."""
import copy
import unittest
import delivery_order as exp

def candidate(ident,rrf=.03,cosine=.8):
    return {'id':ident,'relevance':rrf,'score':cosine,'rank':99}
def decision(**probabilities):
    return {'answers':{i:{'choice':'RELATED','related':True,'probabilities':{'RELATED':p}}
                       for i,p in probabilities.items()}}

class DeliveryOrderTest(unittest.TestCase):
    def test_applicability_reorders_without_changing_candidate_scores_or_input(self):
        candidates=[candidate('queue',.04,.95),candidate('date',.02,.7)]
        frozen=copy.deepcopy(candidates)
        ranked=exp.order(candidates,decision(queue=.58,date=.84))
        self.assertEqual([c['id'] for c in ranked],['date','queue'])
        self.assertEqual(candidates,frozen)
        self.assertEqual([(c['relevance'],c['score']) for c in ranked],[(.02,.7),(.04,.95)])
        self.assertEqual([c['rank'] for c in ranked],[1,2])

    def test_ties_use_existing_fusion_then_cosine_then_id(self):
        candidates=[candidate('d',.02,.9),candidate('c',.03,.7),
                    candidate('b',.03,.8),candidate('a',.03,.8)]
        ranked=exp.order(candidates,decision(a=.8,b=.8,c=.8,d=.8))
        self.assertEqual([c['id'] for c in ranked],['a','b','c','d'])

    def test_unjudged_evidence_keeps_slot_and_empty_stays_empty(self):
        candidates=[candidate('low'),candidate('atom'),candidate('high')]
        ranked=exp.order(candidates,decision(low=.5,high=.9))
        self.assertEqual([c['id'] for c in ranked],['high','atom','low'])
        self.assertEqual(exp.order([],decision()),[])

    def test_nonrelated_or_invalid_probability_cannot_be_promoted(self):
        candidates=[candidate('a')]
        bad=decision(a=.9);bad['answers']['a'].update(choice='UNRELATED',related=False)
        for answer in (bad,decision(a=float('nan')),decision(a=2),decision(a=True)):
            with self.assertRaises(ValueError):
                exp.order(candidates,answer)
        # A high-scoring nonadmitted answer is never manufactured into a candidate.
        ranked=exp.order(candidates,decision(a=.6,missing=.99))
        self.assertEqual([c['id'] for c in ranked],['a'])

if __name__=='__main__':
    unittest.main()
