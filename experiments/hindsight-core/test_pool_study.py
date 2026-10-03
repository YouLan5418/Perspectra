import copy
import json
import unittest
import numpy as np
import core
import projections
import retrieval_text as rt
import pool_study as pool
import pool_evaluate as evaluate
from pool_review import page
from test_episode_core import SCOPE,source,retain
from test_projections import request


class RetrievalTextTest(unittest.TestCase):
    def history(self,seq=1,owner=None,name="林晓"):
        return {"scope":owner or SCOPE,"worldSeq":seq,
                "people":[{"characterId":"character:companion","name":name}]}

    def test_offscene_name_cleaned_from_authorized_prefix_only(self):
        data=retain([source(4,"character:companion said: 林晓说自己没泡茶。")])
        before=copy.deepcopy(data)
        view=projections.retrieval_projection(data,len,alias_history=[self.history()])
        self.assertNotIn("林晓",view["facts"][0]["retrievalText"])
        self.assertIn("林晓",view["facts"][0]["text"])
        self.assertIn("没泡茶",view["facts"][0]["retrievalText"])
        self.assertEqual(data,before)
        self.assertEqual(view["facts"][0]["sourceRefs"],before["facts"][0]["sourceRefs"])
        self.assertNotIn("林晓",rt.query_text("林晓，我想喝茶。",view))

    def test_future_and_unwitnessed_aliases_do_not_clean(self):
        doc={"scope":SCOPE,"sources":[source(4,"character:companion said: 来喝茶。")]}
        table=rt.alias_table(doc,[self.history(SCOPE["asOfWorldSeq"]+1)])
        self.assertIn("林晓",rt.clean("林晓说没有茶",table))
        self.assertEqual(rt.alias_table(doc,[{"scope":SCOPE,"worldSeq":1,"people":[{"characterId":"character:private","name":"秘密人"}]}])["people"],[])

    def test_foreign_alias_history_is_rejected(self):
        data=retain([source(4,"character:player said: 茶。")])
        with self.assertRaisesRegex(ValueError,"crosses"):
            rt.alias_table(data,[self.history(owner={**SCOPE,"characterId":"character:other"})])

    def test_ids_and_templates_do_not_erase_failure_or_unknown_result(self):
        table={"people":[],"characterIds":["character:player"]}
        self.assertEqual(rt.clean("尝试未成功：character:player，进院子。",table),"未成功： ，进院子。")
        self.assertIn("结果未提供",rt.clean("结果未提供的行动记录：player递茶",table))
        self.assertIn("character:player2",rt.clean("character:player2",table))
        self.assertEqual(rt.clean("、 、 ，拿行李。",table),"拿行李。")


class PoolTest(unittest.TestCase):
    def test_collapse_before_arm_cap_and_rrf(self):
        views=[{"memoryId":"a","id":"x"},{"memoryId":"a","id":"y"},{"memoryId":"b","id":"z"}]
        ranking=pool.collapse(views,[.1,.9,.8])
        self.assertEqual([r["memoryId"] for r in ranking],["a","b"])
        self.assertEqual(ranking[0]["viewId"],"y")
        self.assertEqual(pool.rrf(ranking,ranking)[0]["score"],2/61)

    def test_blind_page_has_only_given_payload_and_safe_embedding(self):
        payload={"datasetId":"id","queries":[{"id":"opaque","context":{"name":"</script>"},"candidates":[]}]}
        html=page(payload)
        self.assertNotIn("</script>\"",html)
        self.assertIn("\\u003c/script",html)
        self.assertNotIn("private-pool.json",html)
        self.assertNotIn("qwen-clean",html)

    def fixture(self):
        candidates={"c1":{"memoryId":"m1"},"c2":{"memoryId":"m2"}}
        rankings={name:[{"memoryId":"m1","score":.6},{"memoryId":"m2","score":.4}] for name in pool.SYSTEMS}
        private={"datasetId":"test","topK":2,"systems":pool.SYSTEMS,
                 "queries":{"q1":{"candidates":candidates,"rankings":rankings}}}
        labels={"datasetId":"test","reviewer":"human","queries":{"q1":{"need":"some","labels":{"c1":"useful","c2":"irrelevant"}}}}
        return private,labels

    def test_evaluation_uses_query_labels_and_pool_recall(self):
        private,labels=self.fixture()
        result=evaluate.evaluate(private,labels)
        system=result["systems"]["qwen-clean"]
        self.assertEqual(system["precision"]["mean"],.5)
        self.assertEqual(system["poolRecall"]["mean"],1)
        self.assertEqual(system["withinQueryAuc"]["mean"],1)
        self.assertFalse(result["thresholdSelected"])
        self.assertFalse(result["holdoutEvaluated"])

    def test_missing_uncertain_and_partial_are_never_negatives(self):
        private,labels=self.fixture()
        for need in ["missing","uncertain"]:
            labels["queries"]["q1"]["need"]=need
            self.assertEqual(evaluate.validate(private,labels),{})
        labels["queries"]["q1"]["need"]="some"
        labels["queries"]["q1"]["labels"].pop("c2")
        self.assertEqual(evaluate.validate(private,labels),{})

    def test_rejects_conflicting_foreign_or_model_labels(self):
        private,labels=self.fixture()
        labels["queries"]["q1"]["need"]="none"
        with self.assertRaisesRegex(ValueError,"conflicts"):
            evaluate.validate(private,labels)
        labels["reviewer"]="model"
        with self.assertRaisesRegex(ValueError,"human"):
            evaluate.validate(private,labels)

    def test_unjudged_topk_is_not_counted_as_irrelevant(self):
        with self.assertRaisesRegex(ValueError,"unjudged"):
            evaluate.metrics([{"memoryId":"unknown"}],{"c1":{"memoryId":"m1"}},{"c1":"useful"},1)

    def test_same_stimulus_queries_are_resampled_as_one_block(self):
        result=evaluate.interval([0,1],100,clusters=["same","same"])
        self.assertEqual(result["nClusters"],1)
        self.assertEqual(result["interval95"],[.5,.5])

    def test_bootstrap_samples_query_values_deterministically(self):
        self.assertEqual(evaluate.interval([0,1],100),evaluate.interval([0,1],100))
        self.assertIsNone(evaluate.interval([])["mean"])


if __name__=="__main__":
    unittest.main()
