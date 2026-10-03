"""Warm character-scoped worker. Holds authorized snapshots, never a world-store handle."""
import json
import sys
import vector_core
import projections
import queries


def projected_recall(doc):
    data = doc['archive']
    if data['scope'] != doc['scope']: raise ValueError('archive scope differs')
    if doc['request']['context']['character']['characterId'] != doc['scope']['characterId']:
        raise ValueError('request belongs to another character')
    if doc['index']['scope'] != doc['scope']: raise ValueError('index scope differs')
    aliases = doc['index'].get('retrievalAliases')
    if aliases is not None and aliases['scope'] != doc['scope']:
        raise ValueError('query alias scope differs')
    query = queries.project(doc['request'],aliases)
    recalled = projections.search(doc['index'], doc['scope'], query['semanticQuery'], doc.get('recentSeqs', []),
                                  queryProjection=query, quality=True)
    delivered = projections.delivery_projection(data, recalled['results'], doc['request'], doc['tick'], fair=True)
    by_id, _ = projections.archive(data)
    # Full cognitive objects are for the trace only. Character input uses delivery.
    return {**recalled, 'results':[{**by_id[c['id']], 'score':c['score'], 'rank':c['rank'],
                                  'sourceRanks':c['sourceRanks']} for c in recalled['results']],
            'delivery':delivered['memories'],
            'projectionTrace':{'retrieval':recalled, 'delivery':delivered['trace']}}


def dispatch(doc):
    operation = doc['operation']
    if operation == 'projected_index':
        return vector_core.index(projections.retrieval_projection(doc,alias_history=doc.get('aliasHistory',[])))
    if operation == 'projected_recall': return projected_recall(doc)
    return {'index':vector_core.index,'recall':vector_core.recall}[operation](doc)


if __name__ == '__main__':
    for line in sys.stdin:
        message=json.loads(line)
        try:
            answer={'id':message['id'],'result':dispatch(message['input'])}
        except Exception as error:
            answer={'id':message['id'],'error':str(error)}
        print(json.dumps(answer,ensure_ascii=False),flush=True)
