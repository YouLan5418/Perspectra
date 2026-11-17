"""Original default candidate admission and minimal delivery, using deterministic fixtures."""
import json,sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(root/'packages/memory-core/python/bridge'),str(root/'packages/memory-core/python/core')]
import core_bridge as bridge
import candidate_admission, minimal_delivery
doc=json.load(sys.stdin)
if doc['operation']=='fixture':
    scope={'worldAddress':{'tenantId':'t','worldId':'w','branchId':'b'},'characterId':'character:friend','asOfWorldSeq':20}
    sources=[]
    def source(seq,content,kind='reported_speech'):
        sources.append({'sourceId':'event:'+str(seq),'sourceHash':'hash:'+str(seq),'worldSeq':seq,'knownTick':seq,'worldAddress':scope['worldAddress'],'characterId':scope['characterId'],'epistemicKind':kind,'text':content})
    source(1,'character:player said: 我喜欢热茶，明天在茶室再见。')
    source(2,'character:player said: 改主意了，明天我不来。')
    for seq,active,lifecycle in [(3,True,'started'),(4,False,'ended')]:
        source(seq,json.dumps({'actorId':'character:player','actionType':'interact','status':'accepted','interaction':{'entityId':'entity:key','interactionId':'inspect'},'resultDescription':'活动开始。' if active else '活动已经结束。','resultMetadata':{'activity':{'id':'activity:first','revision':seq-2,'phase':'open' if active else 'closed','round':1,'active':active,'lifecycle':lifecycle}}},ensure_ascii=False),'observed_action')
    bridge.core.llm=lambda *a,**k:{'atoms':[]}
    data=bridge.episode.retain({'scope':scope,'sources':sources})
    ids=[a['id'] for a in data['facts']]
    bridge.core.llm=lambda *a,**k:{'groups':[{'episode_id':None,'label':'经历','atom_ids':ids}]}
    data['episodes']=bridge.episode.group(data)['episodes']
    bridge.core.llm=lambda *a,**k:{'observations':[{'observation_id':None,'text':'旅人说喜欢热茶，但明天见面尚不能确定。','supporting_atom_ids':[ids[0]],'contradicting_atom_ids':[ids[1]]}]}
    data['observations']=bridge.episode.consolidate(data)['observations']
    data=bridge.activity.bind(data)
    index=bridge.vector_core.index(bridge.activity.index_metadata(bridge.projections.retrieval_projection(data),data))
    json.dump({'archive':data,'index':index},sys.stdout,ensure_ascii=False)
else:
    data,index,request=doc['archive'],doc['index'],doc['request']
    query=bridge.queries.project(request,index.get('retrievalAliases'))
    recall=bridge.projections.search(index,data['scope'],query['semanticQuery'],[],queryProjection=query,quality=True)
    candidates,admission=candidate_admission.admit(data,index,recall,request,query)
    selected=[c['id'] for c in candidates if c['id'] in {o['id'] for o in data['observations']}]
    result=minimal_delivery.deliver(data,candidates,selected,request,doc['tick'],query,max_items=doc.get('maxItems',6),max_json_chars=doc.get('maxChars',12000))
    json.dump({'query':query,'recall':recall,'candidates':candidates,'admission':admission,'delivery':result},sys.stdout,ensure_ascii=False)
