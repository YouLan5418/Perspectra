"""Read the frozen first experiment; write a fresh deterministic replay directory."""
import copy
import hashlib
import json
import sys
from pathlib import Path
import core_bridge as bridge

original=Path(sys.argv[1]).resolve(); output=Path(sys.argv[2]).resolve()
if output.exists(): raise ValueError('replay needs a fresh output directory')
output.mkdir(parents=True)
def read(path): return json.loads((original/path).read_text(encoding='utf-8'))
def save(name,value): (output/name).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
checks=[]; jobs=[]
for actor in ('gpt','claude','deepseek'):
    frozen=read('probes/recall-'+actor+'-core-recall/call-1.json')
    old=read(actor+'-archive.json'); data=bridge.activity.reproject(old)
    assert data['sources']==old['sources']==read(actor+'-sources.json')['sources']
    assert data.get('observations',[]) and [o['text'] for o in data['observations']]==[o['text'] for o in old['observations']]
    save(actor+'-archive.json',data);save(actor+'-index.json',read(actor+'-index.json'))
    save(actor+'-frozen-request.json',frozen)
    tick=read('source-summary.json')['head']['tick']; candidates=frozen['retrieval']['retrieval']['results']
    results={}
    for mode in ('old','annotation','expanded'):
        query=copy.deepcopy(frozen['retrieval']['query'])
        result=(bridge.projections.delivery_projection(data,candidates,frozen['request'],tick,fair=True) if mode=='old'
                else bridge.activity.deliver(data,candidates,frozen['request'],tick,query,include_anchors=mode=='expanded'))
        save(actor+'-'+mode+'-delivery.json',result);results[mode]=result
        sources={s['sourceId']:s for s in data['sources']}
        assert len(result['memories'])<=3 and bridge.projections.chars(result['memories'])<=4500
        for tr in result['trace']['delivered']:
            for ref in tr['sourceRefs']+tr.get('relationSourceRefs',[]):assert ref==bridge.core.source_ref(sources[ref['sourceId']])
        if actor!='deepseek':
            for repeat in range(2 if mode!='annotation' else 1): jobs.append({'actor':actor,'mode':mode,'repeat':repeat+1})
    if actor=='deepseek':
        assert not candidates and all(not r['memories'] for r in results.values())
        jobs.append({'actor':actor,'mode':'expanded','repeat':1})
        checks.append({'actor':actor,'sourceUnchanged':True,'unrelatedActorEmpty':True});continue
    end=next(s for s in data['sources'] if '使用宿主逃生按钮中止活动' in s['text'])
    assert not any(end['sourceId'] in m['sourceIds'] for m in results['old']['memories'])
    assert any(end['sourceId'] in m['sourceIds'] for m in results['expanded']['memories'])
    # Truncate to the authorized prefix before the ending, keeping the same grouping decisions.
    prefix=copy.deepcopy(data);prefix['scope']['asOfWorldSeq']=end['worldSeq']-1
    prefix['sources']=[s for s in prefix['sources'] if s['worldSeq']<end['worldSeq']]
    prefix['facts']=[a for a in prefix['facts'] if all(r['worldSeq']<end['worldSeq'] for r in a['sourceRefs'])]
    prefix['representations']=[a for a in prefix.get('representations',[]) if all(r['worldSeq']<end['worldSeq'] for r in a['sourceRefs'])]
    ids={a['id']:a for a in prefix['facts']}
    episodes=[]
    for unit in prefix['episodes']:
        atoms=[ids[i] for i in unit['eventAtomIds'] if i in ids]
        if not atoms:continue
        unit.update(eventAtoms=atoms,eventAtomIds=[a['id'] for a in atoms],sourceRefs=bridge.episode.union_refs(atoms),text=bridge.episode.episode_text(atoms))
        episodes.append(unit)
    prefix['episodes']=episodes
    prefix['observations']=[o for o in prefix['observations'] if all(r['worldSeq']<end['worldSeq'] for r in o['sourceRefs'])]
    prefix=bridge.activity.bind(prefix)
    eligible=[]
    for c in candidates:
        c=copy.deepcopy(c)
        if c['id'] not in {u['id'] for u in bridge.episode.validate_units(prefix)}:continue
        c['matches']=[m for m in c.get('matches',[]) if all(i in ids for i in m['atomIds'])]
        eligible.append(c)
    before=bridge.activity.deliver(prefix,eligible,frozen['request'],tick,copy.deepcopy(frozen['retrieval']['query']))
    assert not any(end['sourceId'] in m['sourceIds'] for m in before['memories'])
    assert all(c['status']=='unknown' for c in before['trace']['activityCoverage'])
    save(actor+'-before-ending-delivery.json',before)
    checks.append({'actor':actor,'sourceUnchanged':True,'oldEndingDelivered':False,'expandedEndingDelivered':True,
                   'beforeEndingHasNoFutureClosure':True,'endingSourceId':end['sourceId'],
                   'originalCandidatesReused':True,'items':{m:len(r['memories']) for m,r in results.items()}})
save('jobs.json',jobs)
save('address.json',read('address.json'));save('source-summary.json',read('source-summary.json'))
save('audit.json',{'frozenWorldHash':hashlib.sha256((original/'base/world.sqlite').read_bytes()).hexdigest(),
                   'originalDirectory':str(original),'checks':checks,'modelJobs':len(jobs)})
print(json.dumps({'checks':checks,'modelJobs':len(jobs)},ensure_ascii=False))
