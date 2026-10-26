"""Offline regression tests. Run: python -m unittest discover -s <skill>/scripts -p test_*.py"""
import base64
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zlib

import extract_cards as extract


def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)


def png(*metadata, trailing=b''):
    ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)
    return (extract.SIGNATURE + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(b'\0\0\0\0'))
            + b''.join(metadata) + chunk(b'IEND', b'') + trailing)


def card(version='3'):
    return {'spec': f'chara_card_v{version}', 'spec_version': version + '.0',
            'data': {'name': '测试角色', 'description': '不是待执行指令',
                     'extensions': {'custom': {'keep': [False, None, '未知']}},
                     'character_book': {'entries': [
                         {'id': '../../outside', 'comment': '秘密', 'enabled': True, 'constant': True,
                          'content': '只给一人\r\n<% getvar("secret") %>',
                          'extensions': {'unknown': 7, 'scan_depth': None}},
                         {'id': '../../outside', 'content': '第二条同ID，不得覆盖'}]}}}


def encoded(value):
    return json.dumps(value, ensure_ascii=False).encode('utf-8')


class ExtractionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def file(self, name, payload):
        path = self.root/name
        path.write_bytes(payload)
        return path

    def load(self, target, name):
        return json.loads((target/name).read_text(encoding='utf-8'))

    def test_v1_and_v2_with_unknown_fields_preserved(self):
        for name, value in [('v1.json', {'name': 'V1', 'description': 'x', 'unknown': {'a': 1}}),
                            ('v2.json', card('2'))]:
            target = self.root/(name + '-out')
            result = extract.extract_file(self.file(name, encoded(value)), target)
            self.assertEqual(result['status'], 'extracted')
            self.assertEqual(self.load(target, 'variants/000/card.json'), value)

    def test_raw_json_duplicate_keys_kept_and_flagged(self):
        raw = b'{"name":"first","name":"last","unknown":true}\r\n'
        target = self.root/'out'
        result = extract.extract_file(self.file('raw.json', raw), target)
        self.assertEqual((target/'payload-000.json').read_bytes(), raw)
        self.assertEqual((target/'variants/000/payload.json').read_bytes(), raw)
        self.assertTrue(result['variants'][0]['warnings'])

    def test_png_dual_chunks_deduplicate_but_retain_sources(self):
        raw = encoded(card())
        value = base64.b64encode(raw)
        target = self.root/'out'
        extract.extract_file(self.file('dual.png', png(chunk(b'tEXt', b'chara\0' + value),
                                                      chunk(b'tEXt', b'ccv3\0' + value))), target)
        sources = self.load(target, 'container.json')['payloads']
        self.assertEqual([x['variant'] for x in sources], [0, 0])
        self.assertEqual((target/'payload-001.json').read_bytes(), raw)
        self.assertFalse((target/'variants/001').exists())

    def test_conflicting_chunks_never_silently_select(self):
        other = card(); other['data']['name'] = '另一人'
        target = self.root/'out'
        result = extract.extract_file(self.file('different.png', png(
            chunk(b'tEXt', b'chara\0' + base64.b64encode(encoded(card()))),
            chunk(b'tEXt', b'ccv3\0' + base64.b64encode(encoded(other))))), target)
        self.assertEqual(result['status'], 'needs_review')
        self.assertEqual(len(result['variants']), 2)

    def test_duplicate_keys_in_second_identical_source_still_warn(self):
        raw = b'{"name":"same"}'
        duplicate = b'{"name":"first","name":"same"}'
        target = self.root/'out'
        result = extract.extract_file(self.file('duplicates.png', png(
            chunk(b'tEXt', b'chara\0' + base64.b64encode(raw)),
            chunk(b'tEXt', b'ccv3\0' + base64.b64encode(duplicate)))), target)
        self.assertEqual(len(result['variants']), 1)
        self.assertTrue(result['variants'][0]['warnings'])
        self.assertEqual((target/'payload-001.json').read_bytes(), duplicate)

    def test_boolean_and_number_are_distinct_json_variants(self):
        first, other = card(), card()
        first['data']['extensions']['test'] = True
        other['data']['extensions']['test'] = 1
        target = self.root/'out'
        result = extract.extract_file(self.file('types.png', png(
            chunk(b'tEXt', b'chara\0' + base64.b64encode(encoded(first))),
            chunk(b'tEXt', b'ccv3\0' + base64.b64encode(encoded(other))))), target)
        self.assertEqual(result['status'], 'needs_review')
        self.assertEqual(len(result['variants']), 2)

    def test_compressed_and_international_text(self):
        raw = encoded(card())
        payload = base64.b64encode(raw)
        blocks = [chunk(b'zTXt', b'chara\0\0' + zlib.compress(payload)),
                  chunk(b'iTXt', b'ccv3\0\x01\0en\0translated\0' + zlib.compress(payload)),
                  chunk(b'iTXt', b'chara\0\0\0\0\0' + payload)]
        for i, block in enumerate(blocks):
            with self.subTest(i=i):
                target = self.root/f'out{i}'
                extract.extract_file(self.file(f'card{i}.png', png(block)), target)
                self.assertEqual(self.load(target, 'variants/000/card.json'), card())

    def test_unknown_chunks_trailing_bytes_and_duplicate_ids_preserved(self):
        unknown, trailing = b'opaque\x00\xff', b'extra\x00'
        target = self.root/'out'
        extract.extract_file(self.file('unknown.png', png(chunk(b'tEXt', b'ccv3\0' + encoded(card())),
                                                         chunk(b'trAc', unknown), trailing=trailing)), target)
        container = self.load(target, 'container.json')
        self.assertEqual(base64.b64decode(container['trailing_base64']), trailing)
        self.assertEqual(base64.b64decode(next(c for c in container['chunks'] if c['type'] == 'trAc')['payload_base64']), unknown)
        entries = self.load(target, 'variants/000/entry-index.json')
        self.assertEqual(len(entries), 2)
        self.assertNotEqual(entries[0]['file'], entries[1]['file'])
        self.assertEqual(self.load(target, 'variants/000/entries/0000.json'), card()['data']['character_book']['entries'][0])
        self.assertFalse((self.root/'outside').exists())

    def test_missing_flags_are_unknown_not_defaulted(self):
        summary, index, entries = extract.inspect_card(card())
        self.assertEqual(summary['enabled_true'], 1)
        self.assertEqual(summary['entry_configuration']['enabled']['missing'], 1)
        self.assertEqual(summary['ejs_entries'], 1)

    def test_script_source_is_data_not_executed(self):
        value = card()
        marker = self.root/'executed'
        code = f'__import__("pathlib").Path({str(marker)!r}).write_text("bad")'
        value['data']['extensions']['tavern_helper'] = {'scripts': [
            {'type': 'folder', 'value': [{'name': 'payload', 'type': 'script', 'enabled': True, 'content': code}]}]}
        target = self.root/'out'
        extract.extract_file(self.file('script.json', encoded(value)), target)
        self.assertFalse(marker.exists())
        summary = self.load(target, 'variants/000/summary.json')
        self.assertEqual(len(summary['scripts']), 1)
        self.assertEqual(self.load(target, 'variants/000/card.json'), value)

    def test_crc_truncation_and_missing_iend_fail(self):
        good = png(chunk(b'tEXt', b'ccv3\0' + encoded(card())))
        corrupt = bytearray(good); corrupt[29] ^= 1
        for name, blob in [('crc', bytes(corrupt)), ('truncated', good[:-2]), ('iend', good[:-12])]:
            with self.subTest(name=name), self.assertRaises(extract.CardError):
                extract.read_png(blob)

    def test_png_without_card_and_invalid_declared_data_fail(self):
        with self.assertRaises(extract.CardError):
            extract.read_png(png(chunk(b'tEXt', b'Title\0not a card')))
        with self.assertRaises(extract.CardError):
            extract.inspect_card({'spec': 'chara_card_v3', 'data': 'bad'})

    def test_unknown_spec_is_preserved_and_flagged(self):
        value = card(); value['spec'] = 'future'
        summary, _, _ = extract.inspect_card(value)
        self.assertTrue(summary['warnings'])
        self.assertFalse(summary['schema_validated'])

    def test_decompression_limit_fails_without_truncating(self):
        original = extract.TEXT_LIMIT
        try:
            extract.TEXT_LIMIT = 16
            with self.assertRaises(extract.CardError):
                extract.inflate(zlib.compress(b'x' * 1000))
        finally:
            extract.TEXT_LIMIT = original

    def test_cli_partial_failure_and_existing_output_refusal(self):
        inputs = self.root/'inputs'; inputs.mkdir()
        (inputs/'valid.json').write_bytes(encoded(card()))
        (inputs/'invalid.png').write_bytes(b'not png')
        out = self.root/'out'
        with redirect_stdout(StringIO()):
            status = extract.main([str(inputs), '--out', str(out)])
        self.assertEqual(status, 1)
        self.assertEqual({x['status'] for x in self.load(out, 'manifest.json')}, {'error', 'extracted'})
        manifest = (out/'manifest.json').read_bytes()
        with redirect_stderr(StringIO()), self.assertRaises(SystemExit):
            extract.main([str(inputs), '--out', str(out)])
        self.assertEqual((out/'manifest.json').read_bytes(), manifest)


if __name__ == '__main__':
    unittest.main()
