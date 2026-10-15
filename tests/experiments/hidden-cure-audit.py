"""Read synthetic author evidence; never feed combined evidence back to an NPC."""
import json
import sys
import sqlite3
from pathlib import Path


def text(data):
    return data.get('text', '') or '\n'.join(s['text'] for s in data.get('segments', []))


def audit(root):
    results = []
    for name in ['A', 'B', 'C']:
        path = root / name / 'record.json'
        if not path.exists():
            continue
        record = json.loads(path.read_text(encoding='utf-8'))
        failures = []
        if len(record.get('rounds', [])) != 8 or not record.get('initial') or not record.get('final'):
            failures.append('incomplete eight-turn experiment')
        events = record.get('final', {}).get('events', [])
        locations = dict(record.get('initial', {}).get('locations', {}))
        by_transaction = {}
        initial_count = record.get('initial', {}).get('seq', 0)
        state = record.get('initial', {}).get('record', {})
        holder, place = state.get('holderId'), state.get('locationId')
        transfers = []
        for event in events:
            by_transaction.setdefault(event['transactionId'], []).append(event)
        for event in events:
            if event['seq'] <= initial_count:
                continue
            data = event['data']
            if event['eventType'] == 'character.moved':
                actor = data['characterId']
                if locations[actor] != data['fromLocationId']:
                    failures.append(f"seq {event['seq']}: inconsistent move origin")
                locations[actor] = data['toLocationId']
            if event['eventType'] == 'entity.transferred':
                if (holder, place) != (data['fromHolderId'], data['fromLocationId']):
                    failures.append(f"seq {event['seq']}: inconsistent document origin")
                holder, place = data['toHolderId'], data['toLocationId']
                transfers.append({'seq': event['seq'], **data})
            if event['eventType'] == 'character.speak':
                actor = data['characterId']
                scope = data.get('scope', 'scene_public')
                if scope == 'self':
                    allowed = {actor}
                elif scope in ['direct', 'private']:
                    allowed = {actor, *data.get('addresseeIds', [])}
                else:
                    allowed = {who for who, where in locations.items() if where == locations[actor]}
                for sibling in by_transaction[event['transactionId']]:
                    if sibling['eventType'] != 'observation.upsert':
                        continue
                    value = sibling['data']['value']
                    content = value.get('content', {})
                    if not isinstance(content, dict) or 'speech' not in content:
                        continue
                    # A private bystander can observe that an exchange occurred, never its content.
                    if value['observerId'] not in allowed and text(content['speech']):
                        failures.append(f"seq {event['seq']}: unauthorized speech observer {value['observerId']}")
        final_state = record.get('final', {}).get('record', {})
        if (holder, place) != (final_state.get('holderId'), final_state.get('locationId')):
            failures.append('document replay differs from final authoritative state')
        database_integrity = {}
        memory_sources = {}
        selection = json.loads((root / name / 'world' / 'current-world.json').read_text(encoding='utf-8'))
        world_path = root / name / 'world' / selection['directory']
        environment = json.loads(selection['tail']['environment'])
        for database in ['world.sqlite', 'memory.sqlite']:
            with sqlite3.connect((world_path / database).resolve().as_uri()+'?mode=ro', uri=True) as db:
                db.execute('PRAGMA query_only=ON')
                checked = [row[0] for row in db.execute('PRAGMA integrity_check')]
                database_integrity[database] = checked
                if checked != ['ok']:
                    failures.append(f'{database}: failed SQLite integrity check')
                if database == 'memory.sqlite':
                    event_map = {event['seq']: event for event in events}
                    rows = db.execute('SELECT namespace_key,source_type,source_seq,text_value FROM cognitive_memory_v2_sources').fetchall()
                    for namespace, source_type, source_seq, source_text in rows:
                        actor = namespace.split('\x1f')[-1]
                        memory_sources[actor] = memory_sources.get(actor, 0) + 1
                        source = event_map.get(source_seq)
                        if not source:
                            failures.append(f'memory {actor}: absent source {source_seq}')
                            continue
                        if source['eventType'] == 'observation.upsert':
                            owner = source['data']['value'].get('observerId')
                        elif source['eventType'] in ['character.speak', 'character-goal.upsert']:
                            owner = source['data'].get('characterId')
                        else:
                            owner = None
                            failures.append(f'memory {actor}: unsupported source kind {source["eventType"]}')
                        if actor != owner:
                            failures.append(f'memory {actor}: foreign source {source_seq} ({source_type})')
                        if actor == 'character:rival' and '银杏灯约定' in source_text:
                            failures.append('private dialogue marker retained in rival memory')
        integrity_count = 0
        for row in record.get('rounds', []):
            integrity = row.get('integrity', {})
            if integrity.get('headSeq') != integrity.get('eventCount') or not integrity.get('verificationHash'):
                failures.append(f"round {row['round']}: incomplete integrity evidence")
            else:
                integrity_count += 1
            for actor, bundle in row['views'].items():
                for observation in bundle['view']['observations']:
                    if observation['value'].get('observerId') != actor:
                        failures.append(f"round {row['round']}: foreign observation in {actor} view")
                for goal in bundle['view']['goals']:
                    if goal['value'].get('characterId', actor) != actor:
                        failures.append(f"round {row['round']}: foreign goal in {actor} view")
        rival_no_stimulus = []
        for index, call in enumerate(record.get('calls', [])):
            payload = json.dumps(call['input'], ensure_ascii=False)
            if call['actor'] != 'character:player' and '灰钟梦兆' in payload:
                failures.append(f'call {index}: leaked private future seed')
            if call['actor'] != 'character:rival' and '独占议程' in payload:
                failures.append(f'call {index}: leaked rival intention seed')
            if call['actor'] == 'character:rival' and '银杏灯约定' in payload:
                failures.append(f'call {index}: private dialogue marker in rival request; inspect for authorized relay')
            if call['actor'] == 'character:rival' and call['autonomous'] and not call['continuation']:
                if not call['input']['context'].get('stimulus'):
                    rival_no_stimulus.append({'call': index, 'round': call['round'], 'proposal': call.get('proposal')})
        actions = record.get('final', {}).get('actions', [])
        rejected = [a for a in actions if a.get('accepted') is False]
        errors = [r['round'] for r in record.get('rounds', []) if r.get('error')]
        abstentions = [{'round': c['round'], 'actor': c['actor']} for c in record.get('calls', [])
                       if c.get('proposal', {}).get('decision') == 'abstain']
        result = {'case': name, 'rounds': len(record.get('rounds', [])),
                  'packHash': environment['packHash'], 'model': environment['model'],
                  'settings': environment['playSettings'], 'initialLocations': record['initial']['locations'],
                  'databaseIntegrity': database_integrity, 'memorySourcesByActor': memory_sources,
                  'integrityChecks': integrity_count, 'failures': failures, 'errorRounds': errors,
                  'rejectedActions': rejected, 'transfers': transfers, 'finalDocument': final_state,
                  'rivalOpportunitiesWithEmptyStimulus': rival_no_stimulus, 'abstentions': abstentions,
                  'limits': 'Mechanical ownership, audience and replay checks only; semantic claims require human review.'}
        results.append(result)
        lines = [f'# 实验 {name}：实际提交记录', '',
                 '这是作者审阅材料，包含不同角色的私有表达，禁止作为玩家界面或角色输入。', '',
                 'record.json 保留逐调用授权输入和模型提案；这里仅列已提交事件。提案失败或过期不计入实际行动。', '']
        for row in record.get('rounds', []):
            lines += [f"## 第 {row['round']} 回合", '', f"玩家操作：`{row['playerInput']}`", '',
                      f"耗时 {row['elapsedMs']} ms；NPC 错误 {row['error']}；文献保管者 {row['record']['holderId']}。", '']
            for event in row['newEvents']:
                data = event['data']; kind = event['eventType']; seq = event['seq']
                if kind == 'character.speak':
                    lines += [f"- seq {seq}，{data['characterId']}，{data.get('scope')}：{text(data)}", '']
                elif kind in ['character.moved', 'entity.transferred', 'action.rejected']:
                    lines += [f"- seq {seq}，{kind}：`{json.dumps(data, ensure_ascii=False)}`", '']
            lines += [f"各角色授权信息与来源：record.json → rounds[{row['round']-1}].views；实际请求：calls[{row['calls'][0]}:{row['calls'][1]}]。", '']
        (root / name / 'transcript.md').write_text('\n'.join(lines), encoding='utf-8')
    if len(results) == 3:
        for field in ['packHash', 'model', 'settings', 'initialLocations']:
            if any(row[field] != results[0][field] for row in results[1:]):
                results[0]['failures'].append(f'cross-case mismatch: {field}')
    (root / 'audit.json').write_text(json.dumps(results, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps([{'case': r['case'], 'rounds': r['rounds'], 'integrityChecks': r['integrityChecks'],
                       'failures': r['failures'], 'errorRounds': r['errorRounds']} for r in results], ensure_ascii=False))
    return any(r['failures'] for r in results) or len(results) != 3


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) != 2:
        raise SystemExit('usage: python tests/experiments/hidden-cure-audit.py output/hidden-cure/live-...')
    raise SystemExit(int(audit(Path(sys.argv[1]))))
