"""Disposable complete-reading groups over frozen Delivery/JEV artifacts."""
import copy
import json
import sys
from pathlib import Path
from unittest.mock import patch
import delivery_order as order_exp
import lineage_retrieval as exp

MODES=('related_probability','history_pairs','history_and_conflict')

def evidence_keys(trace,by_id,sources):
    return {exp.bank.bridge.projections.evidence_key(by_id[i],sources) for i in trace['coveredAtomIds']}

def bundle(doc,candidate,request,tick,query):
    """Materialize with existing rules; only final allocator owns the real budget."""
    by_id,sources=exp.bank.bridge.projections.archive(doc)
    count=max(1,len(by_id)*3+3)
    char_limit=max(4500,len(json.dumps(doc,ensure_ascii=False))*count*3)
    delivered=exp.bank.bridge.activity.deliver(doc,[candidate],request,tick,copy.deepcopy(query),
                                               max_items=count,max_json_chars=char_limit)
    if any('budget' in r.get('reason','') for r in delivered['trace']['omitted']):
        raise ValueError('incomplete group materialization')
    rows=[{'item':copy.deepcopy(item),'trace':copy.deepcopy(trace)}
          for item,trace in zip(delivered['memories'],delivered['trace']['delivered'])]
    # Validate that every not-already-observed counter is included if its summary is exposed.
    recent={int(o['sourceSeq']) for o in request['context'].get('observations',[])+
            request['context'].get('selfObservations',[])}
    keys=set().union(*(evidence_keys(r['trace'],by_id,sources) for r in rows))
    unit=by_id[candidate['id']]
    if any(r['item']['memoryId']==unit['id'] and r['item']['memoryLevel']=='observation' for r in rows):
        missing=[i for i in unit['contradictingAtomIds'] if by_id[i]['sourceRefs'][0]['worldSeq'] not in recent
                 and exp.bank.bridge.projections.evidence_key(by_id[i],sources) not in keys]
        if missing:raise ValueError('full projection lost required counterevidence')
    return rows

def make_groups(candidates,decision,family,mode,historical):
    if mode not in MODES[1:]:raise ValueError('unknown grouped policy')
    ranked=order_exp.order(candidates,decision)
    by_id={c['id']:c for c in ranked}
    sets=[]
    if historical:
        for old,current in family['revision'].items():
            if old in by_id and current in by_id:
                sets.append({'kind':'historical_revision','memberIds':[old,current]})
    if mode=='history_and_conflict':
        current=[i for i in family['currentVersionIds'] if i in by_id]
        if family['hasUnresolvedConflict'] and len(current)>1:
            sets.append({'kind':'unresolved_current_conflict','memberIds':current})
    # Overlapping declared dependencies merge, never create duplicate competing groups.
    groups=[]
    for row in sets:
        matching=[g for g in groups if set(g['memberIds']) & set(row['memberIds'])]
        if matching:
            merged=matching[0]
            merged['memberIds']=list(dict.fromkeys(merged['memberIds']+row['memberIds']))
            merged['kinds'].append(row['kind'])
            for extra in matching[1:]:
                merged['memberIds']=list(dict.fromkeys(merged['memberIds']+extra['memberIds']))
                merged['kinds']+=extra['kinds'];groups.remove(extra)
        else:groups.append({'memberIds':row['memberIds'],'kinds':[row['kind']]})
    grouped={i for g in groups for i in g['memberIds']}
    groups += [{'memberIds':[c['id']],'kinds':['single']} for c in ranked if c['id'] not in grouped]
    positions={c['id']:i for i,c in enumerate(ranked)}
    for group in groups:
        group['groupId']='reading:'+ '|'.join(group['memberIds'])
        group['priorityRank']=min(positions[i] for i in group['memberIds'])
        group['relatedProbability']=max((decision['answers'][i]['probabilities']['RELATED']
            for i in group['memberIds'] if i in decision['answers']),default=None)
        if 'historical_revision' not in group['kinds']:
            group['memberIds'].sort(key=lambda i:positions[i])
    return sorted(groups,key=lambda g:(g['priorityRank'],g['groupId']))

def allocate(doc,groups,packages,max_items=3,max_json_chars=4500):
    by_id,sources=exp.bank.bridge.projections.archive(doc)
    selected=[];covered=set();read_observations=set();omitted=[];group_traces=[]
    for group in groups:
        pending=[];pending_keys=set();pending_observations=set()
        for ident in group['memberIds']:
            for row in packages[ident]:
                item=row['item'];trace=row['trace'];keys=evidence_keys(trace,by_id,sources)
                observation=item['memoryLevel']=='observation'
                if (observation and item['memoryId'] in read_observations | pending_observations) or (
                    not observation and keys and keys <= covered | pending_keys):
                    continue
                pending.append(copy.deepcopy(row))
                pending_keys |= keys
                if observation:pending_observations.add(item['memoryId'])
        trial=[r['item'] for r in selected+pending]
        group_trace={**group,'requiredItemsBeforeSharedDedup':sum(len(packages[i]) for i in group['memberIds']),
                     'additionalItems':len(pending),'trialJsonChars':exp.bank.bridge.projections.chars(trial)}
        if len(trial)>max_items or group_trace['trialJsonChars']>max_json_chars:
            omitted.append({**group_trace,'reason':'whole reading group exceeds remaining actual item/character budget'})
            continue
        selected += pending;covered |= pending_keys;read_observations |= pending_observations
        group_traces.append(group_trace)
    memories=[r['item'] for r in selected]
    for row in selected:
        item=row['item']
        if item['memoryLevel']=='observation':
            unit=by_id[item['memoryId']]
            if item['text']!=unit['text']:raise ValueError('understanding body changed')
    return {'memories':memories,'trace':{'scope':doc['scope'],'delivered':[r['trace'] for r in selected],
        'readingGroups':group_traces,'omitted':omitted,'distinctEvidenceSegments':len(covered),
        'jsonChars':exp.bank.bridge.projections.chars(memories),
        'budget':{'maxItems':max_items,'maxJsonChars':max_json_chars,
                  'allocation':'complete reading groups, actual items counted; final clipping once'}}}

def deliver(doc,candidates,decision,request,tick,query,family,mode,max_items=3,max_json_chars=4500):
    order_exp.scope_check({'archive':doc},request)
    exp.bank.bridge.projections.archive(doc)
    if any(s['knownTick']>tick for s in doc['sources']):raise ValueError('future knowledge tick')
    historical=query.get('cognitionQueryMode')=='historical'
    groups=make_groups(candidates,decision,family,mode,historical)
    packages={c['id']:bundle(doc,c,request,tick,query) for c in candidates}
    result=allocate(doc,groups,packages,max_items,max_json_chars)
    by_id,sources=exp.bank.bridge.projections.archive(doc)
    recent={int(o['sourceSeq']) for o in request['context'].get('observations',[])+request['context'].get('selfObservations',[])}
    keys=set().union(*(evidence_keys(t,by_id,sources) for t in result['trace']['delivered']))
    for item in result['memories']:
        if item['memoryLevel']=='observation':
            missing=[i for i in by_id[item['memoryId']]['contradictingAtomIds']
                if by_id[i]['sourceRefs'][0]['worldSeq'] not in recent and
                exp.bank.bridge.projections.evidence_key(by_id[i],sources) not in keys]
            if missing:raise ValueError('final clipping separated summary from counterevidence')
    result['trace']['materializedGroups']=[{**g,'itemCounts':[len(packages[i]) for i in g['memberIds']]} for g in groups]
    return result

def simple_decision(units):
    # Synthetic mechanical control only, not JEV judgments or calibrated scores.
    return {'answers':{u['id']:{'choice':'RELATED','related':True,
                               'probabilities':{'RELATED':.9-i*.05}} for i,u in enumerate(units)}}

def counter_controls(lineage_root):
    results=[]
    from audit_cognition_lineage import candidates
    for case in ('C','D'):
        for repeat in range(3):
            archive=exp.load(lineage_root/('case-'+case+'-archive.json'))
            record=exp.load(lineage_root/('case-'+case+'-repeat-'+str(repeat)+'.json'))['record']
            doc=copy.deepcopy(archive);doc['observations']+=record['current']
            request={'context':{'character':{'characterId':doc['scope']['characterId']},
                               'observations':[],'selfObservations':[]}}
            units=record['current'];cs=candidates(units);decision=simple_decision(units)
            family={'revision':{},'currentVersionIds':[u['id'] for u in units],
                    'hasUnresolvedConflict':record['hasUnresolvedConflict']}
            grouped=deliver(doc,cs,decision,request,55,{'originalText':''},family,'history_and_conflict')
            diagnostic=deliver(doc,cs,decision,request,55,{'originalText':''},family,'history_and_conflict',max_items=12)
            results.append({'case':case,'repeat':repeat,'syntheticApplicabilityScores':True,
                'defaultBudget':grouped,'largerBudgetDiagnosticOnly':diagnostic})
    return results

def anchor_control():
    """Reproduce actual post-projection anchor clipping of a required counter."""
    bridge=exp.bank.bridge
    address={'tenantId':'synthetic','worldId':'counter-anchor','branchId':'control'}
    sources=[]
    for seq,kind,text in (
        (1,'observed_action',json.dumps({'actorId':'character:host','status':'accepted','actionType':'interact',
             'resultDescription':'Synthetic game started','resultMetadata':{'activity':{'id':'activity:control',
             'revision':1,'phase':'started','round':1,'active':True,'lifecycle':'started'}}})),
        (2,'observed_action',json.dumps({'actorId':'character:host','status':'accepted','actionType':'interact',
             'resultDescription':'Synthetic game ended','resultMetadata':{'activity':{'id':'activity:control',
             'revision':2,'phase':'ended','round':2,'active':False,'lifecycle':'ended'}}})),
        (3,'direct_observation','Synthetic independently witnessed counterevidence')):
        sources.append({'sourceId':'synthetic:anchor:'+str(seq),'sourceHash':'sha256:'+exp.lineage.digest(text),
            'epistemicKind':kind,'worldSeq':seq,'knownTick':seq,'characterId':'character:npc',
            'worldAddress':address,'text':text})
    scope={'characterId':'character:npc','worldAddress':address,'asOfWorldSeq':3}
    facts=[bridge.episode.make_atom(source,part,part['context'],number)
           for source in sources for number,part in enumerate(bridge.episode.segments(source))]
    doc={'scope':scope,'sources':sources,'facts':bridge.timed(facts,sources),'episodes':[],'observations':[]}
    unit=exp.lineage.observation(doc,'synthetic:anchor:observation','Synthetic revisable game understanding',
                                 [doc['facts'][0]['id']],[doc['facts'][2]['id']])
    doc['observations']=[unit]
    request={'context':{'character':{'characterId':'character:npc'},'observations':[],'selfObservations':[]}}
    candidate={'id':unit['id'],'relevance':.03,'score':.9,
               'matches':[{'atomIds':unit['sourceFactIds'],'sourceRefs':unit['sourceRefs']}]}
    runtime=bridge.activity.deliver(doc,[candidate],request,10,{'originalText':''})
    new=deliver(doc,[candidate],simple_decision([unit]),request,10,{'originalText':''},
                {'revision':{},'currentVersionIds':[unit['id']],'hasUnresolvedConflict':False},'history_pairs')
    larger=deliver(doc,[candidate],simple_decision([unit]),request,10,{'originalText':''},
                {'revision':{},'currentVersionIds':[unit['id']],'hasUnresolvedConflict':False},'history_pairs',max_items=4)
    return {'scope':'synthetic boundary control, not a played trajectory','archive':doc,
            'counterAtomId':doc['facts'][2]['id'],'summaryId':unit['id'],
            'runtimeDelivery':runtime,'groupedDelivery':new,'largerBudgetDiagnosticOnly':larger}

def run(output,order_root):
    output=Path(output);order_root=Path(order_root)
    if output.exists():raise ValueError('fresh output directory required')
    op=exp.load(order_root/'protocol.json');root=Path(op['inputRoot'])
    frozen_paths=[order_root,*map(Path,op['frozenInputs'])]
    frozen={str(p.resolve()):exp.hashes(p) for p in frozen_paths}
    if any(frozen[str(Path(p).resolve())]!=v for p,v in op['frozenInputs'].items()):
        raise ValueError('frozen input changed')
    protocol=exp.load(root/'protocol.json');bank_root=Path(protocol['bankRoot']);lineage_root=Path(protocol['lineageRoot'])
    prepared=exp.load(root/'prepared.json')
    for value in prepared.values():exp.check(value)
    original=exp.load(bank_root/'facet-projection.json');family=exp.load(lineage_root/'bank-family.json')
    revision=exp.load(lineage_root/'bank-update.json');target=revision['current'][0]['id'];old=revision['revisedFrom'][0]
    rows=exp.load(root/'results.json')+exp.load(root/'historical-results.json')
    prior=exp.load(order_root/'results.json')+exp.load(order_root/'historical-results.json')
    native=[json.loads(l) for l in (root/'jev-calls.jsonl').read_text(encoding='utf-8').splitlines()]
    rankings={(r['probe'],r['stage']):r for r in exp.load(root/'rankings.json')}
    if not len(rows)==len(prior)==len(native)==63:raise ValueError('incomplete frozen results')
    output.mkdir(parents=True)
    exp.lineage.save(output/'protocol.json',{'orderRoot':str(order_root.resolve()),'modes':list(MODES),
        'maxItems':3,'maxJsonChars':4500,'newModelCalls':0,'frozenInputs':frozen,
        'groupScore':'best member applicability; never add branch scores',
        'policies':{'history_pairs':'explicit history old/new RELATED endpoints together; otherwise independent',
                    'history_and_conflict':'also group declared current unresolved conflict if both RELATED'},
        'counterevidence':'complete existing projection until final allocation; no summary-only budget fallback',
        'materialization':'per candidate existing activity delivery with finite full-archive-sized workspace; only final output uses frozen budget',
        'controls':'six archived synthetic C/D records plus one synthetic activity-anchor boundary; no new model judgments'})
    results=[];history=[]
    with patch.object(exp.bank.jev,'send',side_effect=AssertionError('no model calls')), \
         patch.object(exp.bank.bridge,'utility_llm',side_effect=AssertionError('no model calls')), \
         patch.object(exp.bank.bridge.core,'llm',side_effect=AssertionError('no model calls')):
        for row,saved,call in zip(rows,prior,native):
            if 'stage' in row:
                data=prepared[row['stage']];probe=row['probe']
                request=exp.load(bank_root/(probe+'-preview-request.json'))
                baseline=exp.load(bank_root/(probe+'-baseline-recall.json'))
                rank=rankings[(probe,row['stage'])];query=rank['query'];scored=rank['rows']
                identity={'stage':row['stage'],'probe':probe,'repeat':row['repeat']}
            else:
                data=copy.deepcopy(prepared['D-families'])
                data['entries'].append(next(e for e in original['entries'] if e['memoryId']==old))
                data['contentHash']=exp.lineage.digest({k:v for k,v in data.items() if k!='contentHash'});exp.check(data)
                request=exp.load(bank_root/'new-task-preview-request.json');query=row['query'];scored=row['rows']
                request['context']['stimulus'][0]['content']['speech']['text']=query['originalText']
                baseline=exp.load(bank_root/'new-task-baseline-recall.json')
                identity={'stage':'historical','probe':'historical','repeat':row['repeat']}
            scores={i:r for r in scored for i in r['readingIds']}
            pair=order_exp.replay(data,request,baseline,query,scores,row,call)
            if pair['delivery']!=saved['delivery']:raise ValueError('prior probability replay changed')
            candidates,_=exp.bank.deliver(data,{**baseline,'query':copy.deepcopy(query)},request,55,row['relatedIds'],scores,'lineage')
            deliveries={'related_probability':pair['delivery']['related_probability']}
            for mode in MODES[1:]:
                deliveries[mode]=deliver(data['archive'],candidates,row['decision'],request,55,query,family,mode)
            required=set(saved['required']);irrelevant=set(saved['irrelevant'])
            metrics={m:order_exp.metrics(d,required,irrelevant,target) for m,d in deliveries.items()}
            result={**identity,'relatedIds':row['relatedIds'],'required':saved['required'],'irrelevant':saved['irrelevant'],
                    'delivery':deliveries,'metrics':metrics}
            (results if 'stage' in row else history).append(result)
        controls=counter_controls(lineage_root);anchors=anchor_control()
    if {str(p.resolve()):exp.hashes(p) for p in frozen_paths}!=frozen:raise ValueError('frozen inputs mutated')
    summaries=[]
    for stage in exp.STAGES:
        selected=[r for r in results if r['stage']==stage]
        for mode in MODES:
            ms=[r['metrics'][mode] for r in selected]
            summaries.append({'stage':stage,'mode':mode,
                'requiredReadMisses':sum(len(m['requiredReadMisses']) for m in ms),
                'irrelevantRead':sum(len(m['irrelevantRead']) for m in ms),
                'targetPositiveRead':sum(r['metrics'][mode]['targetRead'] for r in selected
                    if r['probe'] in ('new-task','new-stop','familiar-control')),
                'navigationBothRead':sum(r['metrics'][mode]['bothCurrentBranchesRead'] for r in selected
                    if r['probe'] in ('new-task','new-stop'))})
    history_summary=[{'repeat':r['repeat'],**{m:{'oldRead':old in r['metrics'][m]['readIds'],
        'currentRead':target in r['metrics'][m]['readIds'],'opposedBranchRead':'bank:10' in r['metrics'][m]['readIds'],
        'readIds':r['metrics'][m]['readIds']} for m in MODES}} for r in history]
    control_summary=[{'case':c['case'],'repeat':c['repeat'],
        'defaultReadIds':[m['memoryId'] for m in c['defaultBudget']['memories']],
        'defaultOmittedGroups':len(c['defaultBudget']['trace']['omitted']),
        'largerDiagnosticItems':len(c['largerBudgetDiagnosticOnly']['memories'])} for c in controls]
    def exposed(delivery):return anchors['summaryId'] in {m['memoryId'] for m in delivery['memories']}
    def counter_present(delivery):return any(anchors['counterAtomId'] in t['coveredAtomIds'] for t in delivery['trace']['delivered'])
    anchor_summary={k:{'itemCount':len(anchors[k]['memories']),'summaryRead':exposed(anchors[k]),
                       'counterRead':counter_present(anchors[k])}
                    for k in ('runtimeDelivery','groupedDelivery','largerBudgetDiagnosticOnly')}
    assessment={'artifactRoot':str(output),'summaries':summaries,'history':history_summary,'counterControls':control_summary,
        'anchorBoundary':anchor_summary,'frozenInputsUnchanged':True,'newModelCalls':0,
        'prior63PairedDeliveriesExactlyReproduced':True,
        'limits':['predeclared synthetic five-probe labels, no generalization','group relation supplied, not discovered',
                  'mandatory grouping can resurrect a false RELATED branch','budget excess intentionally suppresses entire group',
                  'no new Character Turn or live runtime wiring']}
    for name,value in [('results.json',results),('historical-results.json',history),('counter-controls.json',controls),
                       ('anchor-control.json',anchors),('assessment.json',assessment)]:
        exp.lineage.save(output/name,value)
    exp.lineage.save(Path(__file__).with_name('delivery-groups-assessment.json'),assessment)
    print(json.dumps(assessment,ensure_ascii=True))

if __name__=='__main__':
    run(*sys.argv[1:3])
