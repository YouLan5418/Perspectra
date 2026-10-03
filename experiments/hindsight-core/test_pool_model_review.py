import unittest
import pool_model_review as review
import pool_evaluate as evaluation
class ModelReviewTest(unittest.TestCase):
    def query(self):return {"id":"q","context":{},"candidates":[{"id":"c","segments":["evidence"]}]}
    def answer(self):return {"need":"none","note":"no value","labels":{"c":"background"},"reasons":{"c":"already visible"}}
    def test_answer_coverage_and_need_conflict(self):
        q=self.query();a=self.answer();self.assertEqual(review.validate_answer(q,a),a)
        a["labels"]["foreign"]="useful"
        with self.assertRaises(ValueError):review.validate_answer(q,a)
        a=self.answer();a["need"]="some"
        with self.assertRaisesRegex(ValueError,"conflicts"):review.validate_answer(q,a)
    def test_missing_and_uncertain_are_not_rewritten(self):
        for need in ("missing","uncertain"):
            a=self.answer();a["need"]=need;self.assertEqual(review.validate_answer(self.query(),a)["need"],need)
    def test_disagreements_preserved(self):
        left={"queries":{"q":self.answer()}};right={"queries":{"q":{**self.answer(),"labels":{"c":"useful"},"need":"some"}}}
        r=review.agreement({"queries":[self.query()]},left,right)
        self.assertEqual(r["exactAgreement"],0);self.assertEqual(r["disagreements"][0]["left"],"background");self.assertEqual(r["disagreements"][0]["right"],"useful")
    def test_model_mode_must_be_explicit(self):
        private={"datasetId":"d","queries":{"q":{"candidates":{"c":{}}}}}
        labels={"datasetId":"d","reviewer":"model","queries":{"q":self.answer()}}
        with self.assertRaisesRegex(ValueError,"human"):evaluation.validate(private,labels)
        self.assertIn("q",evaluation.validate(private,labels,reviewer="model"))
    def test_fenced_json(self):
        content=chr(96)*3+"json\n"+'{"ok":true}'+"\n"+chr(96)*3
        self.assertEqual(review.parse_content({"choices":[{"message":{"content":content}}]}),{"ok":True})
if __name__=="__main__":unittest.main()
