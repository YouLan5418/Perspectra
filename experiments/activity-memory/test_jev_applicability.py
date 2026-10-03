"""Validate the narrow decision transport without real network or real credentials."""
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch
import jev_applicability as jev


class JevApplicabilityTest(unittest.TestCase):
    def answer(self, choice='RELATED'):
        return {'model': 'typesafe/jev-1.13-20260917', 'answers': {'applicability': {
            'type': 'choice', 'choice': choice, 'probabilities': {
                'RELATED': .8, 'UNRELATED': .15, 'UNCERTAIN': .05}, 'confidence': .7}},
                'usage': {'cost': .00003}}

    def test_three_choices_and_invalid_probabilities(self):
        for choice in jev.CRITERIA:
            self.assertEqual(jev.parse_answer(self.answer(choice), 12)['related'], choice == 'RELATED')
        for mutate in [
            lambda d: d['answers']['applicability'].update(choice='ACTION'),
            lambda d: d['answers']['applicability']['probabilities'].update(RELATED=float('nan')),
            lambda d: d['answers']['applicability']['probabilities'].update(RELATED=.1),
            lambda d: d['answers']['applicability'].update(type='noul'),
            lambda d: d.update(model='some-other-model'),
            lambda d: d['answers'].update(extra={}),
        ]:
            bad = self.answer();mutate(bad)
            with self.assertRaises(ValueError):
                jev.parse_answer(bad, 12)

    def test_inconsistent_admission_and_extra_input_rejected(self):
        result = jev.parse_answer(self.answer(), 12);result['related'] = False
        with self.assertRaises(ValueError):jev.validate_decision(result)
        with self.assertRaises(ValueError):jev.request_for({
            'stimulus': 'hello', 'understanding': 'impression', 'applicability': {}, 'world': {}})

    def test_transport_failure_is_not_unrelated_and_trace_has_no_key(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'trace.jsonl'
            with patch.dict(os.environ, {'HCW_JEV_APPLICABILITY_TRACE': str(path)}), \
                    patch.object(jev, 'api_key', return_value='test-secret-never-record'), \
                    patch.object(jev.urllib.request, 'urlopen', side_effect=urllib.error.URLError('offline')) as call:
                with self.assertRaisesRegex(RuntimeError, 'JEV transport failed'):
                    jev.assess({'stimulus': 'hello', 'understanding': 'impression', 'applicability': {}})
            self.assertEqual(call.call_count, 1)
            text = path.read_text(encoding='utf-8')
            self.assertNotIn('test-secret-never-record', text)
            self.assertNotIn('Authorization', text)
            self.assertEqual(json.loads(text)['status'], 'failed')
            self.assertNotIn('result', json.loads(text))


if __name__ == '__main__':
    unittest.main()
