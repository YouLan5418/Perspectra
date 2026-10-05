"""Retrieval-only lineage ablations over frozen character-owned archives."""
import copy
import json
import math
import os
import random
import sys
from collections import Counter
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parent))
import cognition_lineage as lineage
import observation_bank as bank

FIELDS=bank.FIELDS
STAGES=('A-current','B-continuity','C-scenarios','D-families')
CONTINUITY_PROMPT="""Update SEARCH-ONLY facets for one revised subjective understanding.
Inputs are oldUnderstanding, currentUnderstanding, oldFacets and revisionRelation; no stimuli.
Return JSON {"subjects":[{"name":"...","characterId":"..."}],
"retained":{"contexts":[],"conditions":[],"exceptions":[],"themes":[]},
"removed":{"contexts":[],"conditions":[],"exceptions":[],"themes":[]},
"added":{"contexts":[],"conditions":[],"exceptions":[],"themes":[]}}.
Partition EVERY old phrase verbatim into retained or removed. Retain still applicable contexts,
themes and exceptions even if the new understanding changed wording. Remove invalidated scopes,
subjects or conditions; do not keep a superseded judgment as a current fact.
Added phrases must describe contexts/conditions/exceptions/themes supported by the CURRENT body.
These are search hints only, not assertions, evidence or behavior instructions. No test questions,
imagined events, causal explanations or motives. Keep total retained+added phrases <=8 per field.
Subjects must be explicitly named in currentUnderstanding and present in allowedPeople.
"""
SCENARIO_PROMPT="""Derive SHORT SEARCH SITUATIONS independently for each subjective understanding.
Return JSON {"items":[{"memoryId":"...","scenarios":[{"kind":"context|condition|exception",
"text":"concise Chinese situational phrase"}]}]}.
Use each item's currentUnderstanding and retrievalFacets only. Describe WHEN it could be recalled,
not WHAT IS TRUE nor what the character should do. Preserve distinct contexts, prerequisites and
exceptions in separate short situations; <=4 situations per understanding, <=70 characters each.
No hypothetical stimuli, dialogue, evidence, motives or action recommendations.
Use ordinary synonyms where useful, never add unsupported contexts. Do not combine the items.
"""

def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))

def hashes(root):
    import hashlib
    return {p.name:hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(Path(root).iterdir()) if p.is_file() and p.suffix in {'.json','.jsonl'}}

def check(prepared):
    if prepared['contentHash']!=lineage.digest({k:v for k,v in prepared.items() if k!='contentHash'}):
        raise ValueError('frozen prepared archive changed')
    bank.bridge.episode.validate_units(prepared['archive'])
    by_id={o['id']:o for o in prepared['archive']['observations']}
    if len({e['memoryId'] for e in prepared['entries']})!=len(prepared['entries']):
        raise ValueError('duplicate projection IDs')
    for e in prepared['entries']:
        unit=by_id.get(e['memoryId'])
        if unit is None or e['sourceRefs']!=unit['sourceRefs']:
            raise ValueError('projection crosses evidence mapping')
    if prepared['index']['retrievalAliases']['scope']!=prepared['archive']['scope']:
        raise ValueError('alias scope changed')

def continuity_answer(answer, old_entry, current, people):
    if set(answer)!={'subjects','retained','removed','added'}:
        raise ValueError('invalid continuity shape')
    fields={}
    for key in ('retained','removed','added'):
        if set(answer[key])!=set(FIELDS):
            raise ValueError('invalid continuity fields')
    for field in FIELDS:
        old=old_entry['facets'][field]
        retained,removed,added=(answer[k][field] for k in ('retained','removed','added'))
        for values in (retained,removed,added):
            if not isinstance(values,list) or len(values)!=len(set(values)) or any(
                not isinstance(v,str) or not v.strip() or len(v)>60 for v in values):
                raise ValueError('invalid continuity phrases')
        if set(retained)&set(removed) or set(retained+removed)!=set(old):
            raise ValueError('old phrases not partitioned exactly')
        fields[field]=list(dict.fromkeys(retained+added))
        if len(fields[field])>8:
            raise ValueError('continuity phrase budget exceeded')
    facets={'subjects':answer['subjects'],**fields}
    # Reuse identity checks; original validator caps6, so check shape at <=6 per chunk.
    for field in FIELDS:
        for offset in range(0,max(1,len(facets[field])),6):
            probe={**facets,**{f:facets[f][:6] for f in FIELDS},field:facets[field][offset:offset+6]}
            bank.check_facets(probe,current['text'],people)
    return facets

def entry_for(prepared,unit,facets):
    aliases=prepared['index']['retrievalAliases']
    body=bank.retrieval_text.clean(unit['text'],aliases)
    fields={f:bank.retrieval_text.clean('；'.join(facets[f]),aliases) for f in FIELDS}
    texts=[body,*fields.values()]
    if any(bank.bridge.projections.token_counter()(t)>220 for t in texts):
        raise ValueError('search text exceeds unchanged encoder budget')
    vectors=bank.bridge.vector_core.encode(texts,prepared['archive']['scope'])
    return {'memoryId':unit['id'],'facets':facets,'bodyText':body,'fieldTexts':fields,
            'bodyVector':vectors[0].tolist(),'fieldVectors':{f:v.tolist() for f,v in zip(FIELDS,vectors[1:])},
            'sourceRefs':unit['sourceRefs']}

def prepare(active, original, family, revision):
    check(active);check(original)
    by_id={o['id']:o for o in active['archive']['observations']}
    target=revision['current'][0]
    if by_id.get(target['id'])!=target:
        raise ValueError('revision object is not canonical')
    old=revision['versions'][0]
    original_obs={o['id']:o for o in original['archive']['observations']}
    if original_obs.get(old['id'])!=old:
        raise ValueError('old understanding is not canonical')
    for key in ('sources','facts','episodes'):
        if original['archive'][key]!=active['archive'][key]:
            raise ValueError('frozen evidence changed')
    if set(family['currentVersionIds'])!={target['id'],'bank:10'} or old['id'] not in family['historyOnlyIds']:
        raise ValueError('invalid controlled family association')
    people=original['generationInputs'][0]['allowedPeople']
    old_entry=next(e for e in original['entries'] if e['memoryId']==old['id'])
    payload={'oldUnderstanding':old['text'],'currentUnderstanding':target['text'],
             'oldFacets':old_entry['facets'],'revisionRelation':revision['relation'],'allowedPeople':people}
    answer=bank.bridge.utility_llm(CONTINUITY_PROMPT,json.dumps(payload,ensure_ascii=False),3000)
    facets=continuity_answer(answer,old_entry,target,people)
    continuity=copy.deepcopy(active)
    target_entry=entry_for(active,target,facets)
    continuity['entries']=[target_entry if e['memoryId']==target['id'] else e for e in active['entries']]
    continuity['contentHash']=lineage.digest({k:v for k,v in continuity.items() if k!='contentHash'})
    scenarios=copy.deepcopy(continuity)
    generation=[{'prompt':CONTINUITY_PROMPT,'input':payload,'answer':answer}]
    pending=[{'memoryId':e['memoryId'],'currentUnderstanding':by_id[e['memoryId']]['text'],
              'retrievalFacets':e['facets']} for e in continuity['entries']]
    by_scenario={}
    for offset in range(0,len(pending),5):
        payload={'items':pending[offset:offset+5]}
        result=bank.bridge.utility_llm(SCENARIO_PROMPT,json.dumps(payload,ensure_ascii=False),3500)
        generation.append({'prompt':SCENARIO_PROMPT,'input':payload,'answer':result})
        expected={i['memoryId'] for i in payload['items']}
        if set(result)!={'items'} or len(result['items'])!=len(expected) or {r['memoryId'] for r in result['items']}!=expected:
            raise ValueError('scenario batch lost or duplicated an understanding')
        for item in result['items']:
            rows=item['scenarios']
            if not isinstance(rows,list) or not 1<=len(rows)<=4 or len({r['text'] for r in rows})!=len(rows):
                raise ValueError('invalid scenario budget')
            if any(set(r)!={'text','kind'} or r['kind'] not in {'context','condition','exception'} or
                   not isinstance(r['text'],str) or not r['text'].strip() or len(r['text'])>70 for r in rows):
                raise ValueError('invalid search scenario')
            clean=[bank.retrieval_text.clean(r['text'],active['index']['retrievalAliases']) for r in rows]
            if any(not t or bank.bridge.projections.token_counter()(t)>100 for t in clean):
                raise ValueError('empty or overlong scenario')
            vectors=bank.bridge.vector_core.encode(clean,active['archive']['scope'])
            by_scenario[item['memoryId']]=[{**r,'retrievalText':t,'vector':v.tolist()}
                       for r,t,v in zip(rows,clean,vectors)]
    for entry in scenarios['entries']:
        entry['scenarios']=by_scenario[entry['memoryId']]
    scenarios['contentHash']=lineage.digest({k:v for k,v in scenarios.items() if k!='contentHash'})
    return {'A-current':active,'B-continuity':continuity,
            'C-scenarios':scenarios,'D-families':scenarios},generation

def groups(prepared,family,family_mode=False,history=False):
    entries={e['memoryId']:e for e in prepared['entries']}
    out=[]
    for entry in prepared['entries']:
        ident=entry['memoryId']
        if family_mode and ident in family['currentVersionIds']:
            if any(g['groupId']==family['familyId'] for g in out):continue
            out.append({'groupId':family['familyId'],'entries':[entries[i] for i in family['currentVersionIds']],
                        'readingIds':family['currentVersionIds'].copy()})
        else:
            out.append({'groupId':ident,'entries':[entry],'readingIds':[ident]})
    if history:
        if not family_mode:
            raise ValueError('history requires controlled family grouping')
        old_ids=family['revision'].keys()
        for group in out:
            if group['groupId']==family['familyId']:
                # Old/new revision endpoints, then the other current branch. Complementary bank04 is not a version.
                group['readingIds']=list(old_ids)+group['readingIds']
    return out

def rank(prepared,query,family,family_mode=False,scenario_mode=False,history=False):
    rows=groups(prepared,family,family_mode,history)
    qv=bank.bridge.vector_core.encode([query['semanticQuery']],prepared['archive']['scope'],True)[0]
    seeds={e['id'] for e in query['entitySeeds'] if set(e['roles'])&{'actor','mentioned'}}
    terms=set(query['keywordTerms']);bags={}
    def cosine(v):
        v=np.asarray(v,dtype=np.float32)
        return float(v@qv/max(np.linalg.norm(v)*np.linalg.norm(qv),1e-9))
    for group in rows:
        group['subjectIds']=sorted({s['characterId'] for e in group['entries'] for s in e['facets']['subjects']})
        group['subjectMatched']=bool(seeds & set(group['subjectIds']))
        group['matchedSubjectIds']=sorted(seeds & set(group['subjectIds']))
        signals=[];entry_bags=[]
        for entry in group['entries']:
            signals.append({'memoryId':entry['memoryId'],'representationId':'body','kind':'body',
                            'cosine':cosine(entry['bodyVector'])})
            if scenario_mode:
                signals.extend({'memoryId':entry['memoryId'],'representationId':'scenario:'+str(i),
                                'kind':s['kind'],'text':s['text'],'cosine':cosine(s['vector'])}
                                for i,s in enumerate(entry['scenarios']))
                texts=[s['retrievalText'] for s in entry['scenarios']]
            else:
                signals.extend({'memoryId':entry['memoryId'],'representationId':f,'kind':f,
                                'cosine':cosine(entry['fieldVectors'][f])}
                                for f in FIELDS if entry['fieldTexts'][f])
                texts=list(entry['fieldTexts'].values())
            # A lexical term receives one presence per understanding; variant/scenario count cannot amplify TF.
            entry_bags.append(Counter({t:1 for t in bank.bridge.queries.lexical_terms(entry['bodyText']+' '+' '.join(texts))}))
        bags[group['groupId']]=Counter({t:max(b[t] for b in entry_bags) for t in set().union(*entry_bags)})
        group['signals']=signals;group['winningRepresentation']=max(signals,key=lambda s:s['cosine'])
        group['semanticSimilarity']=group['winningRepresentation']['cosine']
    df=Counter(t for b in bags.values() for t in b)
    n=len(rows);average=sum(sum(b.values()) for b in bags.values())/max(n,1)
    for group in rows:
        bag=bags[group['groupId']]
        matched=sorted(t for t in terms if bag[t])
        group['matchedTerms']=matched
        group['bm25Score']=sum(math.log(1+(n-df[t]+.5)/(df[t]+.5))*bag[t]*2.5/
                      (bag[t]+1.5*(.25+.75*sum(bag.values())/max(average,1))) for t in matched)
    eligible=[r for r in rows if r['subjectMatched']]
    semantic=sorted(eligible,key=lambda r:(-r['semanticSimilarity'],r['groupId']))
    lexical=sorted([r for r in eligible if r['bm25Score']>0],key=lambda r:(-r['bm25Score'],r['groupId']))
    sr={r['groupId']:i+1 for i,r in enumerate(semantic)}
    br={r['groupId']:i+1 for i,r in enumerate(lexical)}
    for row in rows:
        row.update(semanticRank=sr.get(row['groupId']),bm25Rank=br.get(row['groupId']),
                   rrfScore=(1/(60+sr[row['groupId']]) if row['groupId'] in sr else 0)+
                            (1/(60+br[row['groupId']]) if row['groupId'] in br else 0))
        row.pop('entries')
    return sorted(rows,key=lambda r:(-r['rrfScore'],-r['semanticSimilarity'],r['groupId']))

def shortlist(rows,budget=7):
    ids=[];selected=[];rejected=[]
    for row in rows:
        if not row['subjectMatched']:continue
        if len(ids)+len(row['readingIds'])>budget:
            rejected.append({'groupId':row['groupId'],'reason':'whole-group candidate budget'})
            continue
        ids.extend(row['readingIds']);selected.append(row['groupId'])
    return ids,selected,rejected

def evaluate(prepared,query,request,baseline,rows,ids):
    scope=prepared['archive']['scope'];context=request['context']
    if context.get('character',{}).get('characterId')!=scope['characterId'] or context.get('cognition',{}).get('address',scope['worldAddress'])!=scope['worldAddress']:
        raise ValueError('retrieval request crosses character or world before JEV')
    check(prepared)
    observations={o['id']:o for o in prepared['archive']['observations']}
    entries={e['memoryId']:e for e in prepared['entries']}
    stimulus={'text':query['originalText'],
              'actorIds':[e['id'] for e in query['entitySeeds'] if 'actor' in e['roles']],
              'mentionedIds':[e['id'] for e in query['entitySeeds'] if 'mentioned' in e['roles']]}
    candidates=[{'memoryId':i,'understanding':observations[i]['text'],'applicability':entries[i]['facets']} for i in ids]
    decision=bank.jev.assess_many(stimulus,candidates) if ids else {'answers':{},'usage':{},'latencyMs':0}
    related=[i for i in ids if decision['answers'][i]['related']]
    scores={i:row for row in rows for i in row['readingIds']}
    base={**baseline,'query':copy.deepcopy(query)}
    # Delivery is unchanged; family members inherit one shared score, not extra fusion votes.
    ranked,delivered=bank.deliver(prepared,base,request,55,related,scores,'lineage')
    return {'stimulus':stimulus,'sentIds':ids,'decision':decision,'relatedIds':related,
            'rankedIds':[c['id'] for c in ranked],'delivery':delivered}

def run(root,bank_root,lineage_root):
    root=Path(root);bank_root=Path(bank_root);lineage_root=Path(lineage_root)
    if root.exists():raise ValueError('fresh output directory required')
    root.mkdir(parents=True)
    frozen={str(p.resolve()):hashes(p) for p in (bank_root,lineage_root)}
    original=load(bank_root/'facet-projection.json')
    active=load(lineage_root/'bank-current-projection.json')
    family=load(lineage_root/'bank-family.json');revision=load(lineage_root/'bank-update.json')
    protocol={'bankRoot':str(bank_root.resolve()),'lineageRoot':str(lineage_root.resolve()),
              'stages':list(STAGES),'repeats':3,'candidateBudget':7,'deliveryBudget':3,
              'fixed':['current bodies','Source/Atom/Episode','encoder E5 int8','queries','JEV protocol','existing Delivery'],
              'labels':'original predeclared exploratory bank labels; not human gold',
              'familyAssociation':'frozen controlled family, no automatic family discovery',
              'historyMode':'explicit request metadata; old/new endpoints from frozen revision links',
              'lexicalAblation':'A/B existing BM25 term frequencies; C/D binary lexical presence, one term vote despite scenarios/branches',
              'frozenInputs':frozen,'continuityPrompt':CONTINUITY_PROMPT,'scenarioPrompt':SCENARIO_PROMPT}
    lineage.save(root/'protocol.json',protocol)
    os.environ['HCW_HINDSIGHT_UTILITY_TRACE']=str(root/'utility-calls.jsonl')
    prepared,generation=prepare(active,original,family,revision)
    lineage.save(root/'projection-generation.json',generation)
    lineage.save(root/'prepared.json',prepared)
    baseline_by_probe={};request_by_probe={};rankings={}
    for probe in ('new-task','new-stop','familiar-control','same-person-unrelated','other-person-navigation'):
        baseline=load(bank_root/(probe+'-baseline-recall.json'));request=load(bank_root/(probe+'-preview-request.json'))
        query=bank.bridge.queries.project(request,active['index']['retrievalAliases'])
        if any(query[k]!=baseline['query'][k] for k in ('semanticQuery','keywordTerms','entitySeeds','originalText')):
            raise ValueError('frozen stimulus query changed')
        baseline_by_probe[probe]=baseline;request_by_probe[probe]=request
        for stage in STAGES:
            if stage in STAGES[:2]:
                raw,_=bank.trigger(prepared[stage],query)
                rows=[{**r,'groupId':r['memoryId'],'readingIds':[r['memoryId']]} for r in raw]
            else:
                rows=rank(prepared[stage],query,family,family_mode=stage=='D-families',scenario_mode=True)
            ids,selected,rejected=shortlist(rows)
            rankings[(probe,stage)]={'query':query,'rows':rows,'sentIds':ids,'selectedGroups':selected,'budgetRejected':rejected}
    lineage.save(root/'rankings.json',[{'probe':p,'stage':s,**v} for (p,s),v in rankings.items()])
    os.environ['HCW_JEV_APPLICABILITY_TRACE']=str(root/'jev-calls.jsonl')
    results=[]
    for repeat in range(3):
        order=list(STAGES);random.Random(20261004+repeat).shuffle(order)
        for probe in baseline_by_probe:
            for stage in order:
                ranked=rankings[(probe,stage)]
                result=evaluate(prepared[stage],ranked['query'],request_by_probe[probe],
                         baseline_by_probe[probe],ranked['rows'],ranked['sentIds'])
                row={'probe':probe,'stage':stage,'repeat':repeat,**result}
                results.append(row);lineage.save(root/'results.json',results)
                print(json.dumps({'probe':probe,'stage':stage,'repeat':repeat,'sent':len(result['sentIds']),
                      'related':result['relatedIds'],'read':[m['memoryId'] for m in result['delivery']['memories']]}),flush=True)
    # Search current families first; only a matched family opens its old/new endpoints.
    historical=copy.deepcopy(prepared['D-families'])
    old_entry=next(e for e in original['entries'] if e['memoryId']==revision['revisedFrom'][0])
    historical['entries'].append(copy.deepcopy(old_entry))
    historical['contentHash']=lineage.digest({k:v for k,v in historical.items() if k!='contentHash'})
    request=copy.deepcopy(request_by_probe['new-task'])
    text='你以前对旅人在陌生地方带路、使用旧地图是怎么看的？后来你的认识有没有改变？'
    request['context']['stimulus'][0]['content']['speech']['text']=text
    query=bank.bridge.queries.project(request,active['index']['retrievalAliases'])
    query['cognitionQueryMode']='historical'
    rows=rank(prepared['D-families'],query,family,family_mode=True,scenario_mode=True,history=True)
    ids,selected,rejected=shortlist(rows)
    history=[]
    for repeat in range(3):
        result=evaluate(historical,query,request,baseline_by_probe['new-task'],rows,ids)
        history.append({'repeat':repeat,'query':query,'rows':rows,'selectedGroups':selected,
                        'budgetRejected':rejected,**result})
        lineage.save(root/'historical-results.json',history)
    after={str(p.resolve()):hashes(p) for p in (bank_root,lineage_root)}
    if after!=frozen:raise ValueError('frozen experiment inputs changed')
    lineage.save(root/'frozen-check.json',{'unchanged':True,'before':frozen,'after':after})

if __name__=='__main__':
    run(*sys.argv[1:4])
