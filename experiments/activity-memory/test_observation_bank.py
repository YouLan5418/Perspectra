"""Small regression: field count cannot create extra votes and subjects stay separate."""
import unittest
from unittest.mock import patch
import observation_bank as bank

class BankTriggerTest(unittest.TestCase):
    def test_subject_gate_and_one_semantic_vote_per_understanding(self):
        entries = []
        for ident,subject in [('one','character:player'),('many','character:player'),('other','character:bob')]:
            fields = {f:('路线' if ident=='many' else '') for f in bank.FIELDS}
            entries.append({'memoryId':ident,'facets':{'subjects':[{'characterId':subject}]},
                'bodyText':'路线','fieldTexts':fields,'bodyVector':[1.,0.],
                'fieldVectors':{f:[1.,0.] for f in bank.FIELDS}})
        data={'entries':entries,'archive':{'scope':{}}}
        query={'semanticQuery':'路线','keywordTerms':['路线'],
               'entitySeeds':[{'id':'character:player','roles':['actor']},
                              {'id':'character:bob','roles':['scene']}]}
        with patch.object(bank.bridge.vector_core,'encode',return_value=bank.np.asarray([[1.,0.]],dtype=bank.np.float32)):
            rows,_=bank.trigger(data,query)
        self.assertEqual(len(rows),3)
        by_id={r['memoryId']:r for r in rows}
        self.assertFalse(by_id['other']['subjectMatched'])
        self.assertEqual(by_id['other']['rrfScore'],0)
        for ident in ('one','many'):
            self.assertLessEqual(by_id[ident]['rrfScore'],2/61)
            self.assertIsInstance(by_id[ident]['semanticRank'],int)
        self.assertEqual(by_id['one']['semanticSimilarity'],by_id['many']['semanticSimilarity'])

if __name__=='__main__':
    unittest.main()
