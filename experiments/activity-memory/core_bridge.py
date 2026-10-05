"""Disposable glue over the existing experimental core. Input is an authorized archive, never a world path."""
import copy
import json
import os
import sys
if __name__ == '__main__':
    sys.modules['core_bridge'] = sys.modules[__name__]
from pathlib import Path
CORE_DIR = Path(os.getenv('HCW_HINDSIGHT_CORE_DIR', str(Path(__file__).resolve().parents[1] / 'hindsight-core')))
sys.path.insert(0, str(CORE_DIR))
import core
import episode_core as episode
import projections
import vector_core
import queries
import activity_delivery as activity

_original_segments = episode.segments
_original_search_text = projections.atom_search_text

def segments(source):
    parts = _original_segments(source)
    if source['epistemicKind'] == 'observed_action':
        try: value = json.loads(source['text'])
        except (ValueError, TypeError): return parts
        if isinstance(value, dict):
            for part in parts:
                if part['channel'] == 'action':
                    outcome = json.loads(part['context'])
                    # A Host-projected outcome is evidence; playerInput/reason still stay excluded.
                    if isinstance(value.get('resultDescription'), str): outcome['resultDescription'] = value['resultDescription']
                    meta = activity.metadata(value)
                    if meta is not None: outcome['activity'] = meta
                    part['context'] = json.dumps(outcome, ensure_ascii=False, sort_keys=True)
    return parts

def search_text(atom):
    text = _original_search_text(atom)
    if atom['evidence']['channel'] == 'action':
        description = json.loads(atom['evidence']['context']).get('resultDescription')
        if isinstance(description, str): text = (text + ' ' + description).strip()
    return text

episode.segments = segments
projections.atom_search_text = search_text

def timed(units, sources):
    known = {s['sourceId']: s['knownTick'] for s in sources}
    return [{**u, 'knownTickStart': min(known[r['sourceId']] for r in u['sourceRefs']),
             'knownTickEnd': max(known[r['sourceId']] for r in u['sourceRefs'])} for u in units]


def utility_prompt(user):
    """Send canonical atom text once; keep full evidence/mappings in the archive."""
    try: payload = json.loads(user)
    except (ValueError, TypeError): return user
    if not isinstance(payload, dict) or not any(key in payload for key in ('newAtoms','atoms')):
        return user  # Retain's verbatim segment list must remain unchanged.
    for key in ('newAtoms','atoms'):
        if key not in payload: continue
        payload[key] = [{'id':a['id'], 'text':a['text'], 'memoryLevel':a['memoryLevel'],
                         'evidence':{k:a['evidence'][k] for k in ('channel','actorId')},
                         'sourceRefs':[{k:r[k] for k in ('sourceId','epistemicKind','worldSeq')} for r in a['sourceRefs']]}
                        for a in payload[key]]
    for key in ('episodes','existingEpisodes'):
        if key in payload:
            payload[key] = [{k:e[k] for k in ('id','label','eventAtomIds')} for e in payload[key]]
    return json.dumps(payload, ensure_ascii=False)


def utility_llm(system, user, max_tokens=1600):
    """Temporary JSON transport for full-prefix builds; credentials are never traced."""
    import math
    import time
    import urllib.request
    original_chars = len(user)
    user = utility_prompt(user)
    limit = min(24000, max(max_tokens, math.ceil(len(user) * 0.6)))
    endpoint = os.getenv('HCW_LOCAL_ENDPOINT', 'http://127.0.0.1:8045/v1/chat/completions')
    model = os.getenv('HCW_LOCAL_MODEL', 'gemini-3.7-flash')
    body = {'model':model,'messages':[{'role':'system','content':system},{'role':'user','content':user}],
            'response_format':{'type':'json_object'},'temperature':0,'max_tokens':limit}
    headers = {'content-type':'application/json'}
    if os.getenv('HCW_LOCAL_API_KEY'): headers['authorization'] = 'Bearer ' + os.environ['HCW_LOCAL_API_KEY']
    encoded = json.dumps(body,ensure_ascii=False).encode()
    for attempt in range(3):
        try:
            response = json.load(urllib.request.urlopen(urllib.request.Request(endpoint,data=encoded,headers=headers),timeout=120))
            break
        except (OSError,TimeoutError):
            if attempt == 2: raise
            time.sleep(2 * (attempt + 1))
    choice=response['choices'][0];msg=choice['message']
    value=msg.get('content') or (msg.get('tool_calls') or [{}])[0].get('function',{}).get('arguments')
    record={'model':model,'inputChars':len(user),'originalInputChars':original_chars,'requestedMaxTokens':limit,'finishReason':choice.get('finish_reason'),
            'usage':response.get('usage'),'responseText':value,'status':'returned'}
    trace=os.getenv('HCW_HINDSIGHT_UTILITY_TRACE')
    def save():
        if trace:
            with open(trace,'a',encoding='utf-8') as file: file.write(json.dumps(record,ensure_ascii=False)+'\n')
    try:
        if choice.get('finish_reason') == 'length': raise ValueError('memory utility JSON exceeded output budget')
        if not isinstance(value,str): raise ValueError('empty memory utility JSON')
        result=json.loads(value.strip().removeprefix('```json').removesuffix('```').strip())
    except (ValueError,TypeError) as error:
        record.update(status='rejected',error=str(error));save();raise
    save();return result



def retain_prefix(doc, max_prose_chars=9000):
    """Bound quote-selection requests without splitting a Source or changing atom IDs."""
    sources = core.check_sources(doc)  # Check the entire authorization boundary first.
    previous = doc.get('retainedPrefix')
    if previous is not None:
        episode.validate_units(previous)
        old_scope, scope = previous['scope'], core.check_scope(doc)
        if any(old_scope[k] != scope[k] for k in ('worldAddress','characterId')) or old_scope['asOfWorldSeq'] > scope['asOfWorldSeq']:
            raise ValueError('retained prefix scope mismatch')
        if sources[:len(previous['sources'])] != previous['sources']:
            raise ValueError('retained source prefix changed')
    reuse = previous['facts'] if previous is not None else []
    pending = sources[len(previous['sources']):] if previous is not None else sources
    batches, batch, size = [], [], 0
    for source in pending:
        parts = [{**part, 'sourceId':source['sourceId'], 'epistemicKind':source['epistemicKind']}
                 for part in segments(source) if part['channel'] != 'action']
        chars = len(json.dumps(parts, ensure_ascii=False))
        if batch and size + chars > max_prose_chars:
            batches.append(batch); batch, size = [], 0
        batch.append(source); size += chars
    if batch: batches.append(batch)
    retained = [episode.retain({**doc, 'sources':batch}) for batch in batches or [[]]]
    result = {'scope':core.check_scope(doc), 'sources':sources,
              'facts':copy.deepcopy(reuse) + [a for part in retained for a in part['facts']],
              'representations':copy.deepcopy(previous.get('representations',[])) + [r for part in retained for r in part['representations']] if previous is not None else [r for part in retained for r in part['representations']],
              'stats':{key:sum(part['stats'][key] for part in retained)
                       for key in ('atomCount','rejectedSelections','wholeSegmentFallbacks')}}
    result['stats']['atomCount'] = len(result['facts'])
    result['stats']['retainBatches'] = len(batches)
    result['stats']['reusedSources'] = len(previous['sources']) if previous is not None else 0
    result['stats']['reusedAtoms'] = len(reuse)
    result['stats']['selectionStatsScope'] = 'new sources' if previous is not None else 'all sources'
    episode.validate_units(result)
    return result


def dispatch(doc):
    if doc['operation'] == 'build':
        core.llm = utility_llm
        original = copy.deepcopy(core.check_sources(doc))
        previous = doc.get('retainedPrefix')
        identical = previous is not None and previous['scope'] == core.check_scope(doc) and previous['sources'] == original
        if identical:
            episode.validate_units(previous)
            data = copy.deepcopy(previous)
            grouped, integrated = {'actions':[]}, {'actions':[]}
        else:
            retained = retain_prefix(doc)
            data = {**retained, 'memoryGrain': 'episode', 'episodes': [], 'observations': []}
            grouped = episode.group(data)
            data['episodes'] = grouped['episodes']
            integrated = episode.consolidate({**data, 'observationsMission': '只形成证据支持的可修正认识，不把主持人的裁决改成独立核实的数值事实；不从一次猜错推断性格、智力或动机。'})
            data['observations'] = integrated['observations']
        for key in ('facts', 'episodes', 'observations'):
            data[key] = timed(data[key], data['sources'])
        activity.bind(data)
        episode.validate_units(data)
        if data['sources'] != original: raise ValueError('source evidence changed')
        aliases = doc.get('aliasHistory', [])
        index = vector_core.index(activity.index_metadata(projections.retrieval_projection(data, alias_history=aliases), data))
        return {'archive': data, 'index': index, 'grouping': grouped['actions'], 'consolidation': integrated['actions'], 'reusedIdenticalArchive':identical,
                'upstreamHashes': {p.name: __import__('hashlib').sha256(p.read_bytes()).hexdigest() for p in [CORE_DIR/'episode_core.py', CORE_DIR/'projections.py', CORE_DIR/'vector_core.py']}}
    if doc['operation'] == 'reproject':
        return {'archive': activity.reproject(doc['archive'])}
    if doc['operation'] == 'recall':
        data, index, request = doc['archive'], copy.deepcopy(doc['index']), doc['request']
        episode.validate_units(data)
        scope = data['scope']
        if index['scope'] != scope or request['context']['character']['characterId'] != scope['characterId']:
            raise ValueError('scope mismatch')
        if not doc['observations']:
            # Exclude Observation search representations before fusion, retain vectors by original positions.
            pairs = [(u,v) for u,v in zip(index['units'],index['vectors']) if u.get('projectionLevel') != 'observation']
            index['units'] = [u for u,_ in pairs]
            index['vectors'] = [v for _,v in pairs]
        query = queries.project(request, index.get('retrievalAliases'))
        recall = projections.search(index, scope, query['semanticQuery'], [], queryProjection=query, quality=True)
        mode = doc.get('deliveryMode','expanded')
        if mode == 'minimal':
            import candidate_admission
            import minimal_delivery
            candidates, admission = candidate_admission.admit(data, index, recall, request, query)
            observation_ids = {o['id'] for o in data['observations']}
            selected = [c['id'] for c in candidates if c['id'] in observation_ids]
            delivered = minimal_delivery.deliver(data, candidates, selected, request, doc['tick'], query)
            return {'query': query, 'baselineRetrieval': recall,
                    'retrieval': {**recall, 'results': candidates}, 'admission': admission,
                    'delivery': delivered['memories'], 'deliveryTrace': delivered['trace'],
                    'gateMode': 'none', 'jevCalls': 0}
        delivered = (projections.delivery_projection(data, recall['results'], request, doc['tick'], fair=True)
                     if mode == 'old' else activity.deliver(data, recall['results'], request, doc['tick'], query, include_anchors=mode != 'annotation'))
        return {'query': query, 'retrieval': recall, 'delivery': delivered['memories'], 'deliveryTrace': delivered['trace']}
    raise ValueError('unknown operation')

if __name__ == '__main__':
    json.dump(dispatch(json.load(sys.stdin)), sys.stdout, ensure_ascii=False)
