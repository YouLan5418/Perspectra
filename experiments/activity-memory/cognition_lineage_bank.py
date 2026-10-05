"""Read-only connection to the frozen 20-item bank, no JEV changes."""
import copy
import json
import os
from pathlib import Path
import cognition_lineage as lineage
import observation_bank as bank

PROBES=('new-task','new-stop','familiar-control','same-person-unrelated','other-person-navigation')

def projected_entry(prepared, understanding, people):
    payload={'observationText':understanding['text'],'allowedPeople':people}
    facets=bank.bridge.utility_llm(bank.projection.PROMPT,json.dumps(payload,ensure_ascii=False),1400)
    bank.check_facets(facets,understanding['text'],people)
    aliases=prepared['index']['retrievalAliases']
    body=bank.retrieval_text.clean(understanding['text'],aliases)
    fields={f:bank.retrieval_text.clean('；'.join(facets[f]),aliases) for f in bank.FIELDS}
    if any(bank.bridge.projections.token_counter()(t)>220 for t in [body,*fields.values()]):
        raise ValueError('revised understanding search window too large')
    vectors=bank.bridge.vector_core.encode([body,*fields.values()],prepared['archive']['scope'])
    entry={'memoryId':understanding['id'],'facets':facets,'bodyText':body,'fieldTexts':fields,
           'bodyVector':vectors[0].tolist(),'fieldVectors':{f:v.tolist() for f,v in zip(bank.FIELDS,vectors[1:])},
           'sourceRefs':understanding['sourceRefs']}
    return entry,payload

def evaluate(prepared, baseline, request, tick, route):
    scores,latency=bank.trigger(prepared,baseline['query'])
    ids=[e['memoryId'] for e in prepared['entries']] if route=='all' else [
        r['memoryId'] for r in scores if r['subjectMatched']][:7]
    observations={o['id']:o for o in prepared['archive']['observations']}
    entries={e['memoryId']:e for e in prepared['entries']}
    query=baseline['query']
    stimulus={'text':query['originalText'],
              'actorIds':[e['id'] for e in query['entitySeeds'] if 'actor' in e['roles']],
              'mentionedIds':[e['id'] for e in query['entitySeeds'] if 'mentioned' in e['roles']]}
    decision=bank.jev.assess_many(stimulus,[{'memoryId':i,'understanding':observations[i]['text'],
                'applicability':entries[i]['facets']} for i in ids]) if ids else {'answers':{},'usage':{},'latencyMs':0}
    related=[i for i in ids if decision['answers'][i]['related']]
    ranked,delivered=bank.deliver(prepared,baseline,request,tick,related,{r['memoryId']:r for r in scores},route)
    return {'bankCount':len(prepared['entries']),'subjectEligibleCount':sum(r['subjectMatched'] for r in scores),
            'sentIds':ids,'relatedIds':related,'decision':decision,'scores':scores,
            'triggerLatencyMs':latency,'rankedIds':[r['id'] for r in ranked],
            'delivery':delivered,'relatedNotRead':[i for i in related if i not in {
                m['memoryId'] for m in delivered['memories']}]}

def run_bank(root, bank_root):
    root=Path(root);bank_root=Path(bank_root)
    if (root/'bank-update.json').exists():
        raise ValueError('bank experiment already exists; do not overwrite model results')
    lineage.save(root/'bank-input.json',{'bankRoot':str(bank_root.resolve())})
    frozen_files=list(bank_root.glob('*.json'))+list(bank_root.glob('*.jsonl'))
    before={p.name:__import__('hashlib').sha256(p.read_bytes()).hexdigest() for p in frozen_files}
    prepared=json.loads((bank_root/'facet-projection.json').read_text(encoding='utf-8'))
    if prepared['contentHash']!=lineage.digest({k:v for k,v in prepared.items() if k!='contentHash'}):
        raise ValueError('frozen bank mutated')
    archive=prepared['archive'];bank.bridge.episode.validate_units(archive)
    old=next(o for o in archive['observations'] if o['id']=='obs:1')
    newer=next(o for o in archive['observations'] if o['id']=='bank:04')
    evidence_before=lineage.digest({k:archive[k] for k in ('sources','facts','episodes')})
    os.environ['HCW_HINDSIGHT_UTILITY_TRACE']=str(root/'utility-calls.jsonl')
    # Replay the new-map evidence at tick20, before the opposed old-map belief at24.
    record=lineage.update(archive,old,newer['sourceFactIds'],'family:traveler-navigation',15,15,20)
    lineage.save(root/'bank-update.json',record)
    if record['relation']!='refinement':
        lineage.save(root/'bank-stop.json',{'reason':'new-map evidence was not classified as refinement; do not force merge'})
        return
    current=record['current'][0]
    people=prepared['generationInputs'][0]['allowedPeople']
    entry,generation_input=projected_entry(prepared,current,people)
    active=copy.deepcopy(prepared)
    active['archive']['observations'].append(current)
    active['entries']=[entry if e['memoryId']==old['id'] else e for e in active['entries'] if e['memoryId']!=newer['id']]
    active['contentHash']=lineage.digest({k:v for k,v in active.items() if k!='contentHash'})
    bank.bridge.episode.validate_units(active['archive'])
    lineage.save(root/'bank-current-projection.json',active)
    family={'familyId':record['familyId'],'derivedOnly':True,
            'currentVersionIds':[current['id'],'bank:10'],'historyOnlyIds':[old['id'],newer['id']],
            'revision':{old['id']:current['id']},
            'absorbedAspectIds':[newer['id']],'hasUnresolvedConflict':True,
            'note':'bank:04 is a complementary conditional aspect integrated after rereading its source, NOT an original historical version; bank:10 remains an opposed current branch. Family association is a controlled experiment input, not automatic discovery.'}
    lineage.save(root/'bank-family.json',family)
    os.environ['HCW_JEV_APPLICABILITY_TRACE']=str(root/'jev-calls.jsonl')
    matrix=[]
    for probe in PROBES:
        baseline=json.loads((bank_root/(probe+'-baseline-recall.json')).read_text(encoding='utf-8'))
        request=json.loads((bank_root/(probe+'-preview-request.json')).read_text(encoding='utf-8'))
        for route in ('all','trigger'):
            row={'probe':probe,'route':route}
            for label,data in [('flat',prepared),('current',active)]:
                result=evaluate(data,baseline,request,55,route)
                read={m['memoryId'] for m in result['delivery']['memories']}
                family_branches=[old['id'],'bank:10'] if label=='flat' else family['currentVersionIds']
                result['conflictBranchesRead']=[i for i in family_branches if i in read]
                result['bothConflictBranchesRead']=set(family_branches)<=read
                result['historicalVersionsCompeting']=sorted(read & {old['id'],newer['id']}) if label=='current' else []
                row[label]=result
            matrix.append(row)
            lineage.save(root/'bank-comparison.json',matrix)
            print(json.dumps({'probe':probe,'route':route,
                    'flatSent':len(row['flat']['sentIds']),'currentSent':len(row['current']['sentIds']),
                    'flatRelated':len(row['flat']['relatedIds']),'currentRelated':len(row['current']['relatedIds'])}),flush=True)
    # Explicit historical cognition query: history eligible in the same cheap retrieval and JEV path.
    historical=copy.deepcopy(active)
    historical['entries']=prepared['entries'] + [entry]
    baseline=json.loads((bank_root/'new-task-baseline-recall.json').read_text(encoding='utf-8'))
    text='你以前对旅人在陌生地方带路、使用旧地图是怎么看的？后来你的认识有没有改变？'
    query=baseline['query'];aliases=prepared['index']['retrievalAliases']
    clean=bank.retrieval_text.clean(text,aliases)
    query.update(originalText=text,semanticQuery=clean,keywordText=clean,
                 keywordTerms=bank.bridge.queries.lexical_terms(clean),
                 cognitionQueryMode='historical')
    result=evaluate(historical,baseline,json.loads((bank_root/'new-task-preview-request.json').read_text(encoding='utf-8')),55,'trigger')
    result.update(query=query,oldVersionFound=old['id'] in result['sentIds'],
                  oldVersionRelated=old['id'] in result['relatedIds'],
                  oldVersionRead=old['id'] in {m['memoryId'] for m in result['delivery']['memories']})
    lineage.save(root/'historical-query.json',result)
    after={p.name:__import__('hashlib').sha256(p.read_bytes()).hexdigest() for p in frozen_files}
    summary={'flatActiveCount':20,'currentActiveCount':len(active['entries']),
             'evidenceUnchanged':evidence_before==lineage.digest({k:archive[k] for k in ('sources','facts','episodes')}),
             'frozenFilesUnchanged':before==after,'family':family,'projectionGenerationInput':generation_input,
             'historical':{k:result[k] for k in ('oldVersionFound','oldVersionRelated','oldVersionRead')},
             'limits':['one known update pair and manual family association','one draw per probe/route/version; no causal quality estimate',
                       'no new Character Turns','no automated history-intent detection',
                       'one complementary aspect absorbed; other similar beliefs not merged']}
    for route in ('all','trigger'):
        rows=[r for r in matrix if r['route']==route]
        summary[route]={label:{
            'sent':sum(len(r[label]['sentIds']) for r in rows),
            'related':sum(len(r[label]['relatedIds']) for r in rows),
            'relatedNotRead':sum(len(r[label]['relatedNotRead']) for r in rows),
            'bothConflictBranchesRead':sum(r[label]['bothConflictBranchesRead'] for r in rows[:3]),
            'jevCostUsd':sum(r[label]['decision']['usage'].get('cost',0) for r in rows),
        } for label in ('flat','current')}
    lineage.save(root/'bank-summary.json',summary)

if __name__=='__main__':
    run_bank(Path(__import__('sys').argv[1]),Path(__import__('sys').argv[2]))
