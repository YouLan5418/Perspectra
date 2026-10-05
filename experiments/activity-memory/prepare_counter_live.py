"""Prepare explicit candidate/Delivery interventions from host-authorized sources."""
import copy
import json
import sys
from unittest.mock import patch
import core_bridge as bridge
import cognition_lineage as lineage

def prepare(payload):
    authorized, request, tick = payload['authorized'],payload['request'],payload['tick']
    if request['context']['character']['characterId'] != authorized['scope']['characterId']:
        raise ValueError('wrong request owner')
    doc = {'scope':copy.deepcopy(authorized['scope']),'sources':copy.deepcopy(authorized['sources']),
           'facts':[],'episodes':[],'observations':[]}
    # No retain/consolidation here: this is a predeclared delivery intervention.
    with patch.object(bridge.core,'llm',side_effect=AssertionError('no utility calls')):
        for source in doc['sources']:
            parts = bridge.episode.segments(source)
            for number,part in enumerate(parts):
                doc['facts'] += bridge.timed([bridge.episode.make_atom(source,part,part['context'],number)],doc['sources'])
    atoms = {a['knownTickStart']:a for a in doc['facts'] if a['knownTickStart'] in (2,6,10,12,13)}
    if set(atoms) != {2,6,10,12,13}:
        raise ValueError('authored evidence is incomplete')
    game_atoms = [atoms[t] for t in (10,12,13)]
    doc['episodes'] = bridge.timed([{'id':'episode:delivery-counter-game','kind':'episode','memoryLevel':'episode',
        'label':'第三局猜数字','eventAtomIds':[a['id'] for a in game_atoms],
        'eventAtoms':copy.deepcopy(game_atoms),'sourceRefs':bridge.episode.union_refs(game_atoms),
        'text':bridge.episode.episode_text(game_atoms)}],doc['sources'])
    unit = lineage.observation(doc,'observation:delivery-counter-pattern',
        '此前两局猜数字都是我先猜中，旅人没有猜中。我倾向认为在这种游戏里我比旅人更容易赢。',
        [atoms[t]['id'] for t in (2,6,10)],[atoms[12]['id']])
    doc['observations'] = [unit]
    bridge.episode.validate_units(doc)
    candidate = {'id':unit['id'],'selectionMethod':'explicit_delivery_intervention',
                 'matches':[{'atomIds':[atoms[10]['id']],'sourceRefs':atoms[10]['sourceRefs']}]}
    candidates = [] if payload['probe']=='unrelated-control' else [candidate]
    delivered = bridge.activity.deliver(doc,candidates,copy.deepcopy(request),tick,
                                       {'originalText':payload['stimulus']})
    full = delivered['memories']
    counter = atoms[12]['id']
    if candidates and not (len(full)==3 and unit['id'] in {m['memoryId'] for m in full}
        and any(counter in r['coveredAtomIds'] for r in delivered['trace']['delivered'])):
        raise ValueError('repair did not deliver ending, understanding and counter')
    conditions = {'full':full,'counter-ablated':[], 'without-cognition':[]}
    for item,trace in zip(full,delivered['trace']['delivered']):
        if counter not in trace['coveredAtomIds']:
            conditions['counter-ablated'].append(copy.deepcopy(item))
            if item['memoryId'] != unit['id']:
                conditions['without-cognition'].append(copy.deepcopy(item))
    if payload['probe']=='unrelated-control' and any(conditions.values()):
        raise ValueError('negative control should be empty')
    for memories in conditions.values():
        if len(memories)>3 or bridge.projections.chars(memories)>4500:
            raise ValueError('budget exceeded')
    return {'archive':doc,'delivery':delivered,'conditions':conditions,'counterAtomId':counter,
            'targetObservation':unit['id'],'newUtilityCalls':0,'naturalRetrieval':False,
            'understandingOrigin':'researcher authored stale understanding with explicit later counter',
            'cognitionTimes':{'firstFormedTick':10,'lastRevisedTick':10},
            'intervention':'only the full group is the fixed runtime; other groups are deliberate evidence ablations'}

if __name__=='__main__':
    json.dump(prepare(json.load(sys.stdin)),sys.stdout,ensure_ascii=False)
