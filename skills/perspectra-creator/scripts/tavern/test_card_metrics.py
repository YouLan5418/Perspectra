"""Regression tests for actionable extraction evidence, without running card code."""
import json
from pathlib import Path
import tempfile
import unittest

from card_metrics import metrics, position, sizes, target_preflight
from extract_cards import extract_file


class MetricsTest(unittest.TestCase):
    def test_units(self):
        self.assertEqual(sizes('中😀'), {'codepoints': 2, 'utf16_units': 3, 'utf8_bytes': 7})

    def test_unknown_disabled_and_ejs_are_separate(self):
        result = metrics([{'enabled': True, 'constant': True, 'content': '<% x %>', 'secondary_keys': ['s']},
                          {'enabled': False, 'constant': True, 'content': 'a' * 100},
                          {'content': 'unknown'}])
        self.assertEqual(result['counts']['enabled_constant'], 1)
        self.assertEqual(result['counts']['disabled'], 1)
        self.assertEqual(result['counts']['enabled_unknown'], 1)
        self.assertEqual(result['counts']['enabled_secondary_keys'], 1)
        self.assertEqual(result['raw_enabled_constant_total']['codepoints'], 7)

    def test_depth_extension_precedence(self):
        value = position({'position': 'before_char', 'extensions': {'position': 4, 'depth': 999}})
        self.assertEqual(value['effective'], 'at_depth')
        self.assertEqual(value['depth'], 999)
        self.assertEqual(position({'position': 'after_char'})['effective'], 'after_char')
        self.assertEqual(position({})['effective'], 'unknown')

    def test_full_script_regex_and_source_export(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            script = {'content': 'throw new Error("must not run")', 'name': '../unsafe', 'unknown': 123}
            regex = {'findRegex': '(x)', 'replaceString': 'FULL replacement', 'unknown': [1]}
            card = {'name': 'test', 'extensions': {'tavern_helper': {'folders': [{'scripts': [script]}]},
                                                 'regex_scripts': [regex]}}
            (root/'card.json').write_text(json.dumps(card), encoding='utf-8')
            extract_file(root/'card.json', root/'out')
            variant = root/'out/variants/000'
            self.assertEqual(json.loads((variant/'scripts/0000.json').read_text()), script)
            self.assertEqual((variant/'scripts/0000.txt').read_text(), script['content'])
            self.assertEqual(json.loads((variant/'regex/0000.json').read_text()), regex)
            summary = json.loads((variant/'summary.json').read_text())
            self.assertEqual(summary['scripts'][0]['source'], '/extensions/tavern_helper/folders/0/scripts/0')

    def test_preflight_refresh_and_unresolved(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root/'desktop/host/pack-knowledge.ts'
            source.parent.mkdir(parents=True)
            source.write_text('const MAX_CHARACTERS = 2 * 2\n', encoding='utf-8')
            card = metrics([{'enabled': False, 'content': '12345'}])
            report = target_preflight(root, card)
            self.assertEqual(report['limits']['knowledge_context_utf16_units'], 4)
            self.assertFalse(report['raw_entry_risks'][0]['enabled'])
            self.assertTrue(report['unresolved'])
            old_hash = report['evidence'][0]['sha256']
            source.write_text('const MAX_CHARACTERS = runtimeValue\n', encoding='utf-8')
            updated = target_preflight(root, card)
            self.assertNotIn('knowledge_context_utf16_units', updated['limits'])
            self.assertTrue(old_hash)


if __name__ == '__main__':
    unittest.main()
