"""Explicit delivery intervention, not a retrieval result or runtime policy."""
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import core_bridge as bridge

def deliver(doc):
    archive=doc['archive'];bridge.episode.validate_units(archive)
    if doc['request']['context']['character']['characterId']!=archive['scope']['characterId']:
        raise ValueError('intervention role mismatch')
    selected=next(o for o in archive['observations'] if o['id']==doc['targetObservation'])
    candidate={'id':selected['id'],'selectionMethod':'explicit_delivery_intervention','matches':[]}
    answer=bridge.projections.delivery_projection(archive,[candidate],doc['request'],doc['tick'],fair=True)
    if not any(m['memoryId']==selected['id'] and m['memoryLevel']=='observation' for m in answer['memories']):
        raise ValueError('target fails current delivery policy')
    return {'intervention':True,'naturalRetrieval':False,**answer}

if __name__=='__main__':json.dump(deliver(json.load(sys.stdin)),sys.stdout,ensure_ascii=False)
