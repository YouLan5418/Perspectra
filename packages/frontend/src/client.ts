export const FRONTEND_SDK = String.raw`/** API v1: the only connection is a host-owned MessagePort; never a Core token. */
(() => {
  let port, view, info, counter=0;
  const pending=new Map(), listeners=new Set();
  let connected;
  const ready=new Promise(resolve=>connected=resolve);
  const merge=patch=>{
    if(!view)return;
    const {historyAppend,...fields}=patch; view={...view,...fields};
    if(historyAppend)view.history=[...view.history,...historyAppend];
  };
  window.addEventListener('message',event=>{
    if(event.source!==parent||event.data?.type!=='frontend-connect'||event.data.apiVersion!==1||!event.ports[0]||port)return;
    port=event.ports[0];
    port.onmessage=event=>{
      const data=event.data;
      if(data.type==='initialized'){info=data;view=data.view;connected(data);return}
      if(data.type==='view-patch'){merge(data.changes);for(const listener of listeners)listener({type:'view-patch',changes:data.changes,view});return}
      if(data.type==='disconnected'){for(const listener of listeners)listener(data);return}
      if(data.type==='response'){
        const work=pending.get(data.requestId);if(!work)return;
        pending.delete(data.requestId);clearTimeout(work.timer);
        if(data.ok){if(data.view)view=data.view;work.resolve(data.result??data.view)}
        else work.reject(new Error(data.error||'请求失败'));
      }
    };
    port.start();
  });
  parent.postMessage({type:'frontend-ready',apiVersion:1},'*');
  async function request(method,payload={},actionId) {
    await ready;
    const requestId='request:'+Date.now()+':'+(++counter);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('请求超时；请保留 actionId 重试或查看公开历史。'))},180000);
      pending.set(requestId,{resolve,reject,timer});
      port.postMessage({type:'request',requestId,method,payload,...(actionId?{actionId}:{})});
    });
  }
  const id=()=> 'action:'+Date.now()+':'+(++counter);
  window.Perspectra=Object.freeze({
    apiVersion:1, ready, request, newActionId:id,
    getView:()=>request('view'),
    getHistory:()=>request('history'),
    speak:(text,actionId=id())=>request('speak',{text},actionId),
    perform:(optionId,actionId=id())=>request('perform',{optionId},actionId),
    resource:path=>request('resource',{path}),
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
  });
})();`;
