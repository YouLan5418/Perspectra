import unittest
from unittest.mock import patch
import queries
class QueryTest(unittest.TestCase):
    def context(self,stimulus):
        return {'context':{'character':{'characterId':'character:npc','name':'某人'},
           'scene':{'locationId':'location:room','people':[{'characterId':'character:player','name':'旅人'}]},
           'stimulus':stimulus,'observations':[{'value':{'content':{'speech':{'text':'过去的私密判断'}}}}],
           'selfObservations':[]}}
    def test_recent_judgments_and_duplicate_narration_do_not_pollute_query(self):
        item={'content':{'actorId':'character:player','speech':{'text':'如果下雨，我就不去。','narration':'他微笑着点头。'}}}
        q=queries.project(self.context([item,item]))
        self.assertEqual(q['semanticQuery'],'如果下雨，我就不去。')
        self.assertNotIn('私密',q['semanticQuery']);self.assertNotIn('点头',q['keywordText'])
        self.assertEqual(q['recentObservationsUsed'],0)
    def test_rejected_movement_is_not_an_accomplished_move(self):
        q=queries.project(self.context([{'content':{'actorId':'character:player','status':'rejected',
           'movement':{'fromLocationId':'location:room','toLocationId':'location:garden'}}}]))
        self.assertIn('未成功',q['semanticQuery'])
        self.assertNotIn('fromLocationId',q['semanticQuery'])
        self.assertIn('location:garden',[e['id'] for e in q['entitySeeds']])
    def test_empty_stimulus_skips_without_model_or_recent_fallback(self):
        with patch.object(queries,'tokenizer',side_effect=AssertionError('no tokenizer needed')):
            q=queries.project(self.context([]))
        self.assertEqual(q['mode'],'skip');self.assertEqual(q['keywordTerms'],[])
    def test_explicit_query_is_bounded_with_the_matching_prefix(self):
        request=self.context([]);request['recallEvidence']={'query':'我没有答应去喝茶。'*300+'最后的秘密'}
        q=queries.project(request)
        self.assertLessEqual(q['tokenCount'],256);self.assertTrue(q['truncated'])
        self.assertNotIn('秘密',q['keywordText'])
    def test_term_frequency_is_retained_and_fields_are_separate(self):
        self.assertEqual(queries.lexical_terms('泡茶，泡茶').count('泡茶'),2)
        self.assertNotIn('茶泡',queries.lexical_terms('泡茶，泡茶'))
if __name__=='__main__':unittest.main()
