"""Character-scoped, in-memory storage adaptation of Hindsight search slices."""
from __future__ import annotations
import asyncio
import hashlib
import json
import math
import os
import re
import sys
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
import numpy as np
import core
from hindsight_api.engine.onnx_slices import OnnxEmbeddings
from hindsight_api.engine.search.portable_slices import (
    _normalize_entity_name, _cap_links_per_unit, _within_batch_temporal_links,
    compute_semantic_links_within_batch, _select_with_temporal_coverage, merge_expansion_rows)
from hindsight_api.engine.search.types import RetrievalResult
from hindsight_api.engine.search.fusion import reciprocal_rank_fusion

MODEL = 'Xenova/multilingual-e5-small'
_MODELS = {}
BASE = Path(__file__).resolve().parents[2]
# A private numeric bridge for original datetime arithmetic: one tick = one surrogate hour.
# These dates never reach the character and never mean real time or event occurrence time.
ORIGIN = datetime(2000, 1, 1, tzinfo=UTC)

def encode(texts, scope, query=False):
    assets = Path(os.getenv('HCW_HINDSIGHT_ONNX_DIR', str(BASE / '.tmp/hindsight-e5-small')))
    namespace = hashlib.sha256(json.dumps(scope['worldAddress'],sort_keys=True).encode()
                               + scope['characterId'].encode()).hexdigest()
    cache_path = Path(os.getenv('HCW_HINDSIGHT_CACHE_DIR', str(BASE / '.tmp/hindsight-vector-cache'))) / (namespace + '.json')
    cache_path.parent.mkdir(parents=True,exist_ok=True)
    cache = json.loads(cache_path.read_text(encoding='utf-8')) if cache_path.exists() else {}
    prefix = 'query: ' if query else 'passage: '
    keys = [hashlib.sha256((MODEL+'@761b726|'+prefix+t).encode()).hexdigest() for t in texts]
    missing = list(dict.fromkeys(k for k in keys if k not in cache))
    if missing:
        by_key = dict(zip(keys,texts))
        async def work():
            model = _MODELS.get(str(assets))
            if model is None:
                model = OnnxEmbeddings(MODEL, model_path=str(assets/'onnx/model_quantized.onnx'),
                    tokenizer_name_or_path=str(assets), max_tokens=256, batch_size=8)
                await model.initialize()
                _MODELS[str(assets)] = model
            return await (model.encode_query if query else model.encode_documents)([by_key[k] for k in missing])
        for key, vector in zip(missing,asyncio.run(work())):
            cache[key] = vector
        cache_path.write_text(json.dumps(cache),encoding='utf-8')
    return np.asarray([cache[k] for k in keys],dtype=np.float32)

def check_mapping(doc, units):
    sources = core.check_sources(doc)
    by_id = {s['sourceId']:s for s in sources}
    core.check_units({**doc, 'representations':[u for u in units if u['kind']=='representation'],
        'facts':[u for u in units if u['kind']=='fact'], 'episodes':[u for u in units if u['kind']=='episode'], 'observations':[u for u in units if u['kind']=='observation']})
    for unit in units:
        for ref in unit['sourceRefs']:
            source = by_id.get(ref['sourceId'])
            if source is None or core.source_ref(source) != ref:
                raise ValueError('unit reference does not match authorized source snapshot')
    if any(u.get('memoryLevel') for u in units):
        import episode_core
        episode_core.validate_units(doc, units)
    for source in sources:
        if not isinstance(source.get('knownTick'),int) or source['knownTick'] < 0:
            raise ValueError('source lacks authorized knowledge tick')
    return by_id

def index(doc):
    units = core.check_units(doc)
    sources = check_mapping(doc,units)
    if doc.get('memoryGrain') == 'episode':
        units = [u for u in units if u['kind'] != 'representation']
    facts = doc.get('facts',[])
    by_fact = {f['id']:f for f in facts}
    enriched = []
    for unit in units:
        entities = {_normalize_entity_name(e).casefold() for e in unit.get('entities',[]) if isinstance(e,str)}
        for ref in ([] if unit.get('memoryLevel') or unit.get('retrievalProjection') else unit['sourceRefs']):
            entities.update(re.findall(r'(?:character|entity|location):[a-z0-9_-]+',sources[ref['sourceId']]['text']))
        if unit['kind'] in {'episode','observation'}:
            for atom in unit.get('eventAtoms',[]):
                entities.update(atom.get('entities',[]))
        if unit['kind']=='observation':
            for fact_id in unit.get('sourceFactIds',[]):
                entities.update(_normalize_entity_name(e).casefold() for e in by_fact.get(fact_id,{}).get('entities',[]))
        ticks = [{'sourceId':r['sourceId'],'knownTick':sources[r['sourceId']]['knownTick']} for r in unit['sourceRefs']]
        enriched.append({**unit,'entities':sorted(entities),'sourceTicks':ticks,
                         'knownTickStart':min(t['knownTick'] for t in ticks),
                         'knownTickEnd':max(t['knownTick'] for t in ticks)})
    vectors = encode([u.get('retrievalText',u['text']) for u in enriched],doc['scope']) if enriched else np.empty((0,384))
    # The original Hindsight within-batch cosine-kNN implementation, same fact-type grouping.
    links = []
    for kind in ('representation','fact','episode','observation'):
        positions = [i for i,u in enumerate(enriched) if u['kind']==kind]
        ids = [enriched[i]['id'] for i in positions]
        links.extend(compute_semantic_links_within_batch(ids,vectors[positions],top_k=8,
                                                       threshold=float(doc.get('semanticLinkThreshold',0.80))))
    dates = {u['id']:(ORIGIN+timedelta(hours=u['knownTickEnd']),u['kind']) for u in enriched}
    links.extend(_cap_links_per_unit(_within_batch_temporal_links(dates,time_window_hours=8),10))
    return {'scope':doc['scope'],'sources':doc['sources'],'units':enriched,
            **({'retrievalAliases':doc['retrievalAliases']} if 'retrievalAliases' in doc else {}),
            'vectors':vectors.tolist(),'links':[list(link) for link in links],
            'stats':{'embeddingModel':MODEL,'revision':'761b726','dimensions':int(vectors.shape[1]),
                     'semanticEdges':sum(e[2]=='semantic' for e in links),
                     'temporalEdges':sum(e[2]=='temporal' for e in links),
                     'causalEdges':0, **({'retrievalTextRule':doc['retrievalAliases']['rule']} if 'retrievalAliases' in doc else {})}}

def recall_quality(doc):
    """Query relevance before rank fusion; thresholds remain experiment settings."""
    import queries
    idx=doc['index']
    if idx['scope']!=doc['scope']: raise ValueError('index scope differs')
    units=idx['units']
    sources=check_mapping({**idx,'representations':[],'facts':[],'observations':[]},units)
    query=doc['queryProjection']
    window=doc.get('tickWindow')
    if window is not None and (not isinstance(window.get('start'),int) or not isinstance(window.get('end'),int)
            or window['start']<0 or window['start']>window['end']):raise ValueError('invalid tick window')
    node_ids={u['id'] for u in units}
    for edge in idx['links']:
        if len(edge)!=5 or edge[0] not in node_ids or edge[1] not in node_ids or edge[2] not in {'semantic','temporal'}:
            raise ValueError('invalid or foreign graph edge')
    active=[i for i,u in enumerate(units) if window is None or all(window['start']<=sources[r['sourceId']]['knownTick']<=window['end'] for r in u['sourceRefs'])]
    empty={k:[] for k in ('semantic','bm25','graph','temporal')}
    if query['mode']=='skip' or not active:
        return {'scope':doc['scope'],'query':query['semanticQuery'],'queryProjection':query,'results':[],
                'arms':{k:0 for k in empty},'armResults':empty,'memoryArmResults':empty,
                'graphSeeds':[],'expansionPaths':[],'indexStats':idx['stats'],'skipReason':query.get('skipReason')}
    text=query['semanticQuery']
    if queries.bounded(text)[2]:raise ValueError('semantic query exceeds token budget')
    vectors=np.asarray(idx['vectors'],dtype=np.float32)
    if vectors.ndim!=2 or vectors.shape[0]!=len(units) or not np.isfinite(vectors).all():raise ValueError('invalid embedding matrix')
    required_objects=set(query.get('requiredEntityIds',[])) if query['mode']=='entity' else set()
    if required_objects:
        # Exact object retrieval has no semantic or lexical admission.
        similarities=np.zeros(len(units),dtype=np.float32)
    else:
        qv=np.asarray(doc['queryVector'],dtype=np.float32) if 'queryVector' in doc else encode([text],doc['scope'],True)[0]
        if qv.shape!=(vectors.shape[1],) or not np.isfinite(qv).all() or np.linalg.norm(qv)==0:raise ValueError('invalid query embedding')
        similarities=(vectors@qv)/np.maximum(np.linalg.norm(vectors,axis=1)*np.linalg.norm(qv),1e-9)
    by_id={units[i]['id']:units[i] for i in active}
    scores={units[i]['id']:float(similarities[i]) for i in active}
    # Query-specific background is not a probability or a factual confidence score.
    background=float(np.median(list(scores.values())))
    semantic_min=float(doc.get('semanticMin',0.3))
    lift_min=float(doc.get('semanticLiftMin',0.30));coverage_min=float(doc.get('keywordCoverageMin',0.15))
    bags={ident:Counter(queries.lexical_terms(u.get('retrievalText',u['text']))) for ident,u in by_id.items()}
    # A one-character Chinese query (e.g. 茶) must match that character in a longer passage.
    for term in query['keywordTerms']:
        if len(term)==1 and '\u3400'<=term<='\u9fff':
            for ident,u in by_id.items(): bags[ident][term]=u.get('retrievalText',u['text']).count(term)
    df=Counter(t for bag in bags.values() for t in bag);n=len(bags)
    average=sum(sum(b.values()) for b in bags.values())/max(n,1)
    terms=set() if required_objects else set(query['keywordTerms'])
    idf={t:math.log(1+(n-df[t]+0.5)/(df[t]+0.5)) for t in terms}
    total=sum(idf.values())
    signals={}
    for ident,bag in bags.items():
        matched=sorted(t for t in terms if bag[t])
        bm=sum(idf[t]*bag[t]*2.5/(bag[t]+1.5*(0.25+0.75*sum(bag.values())/max(average,1))) for t in matched)
        coverage=sum(idf[t] for t in matched)/total if total else 0.0
        lift=max(0.0,(scores[ident]-background)/max(1-background,1e-9))
        object_match=bool(set(by_id[ident].get('entities',[])) & required_objects)
        relevance=float(object_match) if required_objects else max(coverage,lift)
        signals[ident]={'semanticSimilarity':None if required_objects else scores[ident],
            'semanticLift':None if required_objects else lift,'semanticScored':not bool(required_objects),'bm25Score':bm,
            'keywordCoverage':coverage,'matchedTerms':matched,'relevance':relevance,
            'accepted':(object_match if required_objects else (scores[ident]>=semantic_min and lift>=lift_min or coverage>=coverage_min))
                and not (query['mode']=='entity' and by_id[ident].get('channels')==['action'])}
    def ranked(ids,key):return sorted(ids,key=lambda i:(-key(i),i))
    # Collapse BEFORE arm budgets and graph seed budgets; retain every hit for tracing.
    def cap(ids,limit=32):
        selected=[];seen=set()
        for ident in ids:
            memory=by_id[ident]['memoryId']
            if memory in seen:continue
            seen.add(memory);selected.append(ident)
            if len(selected)==limit:break
        return selected
    good={i for i,s in signals.items() if s['accepted']}
    semantic=cap(ranked([i for i in good if scores[i]>=semantic_min],lambda i:scores[i]))
    bm25=cap(ranked([i for i in good if signals[i]['bm25Score']>0],lambda i:signals[i]['bm25Score']))
    seeds=cap(ranked([i for i in good if scores[i]>=semantic_min],lambda i:scores[i]),20)
    # Semantic edges contribute provenance inside the semantic arm, never a second vote.
    paths=[]
    for a,b,kind,weight,_ in idx['links']:
        if kind=='semantic':
            for parent,target in ((a,b),(b,a)):
                if parent in seeds and target in good:
                    paths.append({'from':parent,'to':target,'kind':'semantic','weight':weight,'arm':'semantic','use':'diagnostic neighbor; no extra vote or admission'})
    wanted={e['id']:e['roles'] for e in query['entitySeeds'] if not required_objects or e['id'] in required_objects}
    # Count entity frequency once per memory, not once per window.
    entity_memories={}
    for u in by_id.values():
        for entity in u.get('entities',[]):entity_memories.setdefault(entity,set()).add(u['memoryId'])
    memory_count=len({u['memoryId'] for u in by_id.values()})
    weights={e:math.log(1+(memory_count-len(entity_memories.get(e,set()))+0.5)/(len(entity_memories.get(e,set()))+0.5)) for e in wanted}
    denominator=sum(weights.values())
    graph_scores={}
    for ident in good:
        shared=sorted(set(by_id[ident].get('entities',[]))&set(wanted))
        if shared:
            graph_scores[ident]=sum(weights[e] for e in shared)/denominator if denominator else 0
            if required_objects:signals[ident]['relevance']=graph_scores[ident]
            paths.append({'from':'current authorized query','to':ident,'kind':'entity','entities':shared,
                'seedRoles':{e:wanted[e] for e in shared},'idf':{e:weights[e] for e in shared},
                'roles':by_id[ident].get('entityRoles',[]),'arm':'graph'})
    graph=cap(ranked(graph_scores,lambda i:graph_scores[i]))
    arm_ids={'semantic':semantic if query['mode']!='entity' else [],
             'bm25':bm25 if query['mode']!='entity' else [],'graph':graph,'temporal':[]}
    for name in doc.get('disableArms',[]):
        if name not in arm_ids:raise ValueError('unknown retrieval arm')
        arm_ids[name]=[]
    arms={}
    for name,ids in arm_ids.items():
        arms[name]=[RetrievalResult(id=by_id[i]['memoryId'],text='',fact_type=by_id[i]['kind'],
             similarity=scores[i],bm25_score=signals[i]['bm25Score']) for i in ids]
    fused=reciprocal_rank_fusion(list(arms.values()))
    atom_signals={}
    for ident,u in by_id.items():
        if u['projectionLevel']=='event_atom':
            for atom in u['atomIds']:
                if atom not in atom_signals or signals[ident]['relevance']>atom_signals[atom]['relevance']:
                    atom_signals[atom]=signals[ident]
    candidates=[]
    for candidate in fused:
        views=[u for ident,u in by_id.items() if u['memoryId']==candidate.id and ident in good]
        views.sort(key=lambda u:(-signals[u['id']]['relevance'],-scores[u['id']],u['id']))
        matches=[{'representationId':u['id'],'atomIds':u['atomIds'],'sourceRefs':u['sourceRefs'],**signals[u['id']],
             'atomScores':[{'atomId':i,**atom_signals[i]} for i in u['atomIds'] if i in atom_signals]} for u in views]
        if views[0]['projectionLevel']=='episode' and not any(row['accepted'] for m in matches for row in m['atomScores']):
            continue
        relevance=max(m['relevance'] for m in matches)
        candidates.append({'id':candidate.id,'score':candidate.rrf_score,'fusionRank':candidate.rrf_rank,
            'sourceRanks':candidate.source_ranks,'relevance':relevance,'matches':matches})
    # Rank useful content first. RRF only breaks equal relevance, not the admission gate.
    candidates.sort(key=lambda c:(-c['relevance'],-c['score'],c['id']))
    candidates=candidates[:max(1,min(64,int(doc.get('limit',32))))]
    for rank,c in enumerate(candidates,1):c['rank']=rank
    arm_results={name:[{'id':i,'memoryId':by_id[i]['memoryId'],**signals[i],
                   'graphScore':graph_scores.get(i)} for i in ids] for name,ids in arm_ids.items()}
    selected={i for ids in arm_ids.values() for i in ids}
    return {'scope':doc['scope'],'query':text,'queryProjection':query,'tickWindow':window,'results':candidates,
        'arms':{k:len(v) for k,v in arm_ids.items()},'armResults':arm_results,
        'memoryArmResults':{k:[by_id[i]['memoryId'] for i in ids] for k,ids in arm_ids.items()},
        'graphSeeds':seeds,'expansionPaths':[p for p in paths if p['to'] in selected],'indexStats':idx['stats'],
        'rawScores':[{'id':i,'memoryId':by_id[i]['memoryId'],**s,'graphScore':graph_scores.get(i)} for i,s in signals.items()],
        'thresholds':{'semanticMin':semantic_min,'semanticLiftMin':lift_min,'keywordCoverageMin':coverage_min,'queryBackgroundMedian':background,
                      'status':'provisional experimental gate; not calibrated confidence'},
        'rejectedCount':len(signals)-len(good)}

def recall(doc):
    if doc.get('quality'): return recall_quality(doc)
    idx = doc['index']
    if idx['scope'] != doc['scope']: raise ValueError('index scope differs')
    units = idx['units']
    sources = check_mapping({**idx,'representations':[], 'facts':[], 'observations':[]},units)
    vectors = np.asarray(idx['vectors'],dtype=np.float32)
    if not units and idx['vectors']==[]:
        vectors = np.empty((0,int(idx['stats']['dimensions'])),dtype=np.float32)
    if vectors.ndim != 2 or vectors.shape[0] != len(units) or not np.isfinite(vectors).all():
        raise ValueError('invalid embedding matrix')
    query = doc['query']
    if not isinstance(query,str) or not query.strip(): raise ValueError('empty query')
    qv = np.asarray(doc['queryVector'],dtype=np.float32) if 'queryVector' in doc else encode([query],doc['scope'],True)[0]
    if qv.shape != (vectors.shape[1],) or not np.isfinite(qv).all() or np.linalg.norm(qv)==0:
        raise ValueError('invalid query embedding')
    norms = np.linalg.norm(vectors,axis=1)
    similarity = (vectors @ qv) / np.maximum(norms*np.linalg.norm(qv),1e-9)
    window = doc.get('tickWindow')
    if window is not None and (not isinstance(window.get('start'),int) or not isinstance(window.get('end'),int)
                               or window['start']<0 or window['start']>window['end']):
        raise ValueError('invalid tick window')
    by_id = {u['id']:u for u in units}
    def eligible(unit):
        # Apply this knowledge-time prefix/window to EVERY arm, including expanded neighbors.
        return window is None or all(window['start']<=sources[r['sourceId']]['knownTick']<=window['end']
                                     for r in unit['sourceRefs'])
    active = [i for i,u in enumerate(units) if eligible(u)]
    scores = {units[i]['id']:float(similarity[i]) for i in active}
    def row(unit, score=0.0):
        return {'id':unit['id'],'text':unit['text'],'fact_type':unit['kind'],
                'similarity':scores.get(unit['id'],0.0),'score':score}
    def result(unit, **kwargs):
        return RetrievalResult(id=unit['id'],text=unit['text'],fact_type=unit['kind'],**kwargs)
    order = sorted(active,key=lambda i:(-float(similarity[i]),units[i]['id']))
    semantic = [result(units[i],similarity=float(similarity[i])) for i in order
                if similarity[i]>=float(doc.get('semanticMin',0.3))][:32]
    # PostgreSQL BM25 is replaced by an in-memory BM25 over the preserved Chinese gram baseline.
    bags = {units[i]['id']:Counter(core.grams(units[i]['text'])) for i in active}
    q = core.grams(query)
    df = Counter(term for bag in bags.values() for term in bag)
    n = len(bags)
    average = sum(sum(b.values()) for b in bags.values())/max(n,1)
    bm = {}
    for ident,bag in bags.items():
        length = sum(bag.values())
        score = sum(math.log(1+(n-df[t]+0.5)/(df[t]+0.5))*bag[t]*2.5 /
                    (bag[t]+1.5*(0.25+0.75*length/max(average,1))) for t in q if bag[t])
        if score>0: bm[ident]=score
    bm25 = [result(by_id[i],bm25_score=s) for i,s in sorted(bm.items(),key=lambda p:(-p[1],p[0]))[:32]]
    edges = idx['links']
    for edge in edges:
        if len(edge)!=5 or edge[0] not in by_id or edge[1] not in by_id or edge[2] not in {'semantic','temporal'}:
            raise ValueError('invalid or foreign graph edge')
    seeds = [r.id for r in semantic[:int(doc.get('graphSeedLimit',20))]]
    seed_entities = set(e for ident in seeds for e in by_id[ident].get('entities',[]))
    entity_rows = []
    paths = []
    for ident in scores:
        shared = set(by_id[ident].get('entities',[])) & seed_entities
        if shared:
            entity_rows.append(row(by_id[ident],len(shared)))
            for parent in seeds:
                overlap = set(by_id[parent].get('entities',[])) & shared
                if parent != ident and overlap:
                    paths.append({'from':parent,'to':ident,'kind':'entity','entities':sorted(overlap)})
    semantic_rows = []
    for a,b,kind,weight,_ in edges:
        if kind!='semantic': continue
        for parent,target in ((a,b),(b,a)):
            if parent in seeds and target in scores:
                semantic_rows.append(row(by_id[target],weight))
                paths.append({'from':parent,'to':target,'kind':kind,'weight':weight})
    graph = merge_expansion_rows(SimpleNamespace(entity=entity_rows,semantic=semantic_rows,causal=[]),32)
    temporal = []
    if window is not None:
        pool = [{'id':u.id,'similarity':scores[u.id],
                 'occurred_start':None,'occurred_end':None,
                 'mentioned_at':ORIGIN+timedelta(hours=max(sources[r['sourceId']]['knownTick'] for r in by_id[u.id]['sourceRefs']))}
                for u in semantic]
        entries = _select_with_temporal_coverage(pool,ORIGIN+timedelta(hours=window['start']),
                  ORIGIN+timedelta(hours=window['end']),6,4)
        mid = (window['start']+window['end'])/2
        span = (window['end']-window['start'])/2
        temporal_scores = {}
        def proximity(ident):
            tick = max(sources[r['sourceId']]['knownTick'] for r in by_id[ident]['sourceRefs'])
            return 1-min(abs(tick-mid)/span,1) if span else 1.0
        frontier = []
        for entry in entries:
            ident = entry['id']
            temporal_scores[ident] = proximity(ident)
            frontier.append(ident)
        for _ in range(5):
            upcoming = []
            for parent in frontier:
                adjacent = sorted((e for e in edges if e[0]==parent and e[2]=='temporal'),key=lambda e:-e[3])[:10]
                for _,target,_,weight,_ in adjacent:
                    if target not in scores or target in temporal_scores or scores[target]<0.3: continue
                    # Original Hindsight temporal propagation decay, numerical tick domain.
                    propagated = temporal_scores[parent]*weight*0.7
                    combined = max(proximity(target),propagated)
                    temporal_scores[target]=combined
                    paths.append({'from':parent,'to':target,'kind':'temporal','weight':weight})
                    if combined>0.2: upcoming.append(target)
                    if len(temporal_scores)>=32: break
                if len(temporal_scores)>=32: break
            frontier = upcoming
            if not frontier or len(temporal_scores)>=32: break
        temporal = [result(by_id[i],similarity=scores[i],temporal_score=s) for i,s in
                    sorted(temporal_scores.items(),key=lambda p:(-p[1],-scores[p[0]],p[0]))]
    arms = {'semantic':semantic,'bm25':bm25,'graph':graph,'temporal':temporal}
    disabled = set(doc.get('disableArms',[]))
    for name in disabled:
        if name not in arms: raise ValueError('unknown retrieval arm')
        arms[name]=[]
    # Projection views vote once per memory per arm, never once per excerpt.
    # Legacy retrieval remains untouched for the frozen experimental controls.
    if doc.get('collapseByMemory'):
        grouped, matches = {}, {}
        for name, entries in arms.items():
            seen = set()
            grouped[name] = []
            for entry in entries:
                unit = by_id[entry.id]
                memory_id = unit['memoryId']
                matches.setdefault(memory_id, {})[entry.id] = unit
                if memory_id in seen: continue
                seen.add(memory_id)
                grouped[name].append(RetrievalResult(id=memory_id, text='', fact_type=unit['kind']))
        fused = reciprocal_rank_fusion(list(grouped.values()))
        candidates = []
        for candidate in fused[:max(1,min(64,int(doc.get('limit',32))))]:
            views = sorted(matches[candidate.id].values(), key=lambda u:(-scores[u['id']],u['id']))
            candidates.append({'id':candidate.id, 'score':candidate.rrf_score,
                'rank':candidate.rrf_rank, 'sourceRanks':candidate.source_ranks,
                'matches':[{'representationId':u['id'], 'atomIds':u.get('atomIds',[]),
                            'sourceRefs':u['sourceRefs'], 'semanticSimilarity':scores[u['id']]} for u in views]})
        return {'scope':doc['scope'],'query':query,'tickWindow':window,'results':candidates,
            'arms':{k:len(v) for k,v in arms.items()},
            'armResults':{k:[{'id':r.id,'memoryId':by_id[r.id]['memoryId'],'similarity':scores[r.id]} for r in v] for k,v in arms.items()},
            'memoryArmResults':{k:[r.id for r in v] for k,v in grouped.items()},
            'graphSeeds':seeds,'expansionPaths':paths,'indexStats':idx['stats']}
    fused = reciprocal_rank_fusion(list(arms.values()))
    selected = []
    obs_covered = set()
    fact_covered = set()
    atom_covered = set()
    limit = max(1,min(20,int(doc.get('limit',8))))
    for candidate in fused:
        unit = by_id[candidate.id]
        refs = {r['sourceId'] for r in unit['sourceRefs']}
        atom_ids = ({unit['id']} if unit.get('memoryLevel') == 'event_atom' else
                    set(unit.get('eventAtomIds',unit.get('sourceFactIds',[]))))
        if unit.get('memoryLevel'):
            if atom_ids and atom_ids <= atom_covered: continue
        else:
            if unit['kind']!='observation' and refs<=obs_covered: continue
            if unit['kind']=='representation' and refs<=fact_covered: continue
        selected.append({**unit,'score':candidate.rrf_score,'rank':candidate.rrf_rank,
                         'sourceRanks':candidate.source_ranks,'semanticSimilarity':scores[unit['id']]})
        if unit.get('memoryLevel'):
            atom_covered.update(atom_ids)
        else:
            if unit['kind']=='observation': obs_covered.update(refs)
            if unit['kind']=='fact': fact_covered.update(refs)
        if len(selected)>=limit: break
    return {'scope':doc['scope'],'query':query,'tickWindow':window,'results':selected,
            'arms':{k:len(v) for k,v in arms.items()},
            'armResults':{k:[{'id':r.id,'similarity':scores[r.id], 'bm25Score':r.bm25_score, 'temporalScore':r.temporal_score} for r in v] for k,v in arms.items()},
            'graphSeeds':seeds,'expansionPaths':paths,'indexStats':idx['stats']}

if __name__=='__main__':
    doc=json.load(sys.stdin)
    answer={'index':index,'recall':recall}[doc['operation']](doc)
    print(json.dumps(answer,ensure_ascii=False))
