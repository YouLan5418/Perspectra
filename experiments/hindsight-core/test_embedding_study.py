import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import embedding_study as study
from test_episode_core import SCOPE
from test_projections import request


class EmbeddingStudyTest(unittest.TestCase):
    def test_auc_counts_ties_and_missing_classes(self):
        self.assertEqual(study.auc([3, 2], [2, 1]), .875)
        self.assertIsNone(study.auc([1], []))

    def test_cross_query_auc_does_not_claim_within_query_ranking(self):
        rows = [
            {"traceId": "a", "label": "useful", "cosine": .9, "lift": .2, "coverage": .1},
            {"traceId": "b", "label": "noise", "cosine": .8, "lift": .1, "coverage": .2},
        ]
        result = study.ranking_auc(rows)["cosine"]
        self.assertEqual(result["pooledAuc"], 1)
        self.assertIsNone(result["withinQueryMacroAuc"])
        self.assertEqual(result["mixedLabelQueries"], 0)

    def test_cleanup_preserves_negative_and_unknown_result_qualifiers(self):
        text = "沈南 尝试未成功：进入院子；结果未提供的行动记录：递茶给陌生人。"
        self.assertEqual(study.clean_text(text, ["沈南"]), "未成功：进入院子；结果未提供：递茶给陌生人。")
        self.assertIn("陌生人", study.clean_text(text, ["沈南"]))
        self.assertIn("沈南", text)

    def test_only_authorized_context_provides_aliases(self):
        req = copy.deepcopy(request())
        req["context"]["character"] = {"characterId": "character:friend", "name": "沈南"}
        req["context"]["scene"] = {"people": [{"characterId": "character:player", "name": "玩家"}]}
        req["secretOtherCharacter"] = {"characterId": "character:private", "name": "秘密角色"}
        self.assertEqual(set(study.aliases(req)), {"friend", "沈南", "player", "玩家"})

    def test_coverage_handles_one_character_topic(self):
        values = study.coverage_scores(["我喜欢热茶。", "外面下雨了。"], "茶")
        self.assertEqual(values, [1, 0])

    def test_rejects_invalid_vectors(self):
        for bad in [[[0, 0]], [[float("nan"), 1]], [1, 2]]:
            with self.assertRaises(ValueError):
                study.normalized(bad)
        np.testing.assert_allclose(study.normalized([[3, 4]]), [[.6, .8]])

    def test_model_name_is_safe_on_windows_and_owners_are_separate(self):
        encoder = study.Encoder("ollama", "qwen3-embedding:0.6b")
        encoder.add(SCOPE, "相同的文本")
        encoder.add({**SCOPE, "characterId": "character:other"}, "相同的文本")
        def http(path, data=None):
            if path == "/api/tags":
                return {"models": [{"name": encoder.model, "digest": "mock", "details": {}}]}
            if path == "/api/ps":
                return {"models": []}
            return {"embeddings": [[3, 4] for _ in data["input"]], "total_duration": 1000}
        with tempfile.TemporaryDirectory() as tmp, patch.object(encoder, "http", side_effect=http):
            encoder.fill(Path(tmp))
            directories = list((Path(tmp) / "qwen3-embedding-0.6b").iterdir())
            self.assertEqual(len(directories), 2)
            self.assertEqual(len(encoder.vectors), 2)

    def test_rejects_silently_shortened_api_batch(self):
        encoder = study.Encoder("ollama", "qwen3-embedding:0.6b")
        encoder.add(SCOPE, "一")
        encoder.add(SCOPE, "二")
        def http(path, data=None):
            if path == "/api/tags":
                return {"models": [{"name": encoder.model, "digest": "mock", "details": {}}]}
            return {"embeddings": [[1, 0]]}
        with tempfile.TemporaryDirectory() as tmp, patch.object(encoder, "http", side_effect=http):
            with self.assertRaisesRegex(ValueError, "batch count"):
                encoder.fill(Path(tmp))


if __name__ == "__main__":
    unittest.main()
