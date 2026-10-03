import unittest
import copy
import recall_diagnostics as diagnostic
import projections
from test_episode_core import source, retain


class DiagnosticsTest(unittest.TestCase):
    def test_boundary_does_not_count_duplicate_renderings_as_independent_misses(self):
        data = retain([source(4, 'character:player said: 记得院子之约。; original player input (interpretation evidence, not an adjudicated outcome): 记得院子之约。'),
                       source(8, 'character:player said: 无关旧话。')])
        views = projections.retrieval_projection(data)
        units = [v for key in ('facts', 'episodes', 'observations') for v in views[key]]
        rows = [{'id': u['id'], 'memoryId': u['memoryId'], 'accepted': False,
                 'semanticSimilarity': .9, 'semanticLift': .29 if u['sourceRefs'][0]['worldSeq'] == 4 else .1,
                 'keywordCoverage': 0.0} for u in units]
        record = {'tick': 10, 'queryProjection': {'mode': 'search'}, 'projectedRecall': {
            'rawScores': rows, 'thresholds': {'semanticMin': .3, 'semanticLiftMin': .3, 'keywordCoverageMin': .15}}}
        candidates = diagnostic.boundary_candidates(record, data)
        self.assertEqual(len(candidates), 2)
        self.assertEqual(candidates[0]['sourceRefs'][0]['worldSeq'], 4)
        self.assertAlmostEqual(candidates[0]['sourceAgeTicks'], 6)
        # A window of an admitted memory is not a wholly rejected memory.
        rows[0]['accepted'] = True
        self.assertNotIn(rows[0]['memoryId'], [r['memoryId'] for r in diagnostic.boundary_candidates(record, data)])

    def test_semantic_noise_can_pass_while_keyword_branch_does_not(self):
        value = {'semanticSimilarity': .916, 'semanticLift': .337, 'keywordCoverage': .062}
        self.assertEqual(diagnostic.gate_path(value, {'semanticMin': .3, 'semanticLiftMin': .3, 'keywordCoverageMin': .15}),
                         {'semantic': True, 'keyword': False})

    def test_audit_rejects_foreign_citations_and_rewritten_claims(self):
        packet = {'observation': '他说泡了茶。', 'atoms': [{'id': 'allowed'}]}
        answer = {'status': 'supported', 'claims': [{'text': '他说泡了茶', 'status': 'supported',
                  'atomIds': ['allowed'], 'reason': '原句'}]}
        diagnostic.validate_audit(answer, packet)
        wrong = copy.deepcopy(answer);wrong['claims'][0]['atomIds'] = ['other-character']
        with self.assertRaisesRegex(ValueError, 'foreign'):
            diagnostic.validate_audit(wrong, packet)
        wrong = copy.deepcopy(answer);wrong['claims'][0]['text'] = '他泡了茶'
        with self.assertRaisesRegex(ValueError, 'exact'):
            diagnostic.validate_audit(wrong, packet)


if __name__ == '__main__':
    unittest.main()
