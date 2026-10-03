"""Check replay lineage, actual model delivery and unchanged encoder inputs."""
import hashlib
import json
import sys
from pathlib import Path
import core_bridge as bridge

root=Path(sys.argv[1]).resolve()
def read(path): return json.loads((root/path).read_text(encoding='utf-8'))
audit=read('audit.json');original=Path(audit['originalDirectory'])
index_checks=[];answers=[];calls=0
for actor in ('gpt','claude','deepseek'):
    data=read(actor+'-archive.json')
    assert data['sources']==json.loads((original/(actor+'-sources.json')).read_text(encoding='utf-8'))['sources']
    prior=read(actor+'-index.json')
    aliases=json.loads((original/(actor+'-build-input.json')).read_text(encoding='utf-8'))['aliasHistory']
    projected=bridge.activity.index_metadata(bridge.projections.retrieval_projection(data,alias_history=aliases),data)
    index=bridge.vector_core.index(projected)
    assert [u['retrievalText'] for u in index['units']]==[u['retrievalText'] for u in prior['units']]
    assert index['vectors']==prior['vectors']
    (root/(actor+'-rebuilt-index.json')).write_text(json.dumps(index,ensure_ascii=False,indent=2),encoding='utf-8')
    index_checks.append({'actor':actor,'units':len(index['units']),'representationsWithActivityId':sum(bool(u.get('activityIds')) for u in index['units']),
                         'retrievalTextsUnchanged':True,'vectorsUnchanged':True})
for directory in sorted((root/'probes').iterdir()):
    result=read(str(directory.relative_to(root)/'result.json'))
    assert result['result']['status']=='published' and result['originalWorldUnchanged']
    data=read(directory.name.split('-')[0]+'-archive.json');sources={s['sourceId']:s for s in data['sources']}
    for file in sorted(directory.glob('call-*.json')):
        record=json.loads(file.read_text(encoding='utf-8'));assert record['status']=='returned';calls+=1
        request=record['request'];memories=request['context']['memories']
        assert len(memories)<=3 and bridge.projections.chars(memories)<=4500
        assert request['context']['observations']==[] and request['context']['selfObservations']==[]
        assert 'activity' not in request['context'] and '"answer"' not in json.dumps(request,ensure_ascii=False)
        for tr in record['deliveryTrace']['delivered']:
            for ref in tr['sourceRefs']+tr.get('relationSourceRefs',[]):assert ref==bridge.core.source_ref(sources[ref['sourceId']])
        for coverage in record['deliveryTrace'].get('activityCoverage',[]):
            for ref in coverage['endingSourceRefs']:assert ref==bridge.core.source_ref(sources[ref['sourceId']])
        if directory.name.startswith('deepseek-'):assert memories==[]
        if record['response'].get('decision')=='publish':
            answers.append({'condition':directory.name,'speech':record['response'].get('speech'),'calls':result['actualCalls']})
assert hashlib.sha256((original/'base/world.sqlite').read_bytes()).hexdigest()==audit['frozenWorldHash']
report={'conditions':len(answers),'calls':calls,'allPublished':True,'lineageVerified':True,'noPrivateAnswer':True,
         'sourcePrefixRespected':True,'originalWorldUnchanged':True,'answers':answers}
(root/'index-audit.json').write_text(json.dumps(index_checks,ensure_ascii=False,indent=2),encoding='utf-8')
(root/'model-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({**{k:v for k,v in report.items() if k!='answers'},'index':index_checks},ensure_ascii=False))
