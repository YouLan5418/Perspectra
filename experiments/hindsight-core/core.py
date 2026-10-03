"""Disposable, character-scoped adapter around copied Hindsight core slices."""
from __future__ import annotations
import json, os, re, sys, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'vendor'))
from hindsight_api.engine.search.types import RetrievalResult
from hindsight_api.engine.search.fusion import reciprocal_rank_fusion
from hindsight_api.engine.consolidation.prompts import build_consolidation_system_prompt, build_consolidation_input
from hindsight_api.engine.retain.concise_prompt import CONCISE_FACT_EXTRACTION_PROMPT, _DEFAULT_LANGUAGE_RULE

KINDS = {'direct_observation', 'observed_action', 'reported_speech', 'subjective_inference', 'self_intention'}

def check_scope(doc):
    scope = doc['scope']
    address = scope['worldAddress']
    if set(address) != {'tenantId', 'worldId', 'branchId'} or not all(isinstance(v, str) and v for v in address.values()):
        raise ValueError('incomplete WorldAddress')
    if not isinstance(scope['characterId'], str) or not scope['characterId']:
        raise ValueError('missing CharacterId')
    if not isinstance(scope['asOfWorldSeq'], int) or scope['asOfWorldSeq'] < 0:
        raise ValueError('invalid worldSeq')
    return scope

def check_sources(doc):
    scope = check_scope(doc)
    sources = doc['sources']
    ids = set()
    for source in sources:
        for key in ('sourceId', 'sourceHash', 'epistemicKind', 'worldSeq', 'characterId', 'worldAddress', 'text'):
            if key not in source: raise ValueError('missing source field: ' + key)
        if source['characterId'] != scope['characterId'] or source['worldAddress'] != scope['worldAddress']:
            raise ValueError('cross-character or cross-world source')
        if source['epistemicKind'] not in KINDS or not isinstance(source['worldSeq'], int) or source['worldSeq'] > scope['asOfWorldSeq']:
            raise ValueError('invalid source epistemics or future seq')
        if source['sourceId'] in ids: raise ValueError('duplicate sourceId')
        ids.add(source['sourceId'])
    return sources

def llm(system, user, max_tokens=1600):
    endpoint = os.getenv('HCW_LOCAL_ENDPOINT', 'http://127.0.0.1:8045/v1/chat/completions')
    model = os.getenv('HCW_LOCAL_MODEL', 'gemini-3.7-flash')
    headers = {'content-type': 'application/json'}
    if os.getenv('HCW_LOCAL_API_KEY'): headers['authorization'] = 'Bearer ' + os.environ['HCW_LOCAL_API_KEY']
    body = json.dumps({'model': model, 'messages': [{'role':'system','content':system}, {'role':'user','content':user}],
                       'response_format': {'type':'json_object'}, 'temperature':0, 'max_tokens': max_tokens}, ensure_ascii=False).encode()
    for attempt in range(3):
        try:
            response = json.load(urllib.request.urlopen(urllib.request.Request(endpoint, data=body, headers=headers), timeout=120))
            break
        except (OSError, TimeoutError):
            if attempt == 2: raise
            time.sleep(2 * (attempt + 1))
    msg = response['choices'][0]['message']
    value = msg.get('content') or (msg.get('tool_calls') or [{}])[0].get('function', {}).get('arguments')
    if not isinstance(value, str): raise ValueError('empty model JSON')
    return json.loads(value.strip().removeprefix('```json').removesuffix('```').strip())

def source_ref(source):
    return {k:source[k] for k in ('sourceId','sourceHash','epistemicKind','worldSeq','characterId','worldAddress')}

def retain(doc):
    sources = check_sources(doc)
    # Source representation is always verbatim. Extracted facts are extra, never a replacement.
    representations = [{'id':'raw:'+s['sourceId'], 'text':s['text'], 'entities':[], 'evidenceQuote':s['text'],
                        'sourceRefs':[source_ref(s)], 'kind':'representation'} for s in sources]
    facts = []
    prompt = CONCISE_FACT_EXTRACTION_PROMPT.format(language_section=_DEFAULT_LANGUAGE_RULE+'\n\n',retain_mission_section='')
    prompt += ('\n\nPERSPECTRA ADAPTATION: This is an isolated character memory, not objective world knowledge. '
               'Each source carries epistemicKind. Reported speech means only that a statement was heard; '
               'an intention does not mean it was fulfilled. Use worldSeq ticks only; never infer calendar time. '
               'Return JSON {"facts":[{"what":"...","source_id":"...","evidence_quote":"exact substring from that source",'
               '"entities":["..."]}]}. One fact must cite exactly one input source. Preserve source language. '
               'Do not add a fact unsupported by its quoted source.')
    for offset in range(0, len(sources), 8):
        batch = sources[offset:offset+8]
        answer = llm(prompt, json.dumps([{'source_id':s['sourceId'],'epistemicKind':s['epistemicKind'],
                                          'worldSeq':s['worldSeq'],'knownTick':s.get('knownTick'),'text':s['text']} for s in batch], ensure_ascii=False), 1800)
        by_id = {s['sourceId']:s for s in batch}
        for item in answer.get('facts', []):
            if not isinstance(item,dict) or item.get('source_id') not in by_id: continue
            source = by_id[item['source_id']]
            quote = item.get('evidence_quote')
            what = item.get('what')
            if not isinstance(quote,str) or not quote or quote not in source['text'] or not isinstance(what,str) or not what.strip(): continue
            entities = item.get('entities', [])
            if not isinstance(entities,list): entities=[]
            facts.append({'id':f"fact:{source['sourceId']}:{len(facts)}",'text':what.strip(),
                          'entities':[v.strip() for v in entities if isinstance(v,str) and v.strip()],
                          'evidenceQuote':quote,'sourceRefs':[source_ref(source)],'kind':'fact'})
    return {'scope':check_scope(doc),'representations':representations,'facts':facts,
            'stats':{'sourceCount':len(sources),'extractedFactCount':len(facts)}}

def check_units(doc):
    scope = check_scope(doc)
    units = doc.get('representations', []) + doc.get('facts', []) + doc.get('episodes', []) + doc.get('observations', [])
    ids = set()
    for unit in units:
        if unit['id'] in ids: raise ValueError('duplicate unit id')
        ids.add(unit['id'])
        if not unit['sourceRefs']: raise ValueError('unit without source mapping')
        for ref in unit['sourceRefs']:
            if ref['characterId'] != scope['characterId'] or ref['worldAddress'] != scope['worldAddress'] or ref['worldSeq'] > scope['asOfWorldSeq']:
                raise ValueError('unit crosses cognitive boundary')
            if not ref['sourceId'] or not ref['sourceHash'] or ref['epistemicKind'] not in KINDS:
                raise ValueError('incomplete source mapping')
    return units

def consolidate(doc):
    check_units(doc)
    facts = doc['facts']
    if not facts: return {'scope':check_scope(doc),'observations':doc.get('observations',[]),'actions':{'creates':[],'updates':[],'deletes':[]}}
    existing = doc.get('observations', [])
    by_fact = {f['id']:f for f in facts}
    by_obs = {o['id']:o for o in existing}
    system = build_consolidation_system_prompt()
    system += ('\nPERSPECTRA ADAPTATION: These are one character\'s fallible memories. '
               'Never convert reported speech into an observed world event or an intention into completion. '
               'Preserve whose statement it was. worldSeq denotes simulation order, not calendar date. '
               'Observations are non-authoritative summaries of source facts.')
    user = build_consolidation_input('\n'.join('['+f['id']+'] '+f['text']+' (epistemicKind='+
               ','.join(sorted({r['epistemicKind'] for r in f['sourceRefs']}))+'; knownTick='+str(f.get('knownTickEnd', 'unknown'))+')' for f in facts),
               json.dumps([{'id':o['id'],'text':o['text'],'proof_count':len(o['sourceRefs']), 'knownTickStart':o.get('knownTickStart'), 'knownTickEnd':o.get('knownTickEnd')} for o in existing],ensure_ascii=False),
               observations_mission=doc.get('observationsMission', 'Consolidate durable character memories without losing speaker, uncertainty, or epistemic status.'))
    actions = llm(system,user,2300)
    result = dict(by_obs)
    accepted = {'creates':[],'updates':[],'deletes':[]}
    for kind in ('creates','updates'):
        for action in actions.get(kind,[]):
            if not isinstance(action,dict) or not isinstance(action.get('text'),str) or not action['text'].strip(): continue
            ids=action.get('source_fact_ids')
            if not isinstance(ids,list) or not ids or any(i not in by_fact for i in ids): continue
            if kind=='updates' and action.get('observation_id') not in by_obs: continue
            refs={json.dumps(r,sort_keys=True,ensure_ascii=False):r for i in ids for r in by_fact[i]['sourceRefs']}
            if kind=='updates':
                old=by_obs[action['observation_id']]
                refs.update({json.dumps(r,sort_keys=True,ensure_ascii=False):r for r in old['sourceRefs']})
            next_number=max([int(k[4:]) for k in result if k.startswith('obs:') and k[4:].isdigit()] or [0])+1
            obs_id = action['observation_id'] if kind=='updates' else 'obs:'+str(next_number)
            result[obs_id]={'id':obs_id,'text':action['text'].strip(),'sourceRefs':list(refs.values()),
                            'sourceFactIds':list(dict.fromkeys(ids + (by_obs[obs_id].get('sourceFactIds',[]) if kind=='updates' else []))),
                            'kind':'observation','reason':action.get('reason','')}
            accepted[kind].append(action)
    for action in actions.get('deletes',[]):
        if isinstance(action,dict) and action.get('observation_id') in by_obs:
            result.pop(action['observation_id'],None)
            accepted['deletes'].append(action)
    out={'scope':check_scope(doc),'observations':list(result.values()),'actions':accepted}
    check_units({**doc, **out})
    return out

def grams(text):
    s=re.sub(r'\s+','',text.casefold())
    return set(s[i:i+2] for i in range(max(0,len(s)-1))) | set(re.findall(r'[a-z0-9_]+',s))

def recall(doc):
    units=check_units(doc)
    if any(u.get('memoryLevel') for u in units):
        import episode_core
        episode_core.validate_units(doc, units)
    query=doc['query']
    if not isinstance(query,str) or not query.strip(): raise ValueError('empty query')
    q=grams(query)
    def rr(unit, kind, score):
        return RetrievalResult(id=unit['id'],text=unit['text'],fact_type=kind,
                               metadata={'sourceRefs':json.dumps(unit['sourceRefs'],ensure_ascii=False)},
                               bm25_score=score if kind=='keyword' else None,
                               similarity=score if kind=='semantic' else None)
    keyword=[]; graph=[]; temporal=[]
    for unit in units:
        terms=grams(unit['text'])
        overlap=len(q & terms)/(len(q|terms) or 1)
        if overlap: keyword.append((overlap,rr(unit,'keyword',overlap)))
        entity_hits=sum(1 for entity in unit.get('entities',[]) if entity.casefold() in query.casefold())
        if entity_hits: graph.append((entity_hits,rr(unit,'graph',entity_hits)))
        if overlap or entity_hits:
            temporal.append((max(r['worldSeq'] for r in unit['sourceRefs']),rr(unit,'temporal',overlap)))
    arms=[[r for _,r in sorted(arm,key=lambda t:t[0],reverse=True)[:32]] for arm in (keyword,graph,temporal)]
    fused=reciprocal_rank_fusion(arms)
    by_id={u['id']:u for u in units}
    limit=max(1,min(20,int(doc.get('limit',8))))
    # Hindsight's prefer-observations behavior: an observation carries its source facts,
    # so do not spend the limited model context on the same fact and raw source again.
    ordered=sorted(fused,key=lambda c:(by_id[c.id]['kind']!='observation',c.rrf_rank)) if doc.get('observations') else fused
    covered=set()
    atom_covered=set()
    selected=[]
    for candidate in ordered:
        unit=by_id[candidate.id]
        source_ids={r['sourceId'] for r in unit['sourceRefs']}
        atom_ids=({unit['id']} if unit.get('memoryLevel')=='event_atom' else
                  set(unit.get('eventAtomIds',unit.get('sourceFactIds',[]))))
        if unit.get('memoryLevel'):
            if atom_ids and atom_ids <= atom_covered: continue
        elif unit['kind']!='observation' and source_ids <= covered: continue
        selected.append(candidate)
        if unit.get('memoryLevel'): atom_covered.update(atom_ids)
        elif unit['kind']=='observation': covered.update(source_ids)
        if len(selected)>=limit: break
    return {'scope':check_scope(doc),'query':query,'results':[
        {**by_id[c.id],'score':c.rrf_score,'rank':c.rrf_rank,'sourceRanks':c.source_ranks}
        for c in selected],'arms':{'keyword':len(arms[0]),'graph':len(arms[1]),'temporal':len(arms[2])}}

def main():
    doc=json.load(sys.stdin)
    op=doc.get('operation')
    result={'retain':retain,'consolidate':consolidate,'recall':recall}[op](doc)
    print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__': main()
