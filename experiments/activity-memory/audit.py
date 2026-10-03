"""Read-only source/lineage audit plus two retrieval diagnostics; writes only this run's reports."""
import hashlib
import json
import sys
from pathlib import Path
import core_bridge as bridge

root=Path(sys.argv[1]).resolve()
def read(name): return json.loads((root/name).read_text(encoding='utf-8'))
archives={a:bridge.activity.reproject(read(a+'-archive.json')) for a in ['gpt','claude','deepseek']}
counts=[]
for actor,data in archives.items():
    assert data['sources'] == read(actor+'-sources.json')['sources']
    bridge.episode.validate_units(data)
    bridge.vector_core.check_mapping(data, bridge.core.check_units(data))
    assert not any('"answer"' in s['text'] for s in data['sources'])
    counts.append({'actor':actor,**{k:len(data[k]) for k in ['sources','facts','episodes','observations']}})
assert not any('猜数字' in s['text'] or '裁决为' in s['text'] for s in archives['deepseek']['sources'])
mode_counts={};deliveries=[];answers=[];suppressed=[]
for directory in sorted((root/'probes').iterdir()):
    result=json.loads((directory/'result.json').read_text(encoding='utf-8'))
    assert result['result']['status']=='published' and 'failure' not in result['result']
    assert result['sourceSnapshotHash']==hashlib.sha256((root/'base/world.sqlite').read_bytes()).hexdigest()
    mode=directory.name.split('-',2)[2]
    mode_counts[mode]=mode_counts.get(mode,0)+1
    for p in sorted(directory.glob('call-*.json')):
        trace=json.loads(p.read_text(encoding='utf-8'))
        actor=trace['actor'].split(':')[1];sources={s['sourceId']:s for s in archives[actor]['sources']}
        request=trace['request'];assert request['context']['observations']==[] and request['context']['selfObservations']==[]
        assert 'activity' not in request['context'] and '"answer"' not in json.dumps(request,ensure_ascii=False)
        assert len(request['context']['memories'])<=3
        for memory in request['context']['memories']:
            if 'sourceIds' in memory:
                assert set(memory['sourceIds'])<=set(sources)
            else:
                ref=memory['metadata']['source'];assert ref['sourceId'] in sources
                assert ref['sourceHash']==sources[ref['sourceId']]['sourceHash']
        if trace['retrieval']:
            for row in trace['retrieval']['deliveryTrace']['delivered']:
                for ref in row['sourceRefs']:assert ref==bridge.core.source_ref(sources[ref['sourceId']])
            suppressed.extend({'condition':directory.name,'call':p.name,**item} for item in trace['retrieval']['deliveryTrace']['omitted'] if 'observation' in item['reason'])
        deliveries.append({'condition':directory.name,'call':p.name,'items':len(request['context']['memories']),
                           'levels':[m.get('memoryLevel','native') for m in request['context']['memories']]})
        answers.append({'condition':directory.name,'call':p.name,'response':trace['response']})
    if directory.name.startswith('recall-deepseek'):
        assert all(d['items']==0 for d in deliveries if d['condition']==directory.name)
# Diagnose the end event under the actual broad question versus a specific synonym.
diagnostics=[]
for actor in ['gpt','claude']:
    source=next(s for s in archives[actor]['sources'] if '使用宿主逃生按钮中止活动' in s['text'])
    saved=read('probes/recall-'+actor+'-core-observation/call-1.json')
    index=read(actor+'-index.json')
    rows=[r for r in saved['retrieval']['retrieval']['rawScores'] if r['memoryId']=='atom:'+source['sourceId']+':0']
    request=json.loads(json.dumps(saved['request']))
    request['context']['stimulus'][0]['value']['content']['speech']['text']='那局活动是如何中止的？'
    request['context']['memories']=[]
    result=bridge.dispatch({'operation':'recall','archive':archives[actor],'index':index,'request':request,
                            'tick':read('source-summary.json')['head']['tick'],'observations':True})
    (root/(actor+'-ending-diagnostic.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    diagnostics.append({'actor':actor,'endingSource':source['sourceId'],'broadQueryScores':rows,
                        'specificQueryEndingDelivered':any(source['sourceId'] in m['sourceIds'] for m in result['delivery'])})
report={'lineageVerified':True,'sourcesUnchanged':True,'noPrivateAnswerInMemoryOrProbe':True,'deepseekHasNoGameSources':True,
        'frozenWorldUnchanged':True,'counts':counts,'conditions':sum(mode_counts.values()),'modes':mode_counts,
        'characterCalls':len(deliveries),'deliveries':deliveries,'observationSuppressions':suppressed,
        'observationSummariesDelivered':sum(d['levels'].count('observation') for d in deliveries),
        'endingDiagnostics':diagnostics,'answers':answers}
(root/'audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k not in ['deliveries','answers','observationSuppressions']},ensure_ascii=False))
