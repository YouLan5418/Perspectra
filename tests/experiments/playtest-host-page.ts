/** Host-owned outer page. Creator presentation lives in the child frame. */
export const HOST_ACTIVITY_PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Perspectra 试玩</title>
<style>
body{margin:0;font:14px system-ui;background:#10151e;color:#edf2ff}
header{display:flex;gap:14px;align-items:center;padding:10px 18px;background:#202a3a}
button,input,select{font:inherit;padding:7px 10px;border-radius:6px;border:1px solid #69798f}
button{cursor:pointer}button:disabled{opacity:.5;cursor:default}
#escape{margin-left:auto;background:#a93a40;color:white;border-color:#d77378}
#notice{padding:0 18px;white-space:pre-wrap}#game{padding:10px 18px;border-bottom:1px solid #42506b}
#options{display:flex;flex-wrap:wrap;gap:12px}.operation{display:flex;gap:6px;align-items:center}
iframe{width:100%;height:calc(100vh - 160px);border:0;background:#10151e}small{color:#bbc7db}
</style></head><body>
<header><strong>Perspectra</strong><small>宿主控制</small><span id="frontend-status">正在载入</span><button id="reload-frontend" type="button">重新加载界面</button><button id="default-frontend" type="button">官方默认模板</button><button id="memory" type="button" hidden>整理长期记忆</button><button id="escape" type="button">逃生：中止活动并恢复</button></header>
<p id="notice" role="status"></p><p id="memory-status" role="status"></p>
<section id="game" hidden><strong id="title"></strong><p id="round"></p><div id="options"></div></section>
<iframe id="experience" title="创作者世界页面" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
<script>
(() => {
  const token=new URLSearchParams(location.hash.slice(1)).get('token')||'';
  history.replaceState(null,'',location.pathname);
  window.addEventListener('hashchange',()=>history.replaceState(null,'',location.pathname));

  const node=id=>document.getElementById(id);
  const frame=node('experience');
  let port=null,connected=false,frameLoaded=false,frontendReady=false,useDefault=false,init=null,playerView=null;
  let epoch=0,streamController=null;
  function revoke(){epoch++;if(port)port.close();port=null;connected=false;frameLoaded=false;frontendReady=false}
  async function publicApi(path,payload){
    const response=await fetch('/frontend-api/v1/'+path,{method:payload===undefined?'GET':'POST',
      headers:{'x-playtest-token':token,'content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
    const value=await response.json();if(!response.ok)throw new Error(value.error||'公开接口请求失败');return value;
  }
  function post(value){if(port)port.postMessage(value)}
  function applyView(next,notify=true){
    if(!playerView){playerView=next;return}
    const changes={};
    for(const key of ['game','player','scene','status','actions'])if(JSON.stringify(playerView[key])!==JSON.stringify(next[key]))changes[key]=next[key];
    if(JSON.stringify(playerView.history)!==JSON.stringify(next.history)){
      const prefix=playerView.history.length<=next.history.length&&playerView.history.every((line,i)=>JSON.stringify(line)===JSON.stringify(next.history[i]));
      if(prefix)changes.historyAppend=next.history.slice(playerView.history.length);else changes.history=next.history;
    }
    playerView=next;if(notify&&Object.keys(changes).length)post({type:'view-patch',changes});
  }
  async function connect(){
    if(connected||!frameLoaded||!frontendReady||!init)return;
    connected=true;const current=epoch,channel=new MessageChannel();port=channel.port1;
    port.onmessage=async event=>{
      const r=event.data;
      if(current!==epoch||!r||r.type!=='request'||typeof r.requestId!=='string'||!/^[a-zA-Z0-9:-]{1,100}$/.test(r.requestId))return;
      const reply=value=>{if(current===epoch)channel.port1.postMessage({type:'response',requestId:r.requestId,...value})};
      try{
        if(JSON.stringify(r).length>8192||!r.payload||typeof r.payload!=='object'||Array.isArray(r.payload))throw new Error('前端请求格式无效');
        const grant={view:'view',history:'history',speak:'speak',perform:'perform',resource:'resources'}[r.method];
        if(!grant||!init.capabilities.includes(grant))throw new Error('前端没有该能力');
        if(['view','history'].includes(r.method)){
          if(Object.keys(r.payload).length)throw new Error('查询不接受额外参数');
          const view=await publicApi('view');applyView(view);
          reply({ok:true,result:r.method==='history'?view.history:view});return;
        }
        if(r.method==='resource'){
          if(Object.keys(r.payload).join(',')!=='path')throw new Error('资源请求格式无效');
          const result=await publicApi('resource',{path:r.payload.path});reply({ok:true,result});return;
        }
        const view=await publicApi('action',{requestId:r.requestId,actionId:r.actionId,operation:r.method,payload:r.payload});
        applyView(view);reply({ok:true,view});
      }catch(error){reply({ok:false,error:error.message||'前端操作失败'})}
    };
    port.start();
    frame.contentWindow.postMessage({type:'frontend-connect',apiVersion:1},init.frontendMode==='trusted'?init.frontendOrigin:'*',[channel.port2]);
    post({type:'initialized',apiVersion:1,frontendMode:init.frontendMode,capabilities:init.capabilities,view:playerView});
    node('frontend-status').textContent=init.frontend==='default'?'官方默认模板 · 沙箱':init.frontendMode==='trusted'?'游戏包前端 · 受信任':'游戏包前端 · 沙箱';
  }
  window.addEventListener('message',event=>{
    const expected=init?.frontendMode==='trusted'?init.frontendOrigin:'null';
    if(event.source!==frame.contentWindow||event.origin!==expected||event.data?.type!=='frontend-ready'||event.data.apiVersion!==1)return;
    frontendReady=true;connect();
  });
  frame.onload=()=>{frameLoaded=true;connect()};
  async function mount(fallback=false){
    revoke();useDefault=fallback;
    init=await publicApi('init'+(fallback?'?template=default':''));
    playerView=init.view;
    frame.setAttribute('sandbox',init.frontendMode==='trusted'?'allow-scripts allow-same-origin':'allow-scripts');
    frame.src=init.frontend==='custom'&&!fallback?(init.frontendOrigin||'')+'/frontend/custom/index.html':'/frontend/default.html';
    setTimeout(()=>{if(!connected)node('frontend-status').textContent='前端未连接；可重新加载或切换默认模板'},5000);
  }
  async function events(){
    streamController?.abort();streamController=new AbortController();
    try{
      const response=await fetch('/frontend-api/v1/events',{headers:{'x-playtest-token':token},signal:streamController.signal});
      if(!response.ok)throw new Error('订阅失败');
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',streamView=null;
      while(true){
        const {value,done}=await reader.read();if(done)throw new Error('连接结束');buffer+=decoder.decode(value,{stream:true});
        let end;while((end=buffer.indexOf('\n\n'))!==-1){
          const block=buffer.slice(0,end);buffer=buffer.slice(end+2);
          const line=block.split('\n').find(l=>l.startsWith('data: '));if(!line)continue;
          const event=JSON.parse(line.slice(6));
          if(event.type==='frontend-policy'){await mount(true);continue}
          if(event.type==='snapshot'){streamView=event.view;applyView(streamView,init?.capabilities.includes('subscribe'))}
          if(event.type==='view-patch'&&streamView){const {historyAppend,...fields}=event.changes;streamView={...streamView,...fields};if(historyAppend)streamView.history=[...streamView.history,...historyAppend];applyView(streamView,init?.capabilities.includes('subscribe'))}
        }
      }
    }catch(error){if(error.name!=='AbortError'){post({type:'disconnected'});node('frontend-status').textContent='公开视图连接断开；正在重连';setTimeout(events,1500)}}
  }
  node('reload-frontend').onclick=()=>mount(useDefault).catch(()=>node('frontend-status').textContent='前端载入失败');
  node('default-frontend').onclick=()=>mount(true).catch(()=>node('frontend-status').textContent='默认模板载入失败');
  window.addEventListener('pagehide',()=>{streamController?.abort();revoke()});
  mount().then(events).catch(()=>node('frontend-status').textContent='前端初始化失败');

  let latest, posting=false, signature='', pending=null;
  // Page-local presentation only. Sequence orders notices, not requests or world events.
  let currentNotice=null, noticeSequence=0;
  function setNotice(type,operation,content){
    currentNotice={type,operation,content,sequence:++noticeSequence};renderNotice();
  }
  function clearNotice(){currentNotice=null;renderNotice()}
  function renderNotice(){
    const target=node('notice');target.textContent=currentNotice?.content||'';
    target.dataset.type=currentNotice?.type||'';
    target.dataset.operation=currentNotice?.operation||'';
    target.dataset.sequence=currentNotice?String(currentNotice.sequence):'';
  }
  async function api(path,payload) {
    const response=await fetch(path,{method:payload===undefined?'GET':'POST',
      headers:{'x-playtest-token':token,'content-type':'application/json'},
      ...(payload===undefined?{}:{body:JSON.stringify(payload)})});
    const value=await response.json();
    if(!response.ok)throw new Error(value.error||'请求失败');
    return value;
  }
  async function send(operation,parameters={}) {
    if(posting)return;
    const a=latest?.activity;
    if(!a)return;
    const payload={activityId:operation==='start'?null:a.id,
      revision:operation==='start'?0:a.revision,operation,parameters,requestId:crypto.randomUUID()};
    posting=true;pending=payload;clearNotice();
    try{const state=await api('/api/activity',payload);setNotice(state.error?'error':'success','activity',state.notice||'游戏操作已提交。');render(state);pending=null}
    catch(error){setNotice('error','activity',error.message+'；可用逃生按钮中止活动。')}
    finally{posting=false;signature='';await refresh()}
  }
  function render(state) {
    latest=state;
    node('memory').hidden=state.debug?.memoryMode!=='core';
    node('memory').disabled=posting;
    const m=state.memoryMaintenance;
    node('memory').textContent=m&&(m.running+m.queued)>0?'取消后台整理':'后台整理长期记忆';
    node('memory-status').textContent=m&&(m.running+m.queued)>0?'长期记忆在后台整理，可继续游玩。':m&&m.failed>0?'部分角色整理失败，继续使用原档案。':m&&m.completed>0?'后台记忆整理完成。':'';
    renderNotice();
    const a=state.activity;
    node('game').hidden=!a;
    if(!a)return;
    node('title').textContent=a.title;
    const active=a.game?.active;
    node('round').textContent=active
      ? '第 '+a.game.round+' 个游戏回合 · '+(a.game.public.statusText||(a.game.turn===a.participants[0]?'轮到你':'轮到角色'))
        +' · '+(a.game.public.lastResult||'')
      : a.game?.phase==='host-aborted'?'活动已中止，已恢复自由互动。':a.game?.public.lastResult||'可以开始一局游戏。';
    const key=JSON.stringify([a.id,a.revision,state.busy,state.paused,posting,pending?.requestId]);
    if(key===signature)return;
    signature=key;node('options').replaceChildren();
    const add=(text,work,disabled=false)=>{
      const button=document.createElement('button');button.type='button';button.textContent=text;
      button.disabled=disabled;button.onclick=work;node('options').append(button);return button;
    };
    if(!active)add('开始 '+a.title,()=>send('start'),state.busy||state.paused||posting);
    else {
      for(const option of a.options||[]) {
        const group=document.createElement('div');group.className='operation';
        const fields=[];
        for(const [key,schema] of Object.entries(option.argumentSchema.properties)) {
          if(key==='activityId'||key==='revision')continue;
          const label=document.createElement('label');label.textContent=schema.title||key;
          let input;
          if(schema.enum){input=document.createElement('select');
            for(const item of schema.enum){const op=document.createElement('option');op.value=String(item);op.textContent=String(item);input.append(op)}}
          else {input=document.createElement('input');input.type=schema.type==='integer'||schema.type==='number'?'number':schema.type==='boolean'?'checkbox':'text';
            if(schema.minimum!==undefined)input.min=schema.minimum;if(schema.maximum!==undefined)input.max=schema.maximum;}
          input.disabled=state.busy||state.paused||posting;
          label.append(input);group.append(label);fields.push([key,schema,input]);
        }
        const button=document.createElement('button');button.textContent=option.label;button.type='button';
        button.disabled=state.busy||state.paused||posting;
        button.onclick=()=> {
          const parameters={};
          for(const [key,schema,input] of fields) {
            if(input.type!=='checkbox'&&input.value===''){node('notice').textContent='请先填写 '+(schema.title||key);return;}
            parameters[key]=schema.type==='integer'||schema.type==='number'?Number(input.value):schema.type==='boolean'?input.checked:input.value;
          }
          send(option.definitionRef.id.slice('activity:'.length),parameters);
        };
        group.append(button);node('options').append(group);
      }
      if(a.game.turn!==a.participants[0])add('再次请求角色处理',()=>send('retry'),state.busy||state.paused||posting);
    }
    if(pending)add('重试同一请求',async()=>{
      if(posting)return;posting=true;clearNotice();
      try{const state=await api('/api/activity',pending);setNotice(state.error?'error':'success','activity',state.notice||'游戏操作已提交。');render(state);pending=null}
      catch(error){setNotice('error','activity',error.message)}
      finally{posting=false;signature='';await refresh()}
    },state.busy||posting);
  }
  async function refresh(){try{render(await api('/api/state'))}catch(error){if(currentNotice?.operation!=='activity'||currentNotice.type!=='error')setNotice('error','refresh',error.message+'；逃生入口仍可使用。')}}
  node('memory').onclick=async()=>{
    if(posting)return;posting=true;clearNotice();
    try{const state=await api(latest?.memoryMaintenance&&(latest.memoryMaintenance.running+latest.memoryMaintenance.queued)>0?'/api/memory/cancel':'/api/memory/refresh',{});setNotice(state.error?'error':'success','memory',state.notice||'记忆操作已提交。');render(state)}
    catch(error){setNotice('error','memory',error.message)}
    finally{posting=false;await refresh()}
  };
  node('escape').onclick=async()=>{
    // Independent of current turn, creator options, pause or in-flight model work.
    node('escape').disabled=true;clearNotice();
    try{const state=await api('/api/escape',{});setNotice(state.error?'error':'success','escape',state.notice||'活动已中止，已恢复自由互动。');render(state);pending=null}
    catch(error){setNotice('error','escape',error.message)}
    finally{node('escape').disabled=false;signature='';await refresh()}
  };
  setInterval(refresh,2500);refresh();
})();
</script></body></html>`
