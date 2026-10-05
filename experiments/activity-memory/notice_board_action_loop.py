"""Authorized Source bridge for the action loop. No World Log is available to memory code."""
import copy,json,sys
import cognition_lineage as lineage
import jev_applicability as jev
import delivery_order
bridge=lineage.bridge
def archive_from(doc):
    sources=copy.deepcopy(doc['sources'])
    archive={'scope':copy.deepcopy(doc['scope']),'sources':sources,'facts':[],'episodes':[],'observations':[]}
    for s in sources:
        atoms=[]
        for i,part in enumerate(bridge.episode.segments(s)):
            atoms.extend(bridge.timed([bridge.episode.make_atom(s,part,part['context'],i)],sources))
        archive['facts'].extend(atoms)
        archive['episodes'].extend(bridge.timed([{'id':'episode:'+s['sourceId'],'kind':'episode','memoryLevel':'episode',
            'label':'independent authorized evidence; not a truth merge','eventAtomIds':[a['id'] for a in atoms],
            'eventAtoms':copy.deepcopy(atoms),'sourceRefs':bridge.episode.union_refs(atoms),
            'text':bridge.episode.episode_text(atoms)}],sources))
    bridge.episode.validate_units(archive)
    return archive
def initial(doc):
    archive=archive_from(doc)
    old_archive=doc['templateArchive'];record=doc['templateUpdate']['record']
    mapping={a['id']:archive['facts'][i]['id'] for i,a in enumerate(old_archive['facts'])}
    if len(mapping)!=2 or len(archive['facts'])!=2:raise ValueError('requires exactly two board atoms')
    current=[lineage.observation(archive,o['id'],o['text'],
        [mapping[i] for i in o['supportingAtomIds']],[mapping[i] for i in o['contradictingAtomIds']]) for o in record['current']]
    archive['observations']=current
    bridge.episode.validate_units(archive)
    return {'archive':archive,'record':{'familyId':record['familyId'],'hasUnresolvedConflict':record['hasUnresolvedConflict'],'current':current,
        'firstFormedTick':archive['sources'][0]['knownTick'],'lastRevisedTick':archive['sources'][-1]['knownTick']},
        'frozenBodiesReused':True,'newModelCalls':0}
def revise(doc):
    old_archive=doc['initial']['archive'];record=doc['initial']['record']
    archive=archive_from(doc)
    archive['observations']=copy.deepcopy(old_archive['observations'])
    # Existing update accepts one canonical cognition. Both branches cite all original atoms.
    old=archive['observations'][0]
    if set(old['sourceFactIds']) != {a['id'] for a in old_archive['facts']}:
        raise ValueError('canonical branch must preserve the entire original two-sign evidence')
    new_ids=[a['id'] for a in archive['facts'] if a['id'] not in {a['id'] for a in old_archive['facts']}]
    if not new_ids:raise ValueError('revision requires a new committed capability Source')
    before=lineage.digest(archive)
    revised=lineage.update(archive,old,new_ids,record['familyId'],
        doc['firstFormedTick'],doc['lastRevisedTick'],doc['tick'])
    if lineage.digest(archive)!=before:raise ValueError('immutable evidence changed')
    archive['observations']=revised['current']
    bridge.episode.validate_units(archive)
    return {'archive':archive,'record':revised,'previousCurrent':copy.deepcopy(old_archive['observations']),
        'canonicalBranchId':old['id'],'allPreviousEvidenceSubmitted':True,
        'limits':['single existing canonical branch update; all opposing evidence supplied, not a general multi-branch merge',
                  'previous current bodies retained in sidecar; no source deletion']}
def archive_for_recall(doc):
    archive=copy.deepcopy(doc['revision']['archive']);archive['scope']=copy.deepcopy(doc['scope'])
    variant=doc['variant']
    if variant=='prior-cognition':archive['observations']=copy.deepcopy(doc['revision']['previousCurrent'])
    elif variant=='no-cognition':archive['observations']=[]
    elif variant!='current-cognition':raise ValueError('unknown variant')
    request=doc['request'];tick=doc['tick']
    # Optional frozen owner-authorized history gives both arms the same actual noise corpus.
    if 'authorizedHistory' in doc:
        history=archive_from({'scope':doc['scope'],'sources':doc['authorizedHistory']})
        trusted={s['sourceId']:s for s in history['sources']}
        for source in archive['sources']:
            if source['sourceId'] not in trusted or any(trusted[source['sourceId']].get(k) != v for k,v in source.items()):
                raise ValueError('frozen archive is not contained in host authorized history')
        prior={s['sourceId'] for s in archive['sources']}
        archive['sources'].extend(s for s in history['sources'] if s['sourceId'] not in prior)
        for key in ('facts','episodes'):
            archive[key].extend(u for u in history[key] if not {r['sourceId'] for r in u['sourceRefs']} <= prior)
    bridge.episode.validate_units(archive)
    return archive

def recall(doc):
    archive=archive_for_recall(doc)
    request=doc['request'];tick=doc['tick'];variant=doc['variant']
    aliases=[{'scope':archive['scope'],'worldSeq':archive['scope']['asOfWorldSeq'],
        'people':[{'characterId':p['characterId'],'name':p['name']} for p in request['context']['scene']['people']]}]
    projection=bridge.projections.retrieval_projection(archive,alias_history=aliases)
    index=bridge.vector_core.index(bridge.activity.index_metadata(projection,archive))
    baseline=bridge.dispatch({'operation':'recall','archive':archive,'index':index,'request':request,
        'tick':tick,'observations':True})
    admission=None
    if doc.get('candidateMode') == 'simple-id':
        from candidate_admission import admit
        rows,admission=admit(archive,index,baseline['retrieval'],request,baseline['query'])
        baseline['retrieval']={**baseline['retrieval'],'results':rows}
    elif doc.get('candidateMode', 'original') != 'original':
        raise ValueError('unknown experimental admission mode')
    by_id={o['id']:o for o in archive['observations']}
    ids=[r['id'] for r in baseline['retrieval']['results'] if r['id'] in by_id][:7]
    q=baseline['query']
    stimulus={'text':q['originalText'],
        'actorIds':[e['id'] for e in q['entitySeeds'] if 'actor' in e['roles']],
        'mentionedIds':[e['id'] for e in q['entitySeeds'] if 'mentioned' in e['roles']]}
    # Unchanged JEV contract; local-object cognitions have no person trigger facets.
    empty={'subjects':[],'contexts':[],'conditions':[],'exceptions':[],'themes':[]}
    decision=jev.assess_many(stimulus,[{'memoryId':i,'understanding':by_id[i]['text'],'applicability':empty} for i in ids]) if ids else {'answers':{},'usage':{},'latencyMs':0}
    related=[i for i in ids if decision['answers'][i]['related']]
    candidates=[r for r in baseline['retrieval']['results'] if r['id'] not in by_id or r['id'] in related]
    candidates=delivery_order.order(candidates,decision)
    delivery=bridge.activity.deliver(archive,candidates,request,tick,q,max_items=3,max_json_chars=4500)
    return {'variant':variant,'query':q,'retrieval':baseline['retrieval'],'sentIds':ids,
        'decision':decision,'relatedIds':related,'delivery':delivery,
        'targetIds':list(by_id),'targetDeliveredIds':[m['memoryId'] for m in delivery['memories'] if m['memoryId'] in by_id],
        'newProjectionModelCalls':0,'forcedTarget':False,'indexStats':index['stats'],
        **({'admission':admission} if admission is not None else {})}
if __name__ == '__main__':
    doc=json.load(sys.stdin)
    result={'initial':initial,'revise':revise,'recall':recall}[doc['operation']](doc)
    json.dump(result,sys.stdout,ensure_ascii=False)
