"""Evidence-driven cognition update, disposable sidecar experiment only."""
import copy
import hashlib
import json
import os
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import core_bridge as bridge

RELATIONS = {'reinforcement', 'refinement', 'counterexample', 'unresolved_conflict'}
PROMPT = """You update ONE character-owned subjective understanding using new authorized evidence.
Re-read ALL original evidence. Source/Atom/Episode are immutable; quoted speech proves speech only.
Decide relation: reinforcement (same judgment, more support), refinement (condition/scope becomes
more precise), counterexample (limited opposing evidence against an established pattern),
unresolved_conflict (independent competing patterns, no evidenced explanation can reconcile them).
Do not prefer new evidence just because it is recent. Count distinct sourceIds, not repeated atoms.
A rare counterexample does not prove the opposite generalization. Contradiction may stay unresolved.
Return JSON {"relation":"...", "reason":"Chinese explanation citing evidence IDs",
"current":[{"text":"Chinese subjective understanding",
"supportingAtomIds":["..."],"contradictingAtomIds":["..."]}]}.
For reinforcement keep the original understanding text EXACTLY. Otherwise preserve its still
supported parts and all evidenced exceptions. Never invent causes, motives, completed actions or
certainty. No behavior instructions, confidence numbers or new evidence.
Use only supplied atom IDs. Preserve all original and new evidence across the current branches.
Each branch has nonempty supports and disjoint counters. One current understanding for
reinforcement/refinement/counterexample; for unresolved conflict retain TWO opposed tentative
branches, both aware of the counterevidence; do not elect a true branch.
No evidence means no rewrite. Expected test labels and stimuli are not provided.
"""

def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()

def save(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')

def observation(archive, ident, text, supports, counters):
    atoms = {a['id']:a for a in archive['facts']}
    cited = [copy.deepcopy(atoms[i]) for i in supports + counters]
    unit = {'id':ident,'kind':'observation','memoryLevel':'observation',
            'epistemicKind':'subjective_inference',
            'text':text if text.startswith('【主观认识，可修正】') else '【主观认识，可修正】' + text,
            'supportingAtomIds':supports,'contradictingAtomIds':counters,
            'sourceFactIds':supports + counters,'eventAtoms':cited,
            'episodeIds':[e['id'] for e in archive['episodes'] if set(e['eventAtomIds']) & set(supports + counters)],
            'sourceRefs':bridge.episode.union_refs(cited)}
    return bridge.timed([unit], archive['sources'])[0]

def fixture_archive(case):
    address = {'tenantId':'tenant:synthetic-lineage','worldId':'world:case-' + case['id'],'branchId':'branch:experiment'}
    evidence = case['oldEvidence'] + case['newEvidence']
    archive = {'scope':{'characterId':'character:npc','worldAddress':address,'asOfWorldSeq':len(evidence)},
               'sources':[],'facts':[],'episodes':[],'observations':[]}
    for number, row in enumerate(evidence, 1):
        source = {'sourceId':'synthetic:' + case['id'] + ':' + str(number),
                  'sourceHash':'sha256:' + hashlib.sha256(row['text'].encode()).hexdigest(),
                  'epistemicKind':'direct_observation','worldSeq':number,'characterId':'character:npc',
                  'worldAddress':copy.deepcopy(address),'knownTick':row['tick'],'text':row['text']}
        archive['sources'].append(source)
        segment = bridge.episode.segments(source)[0]
        atom = bridge.episode.make_atom(source, segment, segment['context'], 0)
        archive['facts'].extend(bridge.timed([atom],archive['sources']))
        archive['episodes'].extend(bridge.timed([{
            'id':'episode:' + source['sourceId'],'kind':'episode','memoryLevel':'episode',
            'label':'synthetic independent experience','eventAtomIds':[atom['id']],
            'eventAtoms':[copy.deepcopy(archive['facts'][-1])],'sourceRefs':atom['sourceRefs'],
            'text':bridge.episode.episode_text([archive['facts'][-1]])}],archive['sources']))
    old_ids = [a['id'] for a in archive['facts'][:len(case['oldEvidence'])]]
    old = observation(archive, 'cognition:' + case['id'] + ':v1', case['oldText'], old_ids, [])
    archive['observations'] = [old]
    bridge.episode.validate_units(archive)
    return archive, old, [a['id'] for a in archive['facts'][len(old_ids):]]

def update(archive, old, new_ids, family_id, formed_tick, revised_tick, update_tick, model=bridge.utility_llm):
    bridge.episode.validate_units(archive)
    # An old object must be the exact stored version, not a caller's rewritten summary.
    if old not in archive['observations']:
        raise ValueError('old understanding is not canonical')
    atoms = {a['id']:a for a in archive['facts']}
    if len(new_ids) != len(set(new_ids)) or any(i not in atoms for i in new_ids):
        raise ValueError('unknown or repeated new atom ID')
    previous = set(old['sourceFactIds'])
    new_ids = [i for i in new_ids if i not in previous]
    if not new_ids:
        return {'relation':'no_new_evidence','familyId':family_id,'current':[copy.deepcopy(old)],
                'versions':[copy.deepcopy(old)],'modelCalled':False,
                'firstFormedTick':formed_tick,'lastRevisedTick':revised_tick}
    if not (formed_tick <= revised_tick <= update_tick) or any(
        atoms[i]['knownTickEnd'] > update_tick for i in previous | set(new_ids)):
        raise ValueError('future evidence or invalid cognition times')
    payload = {'owner':archive['scope'], 'oldUnderstanding':old,
               'oldEvidence':[atoms[i] for i in old['sourceFactIds']],
               'newEvidence':[atoms[i] for i in new_ids],
               'independentSourceCounts':{
                   'old':len({r['sourceId'] for i in previous for r in atoms[i]['sourceRefs']}),
                   'new':len({r['sourceId'] for i in new_ids for r in atoms[i]['sourceRefs']} -
                             {r['sourceId'] for i in previous for r in atoms[i]['sourceRefs']})}}
    start = time.perf_counter()
    answer = model(PROMPT, json.dumps(payload, ensure_ascii=False), 3500)
    if not isinstance(answer,dict) or set(answer) != {'relation','reason','current'}:
        raise ValueError('invalid update shape')
    relation = answer['relation']
    if relation not in RELATIONS or not isinstance(answer['reason'],str):
        raise ValueError('invalid update relation')
    if not isinstance(answer['current'],list) or len(answer['current']) != (2 if relation=='unresolved_conflict' else 1):
        raise ValueError('invalid current branch count')
    allowed = previous | set(new_ids);covered = set();current = []
    for number, branch in enumerate(answer['current'],1):
        if set(branch) != {'text','supportingAtomIds','contradictingAtomIds'}:
            raise ValueError('invalid current understanding shape')
        support,counter = branch['supportingAtomIds'],branch['contradictingAtomIds']
        if (not isinstance(branch['text'],str) or not branch['text'].strip() or
            not isinstance(support,list) or not support or not isinstance(counter,list) or
            len(support+counter)!=len(set(support+counter)) or not set(support+counter)<=allowed):
            raise ValueError('unscoped, overlapping or duplicate evidence')
        current.append(observation(archive, family_id + ':revision:' + str(update_tick) + ':' + str(number),
                                   branch['text'],support,counter))
        covered.update(support+counter)
    if covered != allowed:
        raise ValueError('update discarded original or new evidence')
    if relation == 'reinforcement' and current[0]['text'] != old['text']:
        raise ValueError('reinforcement rewrote the understanding')
    check = {**archive,'observations':archive['observations'] + current}
    bridge.episode.validate_units(check)
    body_changed = [o['text'] for o in current] != [old['text']]
    record = {'familyId':family_id,'relation':relation,'reason':answer['reason'],
              'firstFormedTick':formed_tick,'lastRevisedTick':update_tick if body_changed else revised_tick,
              'evidenceUpdatedTick':update_tick,'revisedFrom':[old['id']],
              'revisionSourceIds':sorted({r['sourceId'] for i in new_ids for r in atoms[i]['sourceRefs']}),
              'hasUnresolvedConflict':relation=='unresolved_conflict',
              'currentVersionIds':[o['id'] for o in current],
              'versionMetadata':{old['id']:{'firstFormedTick':formed_tick,'lastRevisedTick':revised_tick},
                   **{o['id']:{'firstFormedTick':formed_tick if set(o['supportingAtomIds']) & set(old['supportingAtomIds']) else update_tick,
                        'lastRevisedTick':update_tick if body_changed else revised_tick,
                        'recordedTick':update_tick} for o in current}},
              'versions':[copy.deepcopy(old)] + current,'current':current,'modelCalled':True,
              'generationInput':payload,'prompt':PROMPT,'rawAnswer':answer,
              'latencyMs':(time.perf_counter()-start)*1000}
    return record

def select(record, mode='current'):
    if mode not in {'current','historical'}:
        raise ValueError('unknown cognition query mode')
    return copy.deepcopy(record['current'] if mode=='current' else record['versions'])

def run(root, fixture_path, bank_root=None):
    root=Path(root)
    if root.exists():
        raise ValueError('fresh experiment directory required')
    root.mkdir(parents=True)
    fixture=json.loads(Path(fixture_path).read_text(encoding='utf-8'))
    save(root/'protocol.json', {'fixture':fixture,'prompt':PROMPT,
         'labelsNeverSent':True,'formalSchemaChanged':False,'historyMode':'explicit query metadata; not automatic language intent detection'})
    os.environ['HCW_HINDSIGHT_UTILITY_TRACE']=str(root/'utility-calls.jsonl')
    results=[]
    for case in fixture['cases']:
        archive,old,new_ids=fixture_archive(case)
        save(root/('case-' + case['id'] + '-archive.json'),archive)
        evidence_before=digest({k:archive[k] for k in ('sources','facts','episodes')})
        for repeat in range(fixture['repeats']):
            record=update(archive,old,new_ids,'family:' + case['id'],
                          fixture['formedTick'],fixture['formedTick'],fixture['updateTick'])
            result={'case':case['id'],'repeat':repeat,'expectedRelation':case['expectedRelation'],
                    'relationMatches':record['relation']==case['expectedRelation'],'record':record,
                    'currentCount':len(select(record)),'historyCount':len(select(record,'historical')),
                    'independentSupportingSources':[len({r['sourceId'] for a in o['eventAtoms']
                         if a['id'] in o['supportingAtomIds'] for r in a['sourceRefs']}) for o in record['current']],
                    'independentCounterSources':[len({r['sourceId'] for a in o['eventAtoms']
                         if a['id'] in o['contradictingAtomIds'] for r in a['sourceRefs']}) for o in record['current']],
                    'evidenceUnchanged':evidence_before==digest({k:archive[k] for k in ('sources','facts','episodes')})}
            results.append(result)
            save(root/('case-' + case['id'] + '-repeat-' + str(repeat) + '.json'),result)
            print(json.dumps({'case':case['id'],'repeat':repeat,'relation':record['relation'],
                              'current':result['currentCount'],'matches':result['relationMatches']}),flush=True)
    save(root/'controlled-results.json',results)
    if bank_root and all(r['relationMatches'] for r in results):
        bank_experiment(root,Path(bank_root))
    return results

def bank_experiment(root, bank_root):
    # Defined below; never mutate the frozen archive/index/projection.
    from cognition_lineage_bank import run_bank
    run_bank(root,bank_root)

if __name__=='__main__':
    run(sys.argv[1],Path(__file__).with_name('observation-lineage-fixture.json'),
        sys.argv[2] if len(sys.argv)>2 else None)
