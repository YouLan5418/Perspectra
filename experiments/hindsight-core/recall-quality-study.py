"""Frozen diagnosis. No world-store handles or memory extraction calls."""
import argparse,copy,hashlib,json,statistics
from pathlib import Path
import core,queries,projections as projection
p=argparse.ArgumentParser()
p.add_argument('baseline',type=Path);p.add_argument('bank',type=Path);p.add_argument('output',type=Path)
p.add_argument('--phase',choices=['query','improved'],default='query')
a=p.parse_args();baseline,bank,out=(v.resolve() for v in (a.baseline,a.bank,a.output))
if out.exists() or any(root==out or root in out.parents for root in (baseline,bank)):raise ValueError('use an independent fresh output directory')
out.mkdir(parents=True)
read=lambda path:json.loads(path.read_text(encoding='utf-8'))
def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
frozen={str(path):digest(path) for root in (baseline,bank) for path in root.rglob('*') if path.is_file()}
write(out/'protocol.json',{'model':'gemini-3.7-flash','phase':a.phase,'baseline':str(baseline),'bank':str(bank),'frozenInputs':frozen,
 'codeHashes':{f:digest(Path(__file__).parent/f) for f in ['queries.py','projections.py','vector_core.py','recall-quality-study.py']},
 'limits':'fixed cognition and original contexts; no world actions or consolidation'})
fixed=[s['traceId'] for s in read(Path(__file__).with_name('projection-prefix-study-assessment.json'))['samples']]
all_paths=sorted((baseline/'retrieval').glob('*.json'));remaining=[p.stem for p in all_paths if p.stem not in fixed]
sample=fixed+remaining[::max(1,len(remaining)//33)][:33]
write(out/'sample-selection.json',{'traceIds':sample,'method':'previous 15 points plus 33 deterministic temporal spread; not a precision estimate'})
for name in ['queries.py','projections.py','vector_core.py','recall-quality-study.py']:
    (out/'code').mkdir(exist_ok=True);(out/'code'/name).write_bytes((Path(__file__).parent/name).read_bytes())
indexes={};stats=[];readings=[]
for path in all_paths:
    old=read(path);data=read((bank/old['snapshot']).with_name('prepared.json'))
    req=old['requests']['new'];q=queries.project(req);key=old['snapshot']
    if key not in indexes:indexes[key]=projection.vector.index(projection.retrieval_projection(data)) if a.phase=='improved' else read((baseline/key).with_name('retrieval-index.json'))
    recent={int(o['sourceSeq']) for o in req['context'].get('observations',[])+req['context'].get('selfObservations',[])}
    options={'queryProjection':q,'quality':True} if a.phase=='improved' else {}
    recalled=projection.search(indexes[key],data['scope'],q['semanticQuery'],recent,**options) if q['mode']!='skip' else {'results':[],'armResults':{k:[] for k in ('semantic','bm25','graph','temporal')},'graphSeeds':[]}
    delivered=projection.delivery_projection(data,recalled['results'],req,old['tick'],**({'fair':True} if a.phase=='improved' else {}))
    sources={s['sourceId']:s for s in data['sources']}
    for row in delivered['trace']['delivered']:
        for ref in row['sourceRefs']:assert ref==core.source_ref(sources[ref['sourceId']])
    request=copy.deepcopy(req);request['context']['memories']=delivered['memories']
    if 'recallEvidence' in request:request['recallEvidence']['memories']=delivered['memories']
    metric={'traceId':old['traceId'],'oldItems':len(old['projected']['memories']),'items':len(delivered['memories']),
        'oldChars':projection.chars(old['projected']['memories']),'chars':projection.chars(delivered['memories']),
        'graphOnlyCandidates':sum(set(c.get('sourceRanks',{}))=={'graph_rank'} for c in recalled['results']),
        'empty':not delivered['memories'],'sameDelivery':delivered['memories']==old['projected']['memories']}
    write(out/'retrieval'/path.name,{'traceId':old['traceId'],'originalResponse':old['originalResponse'],'snapshot':key,
       'tick':old['tick'],'headSeq':old['headSeq'],'queryProjection':q,'oldQuery':old['query'],
       'baselineRecall':old['projectedRecall'],'projectedRecall':recalled,'projected':delivered,'metrics':metric,
       'requests':{'native':old['requests']['native'],'old':req,'new':request}})
    stats.append(metric)
    if old['traceId'] in sample:readings.append({'traceId':old['traceId'],'query':q,'old':old['projected']['memories'],'new':delivered['memories']})
    print(json.dumps({'traceId':old['traceId'],'phase':a.phase,'items':metric['items']}),flush=True)
if any(digest(Path(path))!=h for path,h in frozen.items()):raise ValueError('frozen input changed')
write(out/'reading-sample.json',readings)
write(out/'summary.json',{'queries':len(stats),'fixedReadingPoints':len(sample),'metrics':stats,
   'meanOldChars':statistics.mean(s['oldChars'] for s in stats),'meanChars':statistics.mean(s['chars'] for s in stats),
   'emptyQueries':sum(s['empty'] for s in stats),'sameDeliveries':sum(s['sameDelivery'] for s in stats),
   'graphOnlyCandidates':sum(s['graphOnlyCandidates'] for s in stats),'frozenFilesUnchanged':len(frozen)})
print(json.dumps({'completed':True,'phase':a.phase,'queries':len(stats)}))
