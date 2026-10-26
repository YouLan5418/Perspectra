"""Static card statistics and optional, source-derived target preflight; never eval code."""
import hashlib
import re


def sizes(text):
    if not isinstance(text, str):
        return None
    return {'codepoints': len(text), 'utf16_units': len(text.encode('utf-16-le', errors='surrogatepass')) // 2,
            'utf8_bytes': len(text.encode('utf-8', errors='surrogatepass'))}


def position(entry):
    ext = entry.get('extensions', {})
    ext = ext if isinstance(ext, dict) else {}
    raw = ext.get('position')
    # SillyTavern extension positions: before/after AN and atDepth are separate placements.
    names = {0: 'before_char', 1: 'after_char', 2: 'before_author_note',
             3: 'after_author_note', 4: 'at_depth', 5: 'example_top',
             6: 'example_bottom', 7: 'outlet'}
    effective = names.get(raw) if isinstance(raw, int) and not isinstance(raw, bool) else None
    if effective is not None:
        origin = 'extensions.position'
    elif raw is None and entry.get('position') in ('before_char', 'after_char'):
        effective, origin = entry['position'], 'position (fallback)'
    else:
        effective, origin = 'unknown', 'unresolved'
    return {'effective': effective, 'origin': origin, 'top_level': entry.get('position'),
            'extension': raw, 'depth': ext.get('depth'), 'role': ext.get('role'),
            'note': 'Compatibility fields can differ legitimately; confirm target Tavern version.'}


def metrics(entries):
    rows = []
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        ext = entry.get('extensions', {})
        ext = ext if isinstance(ext, dict) else {}
        rows.append({'index': i, 'id': entry.get('id'), 'enabled': entry.get('enabled'),
                     'constant': entry.get('constant'), 'sizes': sizes(entry.get('content')),
                     'primary_keys': entry.get('keys'), 'secondary_keys': entry.get('secondary_keys'),
                     'position': position(entry), 'use_probability': ext.get('useProbability'),
                     'probability': ext.get('probability'),
                     'contains_ejs': isinstance(entry.get('content'), str) and '<%' in entry['content']})
    active = [r for r in rows if r['enabled'] is True]
    constant = [r for r in active if r['constant'] is True]
    def total(group):
        return {unit: sum((r['sizes'] or {}).get(unit, 0) for r in group)
                for unit in ('codepoints', 'utf16_units', 'utf8_bytes')}
    return {'counts': {'total': len(entries), 'enabled': len(active),
                       'disabled': sum(r['enabled'] is False for r in rows),
                       'enabled_unknown': sum(r['enabled'] is not True and r['enabled'] is not False for r in rows),
                       'enabled_constant': len(constant),
                       'secondary_keys': sum(bool(r['secondary_keys']) for r in rows),
                       'enabled_secondary_keys': sum(bool(r['secondary_keys']) for r in active),
                       'enabled_constant_ejs': sum(r['contains_ejs'] for r in constant),
                       'enabled_at_depth': sum(r['position']['effective'] == 'at_depth' for r in active)},
            'raw_enabled_constant_total': total(constant), 'entries': rows,
            'limitations': ['Raw template size is not evaluated output size or model tokens.',
                           'Enabled does not mean injected: keywords, conditions, probability, recursion and budgets apply.',
                           'Position semantics are a known Tavern convention, not execution or schema validation.']}


def target_preflight(root, card_metrics):
    specs = [('desktop/host/pack-knowledge.ts', 'MAX_CHARACTERS', 'knowledge_context_utf16_units'),
             ('desktop/host/pack-knowledge.ts', 'MAX_ENTRIES', 'knowledge_entries'),
             ('desktop/host/pack-knowledge.ts', 'MAX_KEYWORDS', 'keywords_per_entry'),
             ('desktop/host/pack-knowledge.ts', 'MAX_KEYWORD_LENGTH', 'keyword_utf16_units'),
             ('desktop/host/pack-knowledge.ts', 'MAX_CONFIG_BYTES', 'knowledge_config_utf8_bytes'),
             ('packages/world-pack/src/compiler.ts', 'MAX_MARKDOWN_BYTES', 'markdown_utf8_bytes'),
             ('packages/world-pack/src/compiler.ts', 'MAX_JSON_BYTES', 'json_utf8_bytes'),
             ('packages/world-pack/src/compiler.ts', 'MAX_TOTAL_BYTES', 'source_total_utf8_bytes'),
             ('packages/world-pack/src/schema.ts', 'MAX_DOCUMENTS', 'documents')]
    limits, evidence, unresolved = {}, [], []
    for relative, symbol, label in specs:
        path = root / relative
        try:
            raw = path.read_bytes()
            source = raw.decode('utf-8-sig')
        except (OSError, UnicodeError) as error:
            unresolved.append({'limit': label, 'reason': str(error)})
            continue
        match = re.search(r'\b' + symbol + r'\s*=\s*([0-9]+(?:\s*\*\s*[0-9]+)*)\s*[,;\r\n]', source)
        if not match:
            unresolved.append({'limit': label, 'reason': 'Numeric product declaration not found; inspect current code.'})
            continue
        value = 1
        for factor in match[1].split('*'):
            value *= int(factor.strip())
        limits[label] = value
        evidence.append({'limit': label, 'value': value, 'file': str(path.resolve()),
                         'line': source[:match.start()].count('\n') + 1,
                         'sha256': hashlib.sha256(raw).hexdigest(), 'symbol': symbol})
    risks, keyword_risks = [], []
    for row in card_metrics['entries']:
        size = row['sizes'] or {}
        for limit, unit in [('knowledge_context_utf16_units', 'utf16_units'),
                            ('markdown_utf8_bytes', 'utf8_bytes')]:
            if limit in limits and size.get(unit, 0) > limits[limit]:
                risks.append({'index': row['index'], 'enabled': row['enabled'], 'limit': limit,
                              'raw_size': size[unit], 'contains_ejs': row['contains_ejs']})
        # Primary keys only: secondary-key semantics must be redesigned, not blindly flattened.
        keys = row['primary_keys']
        if isinstance(keys, list):
            if len(keys) > limits.get('keywords_per_entry', float('inf')):
                keyword_risks.append({'index': row['index'], 'enabled': row['enabled'], 'reason': 'primary key count'})
            for i, key in enumerate(keys):
                size = sizes(key)
                if size and size['utf16_units'] > limits.get('keyword_utf16_units', float('inf')):
                    keyword_risks.append({'index': row['index'], 'enabled': row['enabled'],
                                          'key_index': i, 'reason': 'primary key length'})
    enabled_count = card_metrics['counts']['enabled']
    constant_size = card_metrics['raw_enabled_constant_total']['utf16_units']
    return {'project_root': str(root.resolve()), 'limits': limits, 'evidence': evidence,
            'unresolved': unresolved, 'raw_entry_risks': risks, 'primary_keyword_risks': keyword_risks,
            'aggregate_advisories': {
                'enabled_entries_exceed_knowledge_limit': enabled_count > limits['knowledge_entries']
                if 'knowledge_entries' in limits else None,
                'raw_enabled_constant_exceeds_context_ceiling': constant_size > limits['knowledge_context_utf16_units']
                if 'knowledge_context_utf16_units' in limits else None},
            'status': 'static_advisory_only',
            'limitations': ['Constants are source snapshots; verify their consumers and re-run after source changes.',
                           'No source evaluation, compilation, actual context selection or runtime budget trace was performed.',
                           'Disabled entries and unevaluated EJS are not active injection failures.',
                           'Generated files, keyword mapping, aggregate constant budget and runtime limits need separate validation.']}
