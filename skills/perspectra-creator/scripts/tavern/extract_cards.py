"""Extract Tavern card data without executing code or fetching resources (stdlib only)."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import struct
import sys
import zlib
from card_metrics import metrics, position, sizes, target_preflight

INPUT_LIMIT = 256 * 1024 * 1024
TEXT_LIMIT = 128 * 1024 * 1024
SIGNATURE = b'\x89PNG\r\n\x1a\n'
CARD_KEYS = {'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'}


class CardError(ValueError):
    pass


def b64(value: bytes) -> str:
    return base64.b64encode(value).decode('ascii')


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')


def parse_json(payload: bytes):
    if len(payload) > TEXT_LIMIT:
        raise CardError('Decoded JSON exceeds the text size limit')
    duplicates = []

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                duplicates.append(key)
            result[key] = value
        return result

    def invalid(value):
        raise CardError('Non-finite JSON number: ' + value)

    value = json.loads(payload.decode('utf-8-sig'), object_pairs_hook=pairs, parse_constant=invalid)
    if not isinstance(value, dict):
        raise CardError('Card JSON must be an object')
    return value, duplicates


def inflate(payload: bytes) -> bytes:
    decoder = zlib.decompressobj()
    result = decoder.decompress(payload, TEXT_LIMIT + 1)
    if len(result) > TEXT_LIMIT or decoder.unconsumed_tail:
        raise CardError('Compressed metadata exceeds the text size limit')
    if not decoder.eof or decoder.unused_data:
        raise CardError('Invalid compressed metadata stream')
    return result


def text_chunk(tag: bytes, payload: bytes):
    key, rest = payload.split(b'\0', 1)
    if not 1 <= len(key) <= 79:
        raise CardError('Invalid PNG text keyword length')
    if tag == b'zTXt':
        if not rest or rest[0] != 0:
            raise CardError('Unsupported zTXt compression method')
        raw = inflate(rest[1:])
    elif tag == b'iTXt':
        if len(rest) < 2 or rest[0] not in (0, 1) or rest[1] != 0:
            raise CardError('Invalid iTXt compression header')
        language, translated, raw = rest[2:].split(b'\0', 2)
        if rest[0]:
            raw = inflate(raw)
    else:
        raw = rest
    if len(raw) > TEXT_LIMIT:
        raise CardError('PNG text exceeds the text size limit')
    return key.decode('latin1'), raw


def decode_card(raw: bytes):
    errors = []
    for encoding in ('json', 'base64-json'):
        try:
            payload = raw if encoding == 'json' else base64.b64decode(raw, validate=True)
            card, duplicates = parse_json(payload)
            return payload, card, duplicates, encoding
        except (ValueError, UnicodeError) as error:
            errors.append(type(error).__name__)
    raise CardError('Character metadata is neither UTF-8 JSON nor base64 JSON: ' + ', '.join(errors))


def read_png(blob: bytes):
    if not blob.startswith(SIGNATURE):
        raise CardError('Invalid PNG signature')
    offset, chunks, payloads, warnings = 8, [], [], []
    ended = False
    while offset < len(blob):
        if len(blob) - offset < 12:
            raise CardError('Truncated PNG chunk header')
        length = struct.unpack('>I', blob[offset:offset + 4])[0]
        end = offset + length + 12
        if end > len(blob):
            raise CardError('PNG chunk extends beyond input')
        tag = blob[offset + 4:offset + 8]
        if not re.fullmatch(b'[A-Za-z]{4}', tag):
            raise CardError('Invalid PNG chunk type')
        payload = blob[offset + 8:end - 4]
        crc = struct.unpack('>I', blob[end - 4:end])[0]
        if zlib.crc32(tag + payload) & 0xffffffff != crc:
            raise CardError('PNG CRC mismatch at offset ' + str(offset))
        if not chunks and (tag != b'IHDR' or length != 13):
            raise CardError('PNG must begin with a 13-byte IHDR')
        if chunks and tag == b'IHDR':
            raise CardError('Repeated PNG IHDR')
        chunk = {'index': len(chunks), 'offset': offset, 'type': tag.decode('ascii'),
                 'length': length, 'crc_ok': True}
        if tag != b'IDAT':
            chunk['payload_base64'] = b64(payload)
        if tag in (b'tEXt', b'zTXt', b'iTXt'):
            keyword, raw = text_chunk(tag, payload)
            chunk['keyword'] = keyword
            if keyword in ('chara', 'ccv3'):
                decoded, card, duplicates, encoding = decode_card(raw)
                payloads.append({'source': f'/chunks/{len(chunks)}', 'keyword': keyword,
                                 'encoding': encoding, 'payload': decoded, 'card': card,
                                 'duplicate_keys': duplicates})
        chunks.append(chunk)
        offset = end
        if tag == b'IEND':
            if length:
                raise CardError('PNG IEND must be empty')
            ended = True
            break
    if not ended:
        raise CardError('PNG IEND missing')
    if not any(chunk['type'] == 'IDAT' for chunk in chunks):
        raise CardError('PNG IDAT missing')
    if offset != len(blob):
        warnings.append('PNG has trailing bytes; preserved without interpretation')
    if not payloads:
        raise CardError('No chara/ccv3 character payload found')
    return {'format': 'png', 'chunks': chunks, 'trailing_base64': b64(blob[offset:])}, payloads, warnings


def card_data(card: dict):
    warnings = []
    if 'spec' in card:
        data = card.get('data')
        if not isinstance(data, dict):
            raise CardError('A declared card must have an object data field')
        spec = card['spec']
        version = card.get('spec_version')
        expected = {'chara_card_v2': '2.0', 'chara_card_v3': '3.0'}
        if spec not in expected:
            warnings.append('Unknown declared spec; contents preserved, semantics not validated')
        elif version != expected[spec]:
            warnings.append('Unexpected spec_version; contents preserved')
        prefix = '/data'
    elif CARD_KEYS.intersection(card):
        data, spec, version, prefix = card, 'v1-flat', None, ''
    else:
        raise CardError('JSON is not a recognized flat or declared character card')
    return data, spec, version, prefix, warnings


def pointer(value) -> str:
    return str(value).replace('~', '~0').replace('/', '~1')


def walk(value, path=''):
    yield path, value
    if isinstance(value, dict):
        for key, child in value.items():
            yield from walk(child, path + '/' + pointer(key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, path + '/' + str(index))


def counts(entries, key, nested=False):
    result = {}
    for entry in entries:
        value = entry.get('extensions', {}) if nested else entry
        value = value if isinstance(value, dict) else {}
        label = json.dumps(value[key], ensure_ascii=False, sort_keys=True) if key in value else 'missing'
        result[label] = result.get(label, 0) + 1
    return result


def inspect_card(card: dict):
    data, spec, version, prefix, warnings = card_data(card)
    book = data.get('character_book', {})
    entries = book.get('entries', []) if isinstance(book, dict) else []
    if 'character_book' in data and not isinstance(book, dict):
        warnings.append('character_book is not an object; raw value retained')
    if not isinstance(entries, list):
        warnings.append('character_book.entries is not an array; raw value retained')
        entries = []
    valid = [entry for entry in entries if isinstance(entry, dict)]
    if len(valid) != len(entries):
        warnings.append('Some book entries are not objects; raw entries retained')
    index = []
    for number, entry in enumerate(entries):
        base = {'index': number, 'source': prefix + '/character_book/entries/' + str(number),
                'file': f'entries/{number:04d}.json'}
        if isinstance(entry, dict):
            base['configuration'] = {k: v for k, v in entry.items() if k != 'content'}
            text = entry.get('content')
            base['content_characters'] = len(text) if isinstance(text, str) else None
            base['contains_ejs'] = isinstance(text, str) and '<%' in text
            base['content_sizes'] = sizes(text)
            base['injection_position'] = position(entry)
        else:
            base['warning'] = 'non-object entry'
        index.append(base)
    extensions = data.get('extensions', {})
    extensions = extensions if isinstance(extensions, dict) else {}
    helper = extensions.get('tavern_helper', {})
    scripts = []
    for path, value in walk(helper, prefix + '/extensions/tavern_helper'):
        if isinstance(value, dict) and isinstance(value.get('content'), str):
            scripts.append({'source': path, 'name': value.get('name'), 'type': value.get('type'),
                            'enabled': value.get('enabled'), 'content_characters': len(value['content']),
                            'file': f'scripts/{len(scripts):04d}.json',
                            'text_file': f'scripts/{len(scripts):04d}.txt'})
    regexes = extensions.get('regex_scripts', [])
    regexes = regexes if isinstance(regexes, list) else []
    dependencies, macros = set(), set()
    for path, value in walk(card):
        if isinstance(value, str):
            dependencies.update(re.findall(r'https?://[^\s<>\x22\x27`\\)]+', value))
            macros.update(re.findall(r'\{\{([^{}\n]{1,256})\}\}', value))
    declared = ('name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
                'creator_notes', 'system_prompt', 'post_history_instructions', 'creator',
                'character_version', 'alternate_greetings', 'group_only_greetings', 'tags')
    fields = {key: {'present': key in data, 'value': data.get(key)} for key in declared
              if key in ('name', 'creator', 'character_version', 'creator_notes', 'tags')}
    lengths = {key: len(data[key]) for key in declared if isinstance(data.get(key), (str, list))}
    summary = {'format': spec, 'spec_version': version, 'schema_validated': False,
               'data_source': prefix or '/', 'fields': fields, 'field_lengths': lengths,
               'text_sizes': {key: sizes(value) for key, value in data.items() if isinstance(value, str)},
               'top_keys': list(card), 'data_keys': list(data), 'extension_keys': list(extensions),
               'book_config': {key: value for key, value in book.items() if key != 'entries'}
               if isinstance(book, dict) else None,
               'entries': len(entries), 'enabled_true': sum(e.get('enabled') is True for e in valid),
               'enabled_constant_true': sum(e.get('enabled') is True and e.get('constant') is True for e in valid),
               'ejs_entries': sum(isinstance(e.get('content'), str) and '<%' in e['content'] for e in valid),
               'entry_configuration': {key: counts(valid, key) for key in
                                       ('enabled', 'constant', 'selective', 'use_regex', 'position')},
               'entry_extensions': {key: counts(valid, key, True) for key in
                                    ('position', 'depth', 'role', 'scan_depth', 'probability', 'useProbability',
                                     'selectiveLogic', 'exclude_recursion', 'prevent_recursion',
                                     'delay_until_recursion', 'sticky', 'cooldown', 'delay', 'ignore_budget', 'group')},
               'regexes': [{'source': prefix + '/extensions/regex_scripts/' + str(i),
                           'file': f'regex/{i:04d}.json',
                           'configuration': {k: v for k, v in r.items() if k != 'replaceString'},
                           'replacement_characters': len(r.get('replaceString', ''))
                           if isinstance(r.get('replaceString', ''), str) else None}
                          for i, r in enumerate(regexes) if isinstance(r, dict)],
               'scripts': scripts, 'url_candidates': sorted(dependencies)[:128],
               'url_count': len(dependencies), 'urls_truncated': len(dependencies) > 128,
               'macro_candidates': sorted(macros)[:64], 'macro_count': len(macros),
               'warnings': warnings}
    return summary, index, entries


def extract_file(source: Path, target: Path, project_root: Path | None = None):
    if source.stat().st_size > INPUT_LIMIT:
        raise CardError('Input exceeds the file size limit')
    blob = source.read_bytes()
    target.mkdir()
    if source.suffix.lower() == '.png':
        container, payloads, warnings = read_png(blob)
    elif source.suffix.lower() == '.json':
        card, duplicates = parse_json(blob)
        container, warnings = {'format': 'json'}, []
        payloads = [{'source': '/', 'keyword': None, 'encoding': 'json', 'payload': blob,
                     'card': card, 'duplicate_keys': duplicates}]
    else:
        raise CardError('Unsupported input format: ' + source.suffix)
    container.update(source=str(source.resolve()), sha256=hashlib.sha256(blob).hexdigest(),
                     bytes=len(blob), payloads=[])
    variants, variant_keys = [], []
    for number, item in enumerate(payloads):
        raw_path = f'payload-{number:03d}.json'
        (target/raw_path).write_bytes(item['payload'])
        # Raw bytes for every source survive even when their semantic objects are identical.
        canonical = json.dumps(item['card'], sort_keys=True, ensure_ascii=False, allow_nan=False)
        variant = next((i for i, old in enumerate(variant_keys) if old == canonical), None)
        if variant is None:
            variant = len(variants)
            variants.append(item)
            variant_keys.append(canonical)
        container['payloads'].append({k: item[k] for k in ('source', 'keyword', 'encoding', 'duplicate_keys')}
                                     | {'raw_file': raw_path, 'variant': variant})
    write_json(target/'container.json', container)
    summaries = []
    for number, item in enumerate(variants):
        folder = target/'variants'/f'{number:03d}'
        folder.mkdir(parents=True)
        summary, index, entries = inspect_card(item['card'])
        if any(source['duplicate_keys'] for source in container['payloads'] if source['variant'] == number):
            summary['warnings'].append('Duplicate JSON keys; card.json uses the last value, consult raw payloads')
        (folder/'payload.json').write_bytes(item['payload'])
        write_json(folder/'card.json', item['card'])
        write_json(folder/'entry-index.json', index)
        capacity = metrics(entries)
        write_json(folder/'capacity.json', capacity)
        if project_root is not None:
            write_json(folder/'target-preflight.json', target_preflight(project_root, capacity))
        values = dict(walk(item['card']))
        for script in summary['scripts']:
            (folder/'scripts').mkdir(exist_ok=True)
            value = values[script['source']]
            write_json(folder/script['file'], value)
            (folder/script['text_file']).write_text(value['content'], encoding='utf-8')
        for regex in summary['regexes']:
            (folder/'regex').mkdir(exist_ok=True)
            write_json(folder/regex['file'], values[regex['source']])
        (folder/'entries').mkdir()
        for i, entry in enumerate(entries):
            write_json(folder/'entries'/f'{i:04d}.json', entry)
        write_json(folder/'summary.json', summary)
        summaries.append({'variant': number, 'summary': f'variants/{number:03d}/summary.json',
                          'format': summary['format'], 'entries': summary['entries'],
                          'warnings': summary['warnings']})
    result = {'status': 'needs_review' if len(variants) > 1 else 'extracted',
              'variants': summaries, 'warnings': warnings}
    write_json(target/'summary.json', result)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--project-root', type=Path, help='Read target source constants for advisory preflight; no code execution')
    args = parser.parse_args(argv)
    source, output = args.input.resolve(), args.out.resolve()
    if output.exists():
        parser.error('Output already exists; choose a new directory')
    if source.is_dir():
        files = sorted(p for p in source.iterdir() if p.is_file() and p.suffix.lower() in ('.png', '.json'))
    elif source.is_file():
        files = [source]
    else:
        parser.error('Input does not exist')
    if not files:
        parser.error('No PNG/JSON files in the input directory')
    output.mkdir(parents=True)
    manifest = []
    for number, file in enumerate(files):
        record = {'source': str(file)}
        try:
            if file.stat().st_size > INPUT_LIMIT:
                raise CardError('Input exceeds the file size limit')
            digest = hashlib.sha256(file.read_bytes()).hexdigest()
            name = f'{number + 1:03d}-{digest[:12]}'
            record.update(sha256=digest, output=name)
            record.update(extract_file(file, output/name, args.project_root))
        except (ValueError, OSError, UnicodeError, zlib.error, RecursionError) as error:
            record.update(status='error', error=str(error))
        manifest.append(record)
    write_json(output/'manifest.json', manifest)
    print(json.dumps({'output': str(output), 'inputs': len(files),
                      'extracted': sum(r['status'] == 'extracted' for r in manifest),
                      'needs_review': sum(r['status'] == 'needs_review' for r in manifest),
                      'errors': sum(r['status'] == 'error' for r in manifest)}, ensure_ascii=True))
    return int(any(record['status'] == 'error' for record in manifest))


if __name__ == '__main__':
    sys.exit(main())
