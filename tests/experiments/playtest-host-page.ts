/** Host-owned outer page. Creator presentation lives in the child frame. */
export const HOST_ACTIVITY_PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Perspectra 试玩</title>
<style>
:root{color-scheme:light;font:13px "Segoe UI","Microsoft YaHei",system-ui;background:#f4f3ef;color:#344237;--border:#dee3d7}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;height:100dvh;display:flex;flex-direction:column}button,input,select,summary{font:inherit}button,summary{cursor:pointer}button:disabled{opacity:.45;cursor:default}:focus-visible{outline:2px solid #688e77;outline-offset:3px}
header{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 32px;background:#fafbf6;border-bottom:1px solid var(--border);flex-shrink:0}.brand{display:flex;align-items:center;gap:13px}.brand strong{font-size:18px;font-weight:600;letter-spacing:-.6px}.brand small{font-size:10px;color:#8b9681;border-left:1px solid #dce1d5;padding-left:13px}#frontend-status{font-size:10px;color:#85917b;line-height:1.5}.toolbar{display:flex;align-items:center;gap:8px}button{padding:8px 12px;border:1px solid #dce3d3;border-radius:6px;background:#fdfefb;color:#607653}button:hover:not(:disabled){background:#edf2e5}#escape{color:#94654e;background:transparent;border-color:#e3dcd1;font-size:11px;white-space:nowrap}
#tools{position:relative}#tools>summary{list-style:none;border:1px solid #dce3d3;border-radius:6px;padding:8px 12px;font-size:11px;background:#fff}#tools>summary::-webkit-details-marker{display:none}.tool-menu{position:absolute;right:0;top:40px;width:220px;padding:8px;background:#fdfefb;border:1px solid #dce3d3;border-radius:9px;box-shadow:0 8px 30px #34423716;display:grid;gap:4px}.tool-menu button{text-align:left;border:0;background:transparent;font-size:12px}.tool-menu p{margin:4px 8px 6px;font-size:10px;line-height:1.6;color:#939e89}
#notice,#memory-status{margin:0;flex-shrink:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.6;background:#f5f4e9}#notice:not(:empty),#memory-status:not(:empty){padding:8px 32px;border-bottom:1px solid #e5e3d5}#notice[data-type="error"]{color:#995b43;background:#fbf0e9}#notice[data-type="success"]{color:#54734d}#memory-status{color:#7c885e}
#game{position:static;order:1;flex-shrink:0;width:calc(100% - 32px);margin:0 16px 12px;padding:15px 16px;background:#fdfef9;border:1px solid var(--border);border-radius:10px;box-shadow:0 6px 24px #34423712;max-height:40dvh;overflow:auto}.activity-heading{display:flex;align-items:center;gap:8px;list-style:none;cursor:pointer}.activity-heading::-webkit-details-marker{display:none}#activity-toggle{margin-left:auto;font-size:10px;color:#8d9b80}#game[open] #activity-toggle{font-size:0}#game[open] #activity-toggle:after{content:"收起玩法";font-size:10px}.activity-heading small{font-size:10px;letter-spacing:1px;color:#93a183}.activity-heading strong{font-weight:600;font-size:13px;min-width:0;overflow-wrap:anywhere}#activity-toggle{flex-shrink:0}#round{margin:8px 0 12px;color:#869476;font-size:11px;line-height:1.7}#options{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px}.operation{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;border:1px solid #e3e9da;border-radius:7px;padding:8px;background:#f7f9f1}.operation label{display:flex;gap:6px;align-items:center;font-size:11px;color:#82926e}.operation input,.operation select{padding:7px 9px;border:1px solid #dce3d3;border-radius:5px;background:#fff;max-width:160px;min-width:0;width:100px}.operation input[type="checkbox"]{width:auto}#options button{font-size:11px}

iframe{display:block;width:100%;flex:1;min-height:0;border:0;background:#f4f3ef}@media(max-width:640px){header{padding:12px 14px;flex-wrap:wrap;gap:8px}.brand{gap:8px}.brand small{padding-left:8px}.toolbar{margin-left:auto}#frontend-status{max-width:160px}#game{position:static;order:1;width:calc(100% - 28px);margin:0 14px 12px;padding:12px;max-height:28dvh;flex-shrink:0;box-shadow:none}#notice:not(:empty),#memory-status:not(:empty){padding:8px 14px}.tool-menu{width:210px}.operation{max-width:100%}.activity-heading{flex-wrap:wrap}}
@media(prefers-color-scheme:dark){
:root{color-scheme:dark;background:#101010;color:#e5e5e5;--border:#353535}
:focus-visible{outline-color:#d0d0d0}
header{background:#161616}.brand small{color:#999;border-color:#353535}#frontend-status{color:#b0b0b0}
button,#tools>summary{background:#191919;color:#e5e5e5;border-color:#353535}button:hover:not(:disabled){background:#282828}
#escape{color:#d5aa8c;border-color:#404040}.tool-menu{background:#191919;border-color:#353535;box-shadow:0 8px 30px #0005}.tool-menu p{color:#999}
#notice,#memory-status{background:#202020;color:#b0b0b0}#notice:not(:empty),#memory-status:not(:empty){border-color:#353535}#notice[data-type="error"]{color:#e4ad96;background:#30221e}#notice[data-type="success"]{color:#d0d0d0}
#game{background:#191919;box-shadow:0 6px 24px #0004}#activity-toggle,.activity-heading small,#round,.operation label{color:#b0b0b0}
.operation{background:#202020;border-color:#353535}.operation input,.operation select{background:#161616;color:#e5e5e5;border-color:#404040}iframe{background:#101010}
}
</style></head><body>
<header><div class="brand"><strong>Perspectra</strong><small>游玩中</small></div><span id="frontend-status" role="status">正在载入</span><div class="toolbar"><span id="host-tail-tools" hidden><button id="host-candidate-prev" type="button" aria-label="上一个候选">‹</button><span id="host-candidate-count"></span><button id="host-candidate-next" type="button" aria-label="下一个候选">›</button><button id="regenerate" type="button" aria-label="重新生成" title="重新生成此回合" disabled>↻</button></span><details id="tools"><summary>游戏工具 ···</summary><div class="tool-menu"><button id="cancel-regenerate" type="button" hidden>取消重新生成</button><button id="reload-frontend" type="button">重新加载界面</button><button id="default-frontend" type="button">切换官方默认界面</button><button id="memory" type="button" hidden>整理长期记忆</button><p>这些操作不会清空已提交的进度。</p></div></details><button id="escape" type="button" title="逃生：中止活动并恢复自由互动">中止活动 / 恢复</button></div></header>
<p id="notice" role="status"></p><p id="memory-status" role="status"></p>
<details id="game" hidden><summary class="activity-heading"><small>活动</small><strong id="title"></strong><span id="activity-toggle">展开玩法</span></summary><p id="round"></p><div id="options"></div></details>
<iframe id="experience" title="游戏界面" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
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
    const value=await response.json();if(!response.ok){const error=new Error(value.error||'公开接口请求失败');error.status=response.status;throw error}return value;
  }
  function post(value){if(port)port.postMessage(value)}
  function applyView(next,notify=true){
    if(!playerView){playerView=next;return}
    const changes={};
    for(const key of ['game','player','scene','status','actions','tailRound','settings','activity','feedback'])if(JSON.stringify(playerView[key])!==JSON.stringify(next[key]))changes[key]=next[key];
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
        if(JSON.stringify(r).length>Math.max(8192,(playerView?.settings?.inputCharacters||2000)*6+2048)||!r.payload||typeof r.payload!=='object'||Array.isArray(r.payload))throw new Error('前端请求格式无效');
        const grant={view:'view',history:'history',speak:'speak',perform:'perform',regenerate:'regenerate',selectCandidate:'regenerate',cancelRegeneration:'regenerate',resource:'resources'}[r.method];
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
      }catch(error){reply({ok:false,error:error.message||'前端操作失败',retryable:error.status!==400})}
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
  node('reload-frontend').onclick=()=>{node('tools').open=false;mount(useDefault).catch(()=>node('frontend-status').textContent='前端载入失败')};
  node('default-frontend').onclick=()=>{node('tools').open=false;mount(true).catch(()=>node('frontend-status').textContent='默认模板载入失败')};
  window.addEventListener('pagehide',()=>{streamController?.abort();revoke()});
  mount().then(events).catch(()=>node('frontend-status').textContent='前端初始化失败');

  let latest, posting=false, signature='', pending=null, activityActive=false;
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
    if(!response.ok){const error=new Error(value.error||'请求失败');error.status=response.status;throw error}
    return value;
  }
  async function send(operation,parameters={},selected=latest?.activity) {
    if(posting)return;
    const a=selected;
    if(!a)return;
    const payload={activityKey:a.activityKey,activityId:operation==='start'?null:a.id,
      revision:operation==='start'?0:a.revision,operation,parameters,requestId:crypto.randomUUID()};
    posting=true;pending=payload;clearNotice();
    try{const state=await api('/api/activity',payload);setNotice(state.error?'error':'success','activity',state.notice||'游戏操作已提交。');render(state);pending=null}
    catch(error){setNotice('error','activity',error.message+'；可用逃生按钮中止活动。')}
    finally{posting=false;signature='';await refresh()}
  }
  function render(state) {
    latest=state;
    node('regenerate').disabled=!state.tailRound?.canRegenerate||posting;
    const tail=state.tailRound,count=tail?.candidateIds?.length||1,index=tail?.candidateIndex||1;
    node('host-tail-tools').hidden=init?.frontend==='default'||!tail?.id;
    node('host-candidate-count').textContent=index+'/'+count;
    node('host-candidate-prev').disabled=!tail?.canRegenerate||posting||index<=1;
    node('host-candidate-next').disabled=!tail?.canRegenerate||posting||index>=count;
    node('cancel-regenerate').hidden=!state.tailRound?.regenerating;
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
    if(Boolean(active)!==activityActive){node('game').open=Boolean(active)&&init?.frontend==='default';activityActive=Boolean(active)}
    node('round').textContent=active
      ? '第 '+a.game.round+' 个游戏回合 · '+(a.game.public.statusText||(a.game.turn===a.participants[0]?'轮到你':'轮到角色'))
        +' · '+(a.game.public.lastResult||'')
      : a.suspended?'活动已暂停，进度保留；可以自由互动或选择另一活动。':a.game?.phase==='host-aborted'?'活动已中止，已恢复自由互动。':a.game?.public.lastResult||'可以开始一局游戏。';
    const key=JSON.stringify([state.activities??[a],state.busy,state.paused,posting,pending?.requestId]);
    if(key===signature)return;
    signature=key;node('options').replaceChildren();
    const add=(text,work,disabled=false)=>{
      const button=document.createElement('button');button.type='button';button.textContent=text;
      button.disabled=disabled;button.onclick=work;node('options').append(button);return button;
    };
    if(!active)for(const choice of state.activities||[a]){
      if(!choice.suspended&&choice.participantSelection){
        const selection=choice.participantSelection,label=document.createElement('label');label.textContent='参与角色';
        const picker=document.createElement('select');picker.multiple=selection.max>1;
        for(const candidate of selection.candidates){const item=document.createElement('option');item.value=candidate.id;item.textContent=candidate.name;picker.append(item)}
        picker.disabled=state.busy||state.paused||posting;label.append(picker);node('options').append(label);
        add('开始 '+choice.title,()=>{const npcIds=Array.from(picker.selectedOptions,item=>item.value);
          if(npcIds.length<selection.min||npcIds.length>selection.max){node('notice').textContent='请选择 '+selection.min+' 至 '+selection.max+' 名参与角色';return}
          send('start',{npcIds},choice)},state.busy||state.paused||posting||selection.candidates.length<selection.min);
      }else add((choice.suspended?'继续 ':'开始 ')+choice.title,()=>send(choice.suspended?'resume':'start',{},choice),state.busy||state.paused||posting);
      if(choice.suspended)add('放弃 '+choice.title,()=>send('abandon',{},choice),state.busy||state.paused||posting);
    }
    else {
      add('暂停 '+a.title,()=>send('suspend'),state.busy||state.paused||posting);
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
  let regenerationRequest=null;
  node('regenerate').onclick=async()=>{
    node('tools').open=false;
    if(!latest?.tailRound?.canRegenerate||posting)return;
    if(!regenerationRequest||regenerationRequest.tailId!==latest.tailRound.id)regenerationRequest={tailId:latest.tailRound.id,requestId:crypto.randomUUID()};
    posting=true;clearNotice();
    try{const state=await api('/api/regenerate',regenerationRequest);regenerationRequest=null;setNotice('success','regenerate',state.notice);render(state)}
    catch(error){if(error.status)regenerationRequest=null;setNotice('error','regenerate',error.message)}
    finally{posting=false;await refresh()}
  };
  async function chooseCandidate(offset){
    const tail=latest?.tailRound,candidateId=tail?.candidateIds?.[(tail.candidateIndex||1)-1+offset];
    if(!candidateId||!tail.canRegenerate||posting)return;
    posting=true;clearNotice();const id=crypto.randomUUID();
    try{await publicApi('action',{requestId:id,actionId:id,operation:'selectCandidate',payload:{tailId:tail.id,candidateId}})}
    catch(error){setNotice('error','candidate',error.message)}finally{posting=false;await refresh()}
  }
  node('host-candidate-prev').onclick=()=>chooseCandidate(-1);node('host-candidate-next').onclick=()=>chooseCandidate(1);
  node('cancel-regenerate').onclick=async()=>{try{await api('/api/regenerate/cancel',{});regenerationRequest=null}catch(error){setNotice('error','regenerate',error.message)}};
  node('memory').onclick=async()=>{
    node('tools').open=false;
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
