import { stagePreferences } from '@harness-world/frontend'

/** Host-owned outer page. Creator presentation lives in the child frame. */
export const HOST_ACTIVITY_PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Perspectra 试玩</title>
<style>
/* 宿主外壳：与舞台、启动器同一套主题色；只保留一层很薄的顶栏。 */
/* 黑白两色，跟随系统浅色／深色；变量名沿用舞台的旧名字，外壳其余规则不变。 */
:root{--ink:#f7f7f7;--ink-0:#ffffff;--ink-2:#efefef;--ink-3:#ffffff;--lamp:#111111;--lamp-strong:#000000;--lamp-deep:#333333;--lamp-ink:#ffffff;--text:#111111;--muted:#555555;--faint:#8c8c8c;--say:#111111;--act:#5a5a5a;--narr:#333333}
@media(prefers-color-scheme:dark){:root{--ink:#0d0d0d;--ink-0:#080808;--ink-2:#171717;--ink-3:#222222;--lamp:#f2f2f2;--lamp-strong:#ffffff;--lamp-deep:#cccccc;--lamp-ink:#111111;--text:#f2f2f2;--muted:#b3b3b3;--faint:#7c7c7c;--say:#f5f5f5;--act:#a6a6a6;--narr:#d0d0d0}}
:root{
  color-scheme:light dark;font:13px/1.6 "Segoe UI Variable Text","Segoe UI","PingFang SC","Microsoft YaHei UI","Microsoft YaHei",sans-serif;
  background:var(--ink);color:var(--text);
  --gold:var(--lamp);--gold-hover:var(--lamp-strong);--gold-line:color-mix(in srgb,var(--lamp) 38%,transparent);
  --danger:#f08a7e;
  --line:color-mix(in srgb,var(--text) 9%,transparent);--line-strong:color-mix(in srgb,var(--text) 17%,transparent);
  --font-story:"Noto Serif SC","Source Han Serif SC","Source Han Serif CN","Songti SC","STSong",serif;
  --ease-out:cubic-bezier(0.16, 1, 0.3, 1);
}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;height:100dvh;position:relative;overflow:hidden;background:var(--ink)}
button,input,select,summary{font:inherit}
button,summary{cursor:pointer}
button{
  padding:8px 14px;border:1px solid var(--line-strong);border-radius:9px;
  background:color-mix(in srgb,var(--text) 5.0%,transparent);color:var(--text);
  transition:background .2s var(--ease-out),border-color .2s var(--ease-out),color .2s var(--ease-out);
}
button:hover:not(:disabled){background:color-mix(in srgb,var(--text) 10.0%,transparent);border-color:color-mix(in srgb,var(--text) 28.0%,transparent)}
button:active:not(:disabled){transform:scale(.98)}
button:disabled{opacity:.36;cursor:default;transform:none!important}
:focus-visible{outline:2px solid var(--gold);outline-offset:3px}

header{
  position:absolute;inset:0 0 auto;z-index:10;height:40px;
  display:flex;align-items:center;justify-content:space-between;
  padding:4px 16px 4px 20px;background:var(--ink-0);
  border-bottom:1px solid color-mix(in srgb,var(--text) 6.0%,transparent);
}
.brand strong{font:700 14px var(--font-story);letter-spacing:.14em;color:var(--gold)}
.brand small,#frontend-status{display:none}
.toolbar{display:flex;align-items:center;gap:6px}
.toolbar button{padding:4px 12px;font-size:12px;border-radius:999px}
#host-tail-tools{display:flex;align-items:center;gap:4px;margin-right:4px}
#host-candidate-count{font-size:11.5px;color:var(--faint)}
#escape{margin-left:4px;color:#f2a497;border-color:rgba(240,138,126,.3);background:transparent}
#escape:hover:not(:disabled){background:rgba(240,138,126,.1);border-color:rgba(240,138,126,.55)}
#tools{position:relative}
#tools>summary{
  list-style:none;padding:4px 12px;border:1px solid var(--line-strong);
  border-radius:999px;font-size:12px;color:var(--muted);transition:all .2s var(--ease-out);
}
#tools>summary:hover{color:var(--text);background:color-mix(in srgb,var(--text) 6.0%,transparent)}
#tools>summary::-webkit-details-marker{display:none}
.tool-menu{
  position:absolute;right:0;top:36px;width:230px;padding:8px;
  background:color-mix(in srgb,var(--ink-2) 97.0%,transparent);
  border:1px solid var(--line-strong);border-radius:12px;
  box-shadow:0 16px 48px rgba(0,0,0,.6);display:grid;gap:2px;
  animation:menuPop .2s var(--ease-out);
}
@keyframes menuPop{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
.tool-menu button{text-align:left;border:0;background:transparent;border-radius:8px;padding:7px 10px;font-size:12.5px}
.tool-menu button:hover:not(:disabled){color:var(--gold-hover);background:color-mix(in srgb,var(--lamp) 10.0%,transparent)}
.tool-menu p{margin:6px 10px 2px;font-size:11px;color:var(--faint)}

iframe{
  position:absolute;inset:40px 0 0;width:100%;height:calc(100dvh - 40px);
  border:0;background:var(--ink);
}

#game{
  position:absolute;z-index:8;right:20px;top:54px;width:310px;margin:0;padding:18px 18px 16px;
  background:linear-gradient(180deg,color-mix(in srgb,var(--ink-3) 90.0%,transparent),color-mix(in srgb,var(--ink) 95.0%,transparent));
  border:1px solid var(--line-strong);border-radius:18px;
  box-shadow:0 18px 50px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.05);
  max-height:calc(100dvh - 74px);overflow:auto;
  backdrop-filter:blur(22px) saturate(140%);
  -webkit-backdrop-filter:blur(22px) saturate(140%);
  transition:border-color .2s var(--ease-out),padding .25s var(--ease-out);
}
#game:hover{border-color:var(--gold-line)}
#game:not([open]){width:310px;padding:12px 16px}
#game[open] > :not(summary){animation:expandDown .26s var(--ease-out)}
@keyframes expandDown{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
.activity-heading{display:grid;grid-template-columns:1fr auto;gap:3px 8px;list-style:none}
.activity-heading::-webkit-details-marker{display:none}
.activity-heading small{font-size:11px;font-weight:600;letter-spacing:.14em;color:var(--gold)}
.activity-heading strong{font:700 17px/1.35 var(--font-story);letter-spacing:.06em;grid-column:1;overflow-wrap:anywhere}
#activity-toggle{grid-column:2;grid-row:1/4;align-self:center;font-size:11.5px;color:var(--gold)}
#card-status{grid-column:1;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
#activity-toggle:after{content:"展开操作"}
#game[open] #activity-toggle:after{content:"收起"}

#round{color:var(--faint);font-size:11.5px;letter-spacing:.06em;margin:14px 0 2px}
.activity-section-label{font-size:11px;font-weight:600;letter-spacing:.14em;color:var(--gold);margin:16px 0 8px}
#activity-objective{
  font:14px/1.85 var(--font-story);color:var(--narr);margin:8px 0 12px;
  border-left:2px solid var(--gold);white-space:pre-wrap;overflow-wrap:anywhere;
  background:color-mix(in srgb,var(--lamp) 6.0%,transparent);border-radius:0 8px 8px 0;padding:8px 10px 8px 14px;
}
#activity-state{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:8px 0 14px}
#activity-state div{padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--ink-2);min-width:0}
#activity-state dt{font-size:11px;color:var(--faint);letter-spacing:.06em}
#activity-state dd{margin:4px 0 0;font:700 20px/1.2 var(--font-story);color:var(--gold-hover);overflow-wrap:anywhere}
#options,#management{display:flex;flex-direction:column;gap:8px}
.operation{border:1px solid var(--line);border-radius:14px;padding:14px;background:color-mix(in srgb,var(--text) 3.0%,transparent);display:grid;gap:12px}
.operation label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--muted)}
.operation input,.operation select,#options>label select{
  padding:9px 12px;border:1px solid var(--line-strong);border-radius:10px;
  background:var(--ink-0);color:var(--text);min-width:0;width:100%;
  transition:border-color .2s var(--ease-out),box-shadow .2s var(--ease-out);
}
.operation input:focus,.operation select:focus,#options>label select:focus{border-color:var(--gold-line);box-shadow:0 0 0 3px color-mix(in srgb,var(--lamp) 12.0%,transparent);outline:none}
.operation input[type="checkbox"]{width:auto;align-self:flex-start}
#options>button,.operation>button{
  background:linear-gradient(160deg,var(--lamp-strong),var(--lamp) 60%,var(--lamp-deep));color:var(--lamp-ink);
  border:0;font-weight:700;letter-spacing:.06em;text-align:center;padding:10px 16px;border-radius:10px;
  box-shadow:0 6px 18px color-mix(in srgb,var(--lamp) 22.0%,transparent);
}
#options>button:hover:not(:disabled),.operation>button:hover:not(:disabled){filter:brightness(1.06);background:linear-gradient(160deg,var(--lamp-strong),var(--lamp) 60%,var(--lamp-deep))}
#options>button[data-tone="danger"]{background:transparent;color:#f2a497;border:1px solid rgba(240,138,126,.3);font-weight:500;box-shadow:none}
#options>button[data-tone="danger"]:hover:not(:disabled){background:rgba(240,138,126,.1);border-color:rgba(240,138,126,.55)}
#management{border-top:1px solid var(--line);margin-top:12px;padding-top:10px}
#management button{font-size:12px;color:var(--muted);text-align:left;border:0;background:transparent;padding:6px 8px;border-radius:8px}
#management button:hover:not(:disabled){color:var(--gold-hover);background:color-mix(in srgb,var(--lamp) 8.0%,transparent)}
#activity-feedback{font-size:12.5px;color:var(--gold-hover);white-space:pre-wrap;overflow-wrap:anywhere;padding-top:10px}
#activity-feedback[data-type="error"]{color:#f2a497}
#activity-feedback:empty,#management:empty{display:none}

#notice,#memory-status{
  position:absolute;z-index:11;top:52px;left:20px;max-width:min(680px,calc(100% - 40px));
  margin:0;color:var(--lamp-strong);border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;
}
#memory-status{top:96px}
#notice:not(:empty),#memory-status:not(:empty){
  padding:10px 18px;background:color-mix(in srgb,var(--ink-2) 96.0%,transparent);border:1px solid var(--line-strong);
  box-shadow:0 12px 38px rgba(0,0,0,.6);
}
#notice[data-type="error"]{color:#f2a497;border-color:rgba(240,138,126,.35)}

@media(min-width:1600px){
  #game{right:28px;width:340px;padding:20px}
  #game:not([open]){width:340px}
}
@media(max-width:760px){
  header{padding:4px 10px 4px 14px}
  .toolbar{gap:4px}.toolbar button{font-size:11px;padding:4px 9px}
  #game{right:12px;top:50px;width:calc(100% - 24px);max-height:38dvh}
  #game:not([open]){width:220px;max-height:90px}
  #escape{font-size:11px;margin-left:2px}
  #notice,#memory-status{left:12px}
}
</style></head><body>
<header><div class="brand"><strong>Perspectra</strong><small>游玩中</small></div><span id="frontend-status" role="status">正在载入</span><div class="toolbar"><span id="host-tail-tools" hidden><button id="host-candidate-prev" type="button" aria-label="上一个候选">‹</button><span id="host-candidate-count"></span><button id="host-candidate-next" type="button" aria-label="下一个候选">›</button><button id="regenerate" type="button" aria-label="重新生成" title="重新生成此回合" disabled>↻</button></span><details id="tools"><summary>工具 ···</summary><div class="tool-menu"><button id="cancel-regenerate" type="button" hidden>取消重新生成</button><button id="reload-frontend" type="button">重新加载界面</button><button id="default-frontend" type="button">切换官方默认界面</button><button id="memory" type="button" hidden>整理长期记忆</button><p>这些操作不会清空已提交的进度。</p></div></details><button id="save-progress" type="button">保存进度</button><button id="escape" type="button" title="逃生：中止活动并恢复自由互动">中止活动</button></div></header>
<p id="notice" role="status"></p><p id="memory-status" role="status"></p>
<details id="game" hidden><summary class="activity-heading"><small>当前活动</small><strong id="title"></strong><span id="activity-toggle"></span><span id="card-status"></span></summary><p id="round"></p><p id="activity-objective"></p><dl id="activity-state"></dl><p class="activity-section-label">可执行操作</p><div id="options"></div><p id="activity-feedback" role="status"></p><div id="management"></div></details>
<iframe id="experience" title="游戏界面" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
<script>
(() => {
  const token=new URLSearchParams(location.hash.slice(1)).get('token')||'';
  history.replaceState(null,'',location.pathname);
  window.addEventListener('hashchange',()=>history.replaceState(null,'',location.pathname));

  const node=id=>document.getElementById(id);
  const frame=node('experience');
  let port=null,connected=false,frameLoaded=false,frontendReady=false,useDefault=false,init=null,playerView=null;
  let epoch=0,streamController=null,readingPending=true,historyOpen=false,presentationMode='reading',readHistorySignature='',shownActivity,panelOpenSent=null;
  function revoke(){readingPending=true;historyOpen=false;shownActivity=undefined;panelOpenSent=null;readHistorySignature='';node('game').open=false;epoch++;if(port)port.close();port=null;connected=false;frameLoaded=false;frontendReady=false}
  async function publicApi(path,payload){
    const response=await fetch('/frontend-api/v1/'+path,{method:payload===undefined?'GET':'POST',
      headers:{'x-playtest-token':token,'content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
    const value=await response.json();if(!response.ok){const error=new Error(value.error||'公开接口请求失败');error.status=response.status;throw error}return value;
  }
  function post(value){if(port)port.postMessage(value)}
  function applyView(next,notify=true){
    if(!playerView){playerView=next;return}
    const changes={};
    const selected=tail=>tail?.candidateIds?.[(tail.candidateIndex||1)-1]||null;
    const candidateChanged=playerView.tailRound?.id&&playerView.tailRound.id===next.tailRound?.id&&selected(playerView.tailRound)!==selected(next.tailRound);
    if(init?.frontend==='default'&&candidateChanged){readingPending=true;shownActivity=next.activity?{title:next.activity.title,game:{active:next.activity.active,phase:next.activity.phase,public:next.activity.public}}:null;node('game').open=false;panelPresentation()}

    for(const key of ['game','player','scene','status','canInterrupt','responders','expression','actions','tailRound','settings','activity','activities','feedback','statusBar','statusTruth','items'])if(JSON.stringify(playerView[key])!==JSON.stringify(next[key]))changes[key]=next[key];
    if(JSON.stringify(playerView.history)!==JSON.stringify(next.history)){
      const prefix=playerView.history.length<=next.history.length&&playerView.history.every((line,i)=>JSON.stringify(line)===JSON.stringify(next.history[i]));
      if(prefix)changes.historyAppend=next.history.slice(playerView.history.length);else changes.history=next.history;
    }
    if(init?.frontend==='default'&&JSON.stringify(playerView.history)!==JSON.stringify(next.history)){readingPending=true;if(!changes.historyAppend)shownActivity=next.activity?{title:next.activity.title,game:{active:next.activity.active,phase:next.activity.phase,public:next.activity.public}}:null;node('game').open=false;panelPresentation()}
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
        if(JSON.stringify(r).length>(['synthesizeSpeech','selectBgm'].includes(r.method)?100000:Math.max(8192,(playerView?.settings?.inputCharacters||2000)*6+2048))||!r.payload||typeof r.payload!=='object'||Array.isArray(r.payload))throw new Error('前端请求格式无效');
        // These controls belong only to the bundled stage, never to a pack's capability manifest.
        if(['stagePreferences','saveProgress'].includes(r.method)){
          if(init.frontend!=='default')throw new Error('仅官方默认舞台可使用此操作');
          if(r.method==='stagePreferences'){
            const preferences=normalizePreferences(r.payload);
            try{localStorage.setItem('perspectra.stage.preferences',JSON.stringify(preferences))}catch{}
            // Kept beyond this session by the launcher, once the player stops dragging a slider.
            clearTimeout(preferenceTimer);preferenceTimer=setTimeout(()=>api('/api/stage-preferences',preferences).catch(()=>{}),400);
            reply({ok:true,result:preferences});return;
          }
          if(!init.canSave||Object.keys(r.payload).join(',')!=='title'||typeof r.payload.title!=='string'||r.payload.title.length>80)throw new Error('保存请求无效');
          const result=await api('/api/story-save',{title:r.payload.title});reply({ok:true,result:result.node});return;
        }
        const grant={view:'view',history:'history',speak:'speak',perform:'perform',regenerate:'regenerate',selectCandidate:'regenerate',cancelRegeneration:'regenerate',resource:'resources',synthesizeSpeech:'speech',selectBgm:'bgm',getBgmAudio:'bgm'}[r.method];
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
        if(r.method==='selectBgm'){
          const result=await publicApi('bgm',r.payload);reply({ok:true,result});return;
        }
        if(['synthesizeSpeech','getBgmAudio'].includes(r.method)){
          const response=await fetch('/frontend-api/v1/'+(r.method==='getBgmAudio'?'bgm/audio':'speech'),{method:'POST',headers:{'x-playtest-token':token,'content-type':'application/json'},body:JSON.stringify(r.payload)});
          if(!response.ok){const value=await response.json();const error=new Error(value.error||'音频获取未完成');error.status=response.status;throw error}
          const contentType=response.headers.get('content-type'),bytes=await response.arrayBuffer();
          reply({ok:true,result:{contentType,bytes}});return;
        }
        const view=await publicApi('action',{requestId:r.requestId,actionId:r.actionId,operation:r.method,payload:r.payload});
        applyView(view);reply({ok:true,view});
      }catch(error){reply({ok:false,error:error.message||'前端操作失败',retryable:error.status!==400})}
    };
    port.start();
    frame.contentWindow.postMessage({type:'frontend-connect',apiVersion:1},init.frontendMode==='trusted'?init.frontendOrigin:'*',[channel.port2]);
    post({type:'initialized',apiVersion:1,frontendMode:init.frontendMode,capabilities:init.capabilities,view:playerView,...(init.frontend==='default'?{stagePreferences:readPreferences(),stageAssets:init.stageAssets,stageConfig:init.stageConfig,canSave:init.canSave}:{})});panelPresentation();
    node('frontend-status').textContent=init.frontend==='default'?'官方默认模板 · 沙箱':init.frontendMode==='trusted'?'游戏包前端 · 受信任':'游戏包前端 · 沙箱';
  }
  window.addEventListener('message',event=>{
    const expected=init?.frontendMode==='trusted'?init.frontendOrigin:'null';
    if(event.source!==frame.contentWindow||event.origin!==expected||event.data?.type!=='frontend-ready'||event.data.apiVersion!==1)return;
    frontendReady=true;connect();
  });
  window.addEventListener('message',event=>{
    if(init?.frontend!=='default'||event.source!==frame.contentWindow||event.origin!=='null'||event.data?.type!=='frontend-reading'||typeof event.data.pending!=='boolean')return;
    const changed=readingPending!==event.data.pending||historyOpen!==event.data.historyOpen||presentationMode!==event.data.mode||readHistorySignature!==event.data.historySignature;
    readingPending=event.data.pending;historyOpen=event.data.historyOpen===true;presentationMode=event.data.mode;readHistorySignature=event.data.historySignature;
    if(presentationMode==='response'||historyOpen)node('game').open=false;
    panelPresentation();if(changed){signature='';if(latest)render(latest);}

  });
  frame.onload=()=>{frameLoaded=true;connect()};
  const normalizePreferences=(${stagePreferences.toString()});
  let preferenceTimer=null;
  function readPreferences(){
    let stored={};try{stored=JSON.parse(localStorage.getItem('perspectra.stage.preferences')||'{}')}catch{}
    return normalizePreferences(stored,{...playerView?.settings?.reading,...playerView?.settings?.audio,...(playerView?.settings?.appearance?{appearance:playerView.settings.appearance}:{})});
  }
  async function mount(fallback=false){
    revoke();useDefault=fallback;
    init=await publicApi('init'+(fallback?'?template=default':''));
    readingPending=init.frontend==='default';historyOpen=false;signature='';if(latest)render(latest);
    playerView=init.view;
    frame.setAttribute('sandbox',init.frontendMode==='trusted'?'allow-scripts allow-same-origin':'allow-scripts');
    frame.src=init.frontend==='custom'&&!fallback?(init.frontendOrigin||'')+'/frontend/custom/index.html':'/frontend/default.html'+(init.theme&&!fallback?'?theme=1':'');
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

  let latest, posting=false, signature='', pending=null;
  // Page-local presentation only. Sequence orders notices, not requests or world events.
  let currentNotice=null, noticeSequence=0,noticeTimer=null;
  function setNotice(type,operation,content){
    clearTimeout(noticeTimer);currentNotice={type,operation,content,sequence:++noticeSequence};renderNotice();
    if(type==='success'){const sequence=noticeSequence;noticeTimer=setTimeout(()=>{if(currentNotice?.sequence===sequence)clearNotice()},4000)}
  }
  function clearNotice(){currentNotice=null;renderNotice()}
  function renderNotice(){
    const target=node('notice');target.textContent=currentNotice?.content||'';
    target.dataset.type=currentNotice?.type||'';
    target.dataset.operation=currentNotice?.operation||'';
    target.dataset.sequence=currentNotice?String(currentNotice.sequence):'';
    const feedback=node('activity-feedback');feedback.textContent=currentNotice?.operation==='activity'?currentNotice.content:'';feedback.dataset.type=currentNotice?.type||'';if(currentNotice?.operation==='activity')target.textContent='';
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
    if(posting||readingPending||node('game').hidden)return;
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
    const rawHistory=JSON.stringify(state.transcript.map(line=>[line.seq,line.speaker,line.text,line.segments]));
    const selected=tail=>tail?.candidateIds?.[(tail.candidateIndex||1)-1]||null;
    const blocked=init?.frontend==='default'&&(readingPending||rawHistory!==readHistorySignature||selected(state.tailRound)!==selected(playerView?.tailRound));
    if(shownActivity===undefined||!blocked)shownActivity=a?structuredClone(a):null;
    const shown=shownActivity;
    node('game').hidden=!shown||historyOpen||init?.frontend==='default';
    panelPresentation();
    if(blocked)node('activity-feedback').textContent='阅读当前演出后继续操作。';
    else if(!currentNotice&&shown?.game?.public?.lastResult)node('activity-feedback').textContent=shown.game.public.lastResult;
    if(!shown||!a)return;
    node('title').textContent=shown.title;
    const active=a.game?.active,display=shown.game?.public||{};
    node('card-status').textContent=(shown.suspended?'已暂停 · 进度保留':display.statusText||(shown.game?.active?'进行中':'尚未开始'))+(Number.isFinite(shown.game?.round)?' · 第 '+shown.game.round+' 回合':'');
    const phaseNames={playing:'进行中',investigation:'调查',prologue:'序章',finished:'已结束','host-aborted':'已中止'};
    node('round').textContent=(display.phaseLabel||phaseNames[shown.game?.phase]||shown.game?.phase||'准备')+(Number.isFinite(shown.game?.round)?' · 第 '+shown.game.round+' 回合':'');
    node('activity-objective').textContent=display.objective||display.instructions||display.description||'请选择当前允许的操作，完成后继续阅读情景中的回应。';
    node('activity-state').replaceChildren();
    const labels={round:'回合',clues:'线索',funds:'资金',stock:'库存',score:'得分',attempts:'次数',health:'生命',phase:'阶段'};
    for(const [key,value] of Object.entries(display)){if(['statusText','lastResult','objective','instructions','description','phaseLabel'].includes(key)||value===null||typeof value==='object')continue;const block=document.createElement('div'),label=document.createElement('dt'),content=document.createElement('dd');label.textContent=labels[key]||key;content.textContent=typeof value==='object'?JSON.stringify(value):String(value);block.append(label,content);node('activity-state').append(block)}
    const key=JSON.stringify([state.activities??[a],state.busy,state.paused,posting,blocked,pending?.requestId]);
    if(key===signature)return;
    signature=key;node('options').replaceChildren();node('management').replaceChildren();
    const add=(text,work,disabled=false,management=false)=>{
      const button=document.createElement('button');button.type='button';button.textContent=text;
      button.disabled=disabled;button.onclick=work;node(management?'management':'options').append(button);return button;
    };
    if(!active)for(const choice of state.activities||[a]){
      if(!choice.suspended&&choice.manualStart===false)continue;
      if(!choice.suspended&&choice.participantSelection){
        const selection=choice.participantSelection,label=document.createElement('label');label.textContent='参与角色';
        const picker=document.createElement('select');picker.multiple=selection.max>1;
        for(const candidate of selection.candidates){const item=document.createElement('option');item.value=candidate.id;item.textContent=candidate.name;picker.append(item)}
        picker.disabled=state.busy||state.paused||posting||blocked;label.append(picker);node('options').append(label);
        add('开始 '+choice.title,()=>{const npcIds=Array.from(picker.selectedOptions,item=>item.value);
          if(npcIds.length<selection.min||npcIds.length>selection.max){node('notice').textContent='请选择 '+selection.min+' 至 '+selection.max+' 名参与角色';return}
          send('start',{npcIds},choice)},state.busy||state.paused||posting||blocked||selection.candidates.length<selection.min);
      }else add((choice.suspended?'恢复 ':'开始 ')+choice.title,()=>send(choice.suspended?'resume':'start',{},choice),state.busy||state.paused||posting||blocked);
      if(choice.suspended){const giveUp=add('放弃 '+choice.title,()=>send('abandon',{},choice),state.busy||state.paused||posting||blocked);giveUp.dataset.tone='danger'}
    }
    else {
      add('暂停活动 · 保留进度',()=>send('suspend'),state.busy||state.paused||posting||blocked,true);
      for(const option of a.options||[]) {
        const group=document.createElement('div');group.className='operation';
        const fields=[];
        for(const [key,schema] of Object.entries(option.argumentSchema.properties)) {
          if(key==='activityId'||key==='revision')continue;
          const label=document.createElement('label');label.textContent=schema.title||key;
          let input;
          const candidates=schema.enum?.map(value=>({value,label:String(value)}))||(Array.isArray(schema.oneOf)&&schema.oneOf.every(choice=>Object.hasOwn(choice,'const'))?schema.oneOf.map(choice=>({value:choice.const,label:choice.title||String(choice.const)})):null);
          if(candidates){input=document.createElement('select');
            for(const [index,item] of candidates.entries()){const op=document.createElement('option');op.value=String(index);op.textContent=item.label;input.append(op)}}
          else {input=document.createElement('input');input.type=schema.type==='integer'||schema.type==='number'?'number':schema.type==='boolean'?'checkbox':'text';
            if(schema.minimum!==undefined)input.min=schema.minimum;if(schema.maximum!==undefined)input.max=schema.maximum;}
          input.disabled=state.busy||state.paused||posting||blocked;
          label.append(input);group.append(label);fields.push([key,schema,input,candidates]);
        }
        const button=document.createElement('button');button.textContent=option.label;button.type='button';
        button.disabled=state.busy||state.paused||posting||blocked;
        button.onclick=()=> {
          const parameters={};
          for(const [key,schema,input,candidates] of fields) {
            if(input.type!=='checkbox'&&input.value===''){node('notice').textContent='请先填写 '+(schema.title||key);return;}
            parameters[key]=candidates?candidates[Number(input.value)].value:schema.type==='integer'||schema.type==='number'?Number(input.value):schema.type==='boolean'?input.checked:input.value;
          }
          send(option.definitionRef.id.slice('activity:'.length),parameters);
        };
        group.append(button);node('options').append(group);
      }
      if(a.game.turn!==a.participants[0])add('重试角色处理',()=>send('retry'),state.busy||state.paused||posting||blocked,true);
    }
    if(pending)add('重试同一请求',async()=>{
      if(posting)return;posting=true;clearNotice();
      try{const state=await api('/api/activity',pending);setNotice(state.error?'error':'success','activity',state.notice||'游戏操作已提交。');render(state);pending=null}
      catch(error){setNotice('error','activity',error.message)}
      finally{posting=false;signature='';await refresh()}
    },state.busy||posting);
  }
  async function refresh(){try{render(await api('/api/state'))}catch(error){if(currentNotice?.operation!=='activity'||currentNotice.type!=='error')setNotice('error','refresh',error.message+'；逃生入口仍可使用。')}}
  function panelPresentation(){
    const open=!!node('game').open&&!node('game').hidden&&!historyOpen;
    document.body.dataset.panel=init?.frontend==='default'&&open?'open':'closed';
    if(panelOpenSent!==open){panelOpenSent=open;post({type:'presentation',activityOpen:open})}
  }
  node('game').ontoggle=()=>{panelPresentation()};
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
  node('save-progress').onclick=async()=>{
    const title=prompt('节点名称（可留空）');
    if(title===null)return;
    node('save-progress').disabled=true;
    try{const result=await api('/api/story-save',{title});setNotice('success','story-save','已保存：'+result.node.title)}
    catch(error){setNotice('error','story-save',error.message)}
    finally{node('save-progress').disabled=false}
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
