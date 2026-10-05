"""Stage 6.4 reuses known-family updates and natural ID admission, with optional JEV omitted."""
import copy, json, sys
import notice_board_action_loop as loop
import candidate_admission
import minimal_delivery
bridge = loop.bridge


def recall(doc):
    archive = loop.archive_for_recall(doc)
    request, tick = doc['request'], doc['tick']
    aliases = [{'scope': archive['scope'], 'worldSeq': archive['scope']['asOfWorldSeq'],
        'people': [{'characterId': p['characterId'], 'name': p['name']} for p in request['context']['scene']['people']]}]
    projection = bridge.projections.retrieval_projection(archive, alias_history=aliases)
    index = bridge.vector_core.index(bridge.activity.index_metadata(projection, archive))
    # Existing retrieval/query/scoring; no target IDs or answer are added to the query.
    baseline = bridge.dispatch({'operation':'recall', 'archive':archive, 'index':index,
        'request':request, 'tick':tick, 'observations':True})
    candidates, admission = candidate_admission.admit(archive,index,baseline['retrieval'],request,baseline['query'])
    targets = {o['id'] for o in archive['observations']}
    selected = [c['id'] for c in candidates if c['id'] in targets][:7]
    delivery = minimal_delivery.deliver(archive,candidates,selected,request,tick,copy.deepcopy(baseline['query']))
    return {'variant':doc['variant'], 'query':baseline['query'], 'baselineRetrieval':baseline['retrieval'],
        'retrieval':{**baseline['retrieval'], 'results':candidates}, 'admission':admission,
        'indexUnits':index['units'], 'indexStats':index['stats'], 'archive':archive,
        'targetIds':[o['id'] for o in archive['observations']], 'selectedIds':selected,
        'targetDeliveredIds':[m['memoryId'] for m in delivery['memories'] if m['memoryId'] in targets],
        'delivery':delivery, 'decision':None, 'gateMode':'none', 'jevCalls':0,
        'newProjectionModelCalls':0, 'forcedTarget':False}


if __name__=='__main__':
    doc=json.load(sys.stdin)
    result = loop.revise(doc) if doc['operation']=='revise' else recall(doc) if doc['operation']=='recall' else None
    if result is None: raise ValueError('unknown delayed loop operation')
    json.dump(result,sys.stdout,ensure_ascii=False)
