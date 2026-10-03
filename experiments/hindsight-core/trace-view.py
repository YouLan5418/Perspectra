"""Inspect the actual stimulus -> retrieval -> input -> response -> committed-action chain."""
import argparse,json
from pathlib import Path
import sys
sys.stdout.reconfigure(encoding="utf-8")
parser=argparse.ArgumentParser()
parser.add_argument('root',type=Path)
parser.add_argument('--id')
parser.add_argument('--find',default='')
parser.add_argument('--last',type=int,default=1)
parser.add_argument('--route-limit',type=int,default=4,help='maximum printed expansion paths per unit; 0 prints all')
args=parser.parse_args()
paths=sorted((args.root/'traces').glob('*.json'))
records=[(p,json.loads(p.read_text(encoding='utf-8'))) for p in paths]
if args.id:records=[(p,d) for p,d in records if d['id']==args.id]
if args.find:records=[(p,d) for p,d in records if args.find in json.dumps(d.get('modelResponse'),ensure_ascii=False)]
for path,trace in records[-args.last:]:
    print('\n'+trace['id']+' | '+trace['actorId']+' | tick '+str(trace['tick']))
    print('刺激：'+json.dumps(trace['currentStimulus'],ensure_ascii=False))
    print('检索词：'+trace['query']+' ['+trace['queryOrigin']+']')
    idx=json.loads((args.root/trace['snapshot']).read_text(encoding='utf-8'))
    by_id={u['id']:u for u in idx['units']}
    for unit in trace['selected']:
        print('\n召回 '+unit['id']+' ('+unit['kind']+')：'+unit['text'])
        print('各臂排名：'+json.dumps(unit.get('sourceRanks',{}),ensure_ascii=False)+'；cosine='+str(unit.get('semanticSimilarity')))
        print('RRF贡献：'+json.dumps(unit.get('rrfContributions',{}),ensure_ascii=False))
        routes=unit['routes'] if args.route_limit<=0 else unit['routes'][:args.route_limit]
        if len(routes)<len(unit['routes']):print('候选扩展路径 '+str(len(unit['routes']))+' 条，显示 '+str(len(routes))+' 条；完整路径见 trace。')
        for route in routes:
            seed=by_id[route['from']]
            print('  ← '+route['kind']+' ← '+seed['id']+' [来源 tick '+','.join(str(t['knownTick']) for t in seed.get('sourceTicks',[]))+'] '+json.dumps(route,ensure_ascii=False))
        for source in unit['sources']:
            print('  证据 '+source['sourceId']+' | tick '+str(source['knownTick'])+' | '+str(trace['tick']-source['knownTick'])+' tick 前 | '+source['epistemicKind']+'：'+source['text'])
    print('\n有 Observation：'+str(trace['hasObservation']))
    print('最终给模型的完整内容：'+str(path.resolve())+' -> deliveredRequest / modelCall')
    print('模型返回：'+json.dumps(trace['modelResponse'],ensure_ascii=False))
    print('实际提交：'+json.dumps(trace.get('roundOutcome',{}),ensure_ascii=False))
    print('边界：检索路径证明材料如何选入，不能证明模型内部为何作出该回应。')
if not records:print('no matching completed or pending trace')
