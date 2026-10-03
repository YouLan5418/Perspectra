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
<header><strong>Perspectra</strong><small>宿主控制</small><button id="memory" type="button" hidden>整理长期记忆</button><button id="escape" type="button">逃生：中止活动并恢复</button></header>
<p id="notice" role="status"></p>
<section id="game" hidden><strong id="title"></strong><p id="round"></p><div id="options"></div></section>
<iframe id="experience" title="创作者世界页面" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
<script>
(() => {
  const token=new URLSearchParams(location.hash.slice(1)).get('token')||'';
  history.replaceState(null,'',location.pathname);
  document.getElementById('experience').src='/experience/#token='+encodeURIComponent(token);
  const node=id=>document.getElementById(id);
  let latest, posting=false, signature='', pending=null, lastError='';
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
    posting=true;pending=payload;lastError='';
    try{render(await api('/api/activity',payload));pending=null}
    catch(error){node('notice').textContent=error.message+'；可用逃生按钮中止活动。'}
    finally{posting=false;signature='';await refresh()}
  }
  function render(state) {
    latest=state;
    node('memory').hidden=state.debug?.memoryMode!=='core';
    node('memory').disabled=state.busy||posting;
    if(!posting)node('notice').textContent=lastError||state.notice||'';
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
      if(posting)return;posting=true;lastError='';
      try{render(await api('/api/activity',pending));pending=null}
      catch(error){lastError=error.message;node('notice').textContent=lastError}
      finally{posting=false;signature='';await refresh()}
    },state.busy||posting);
  }
  async function refresh(){try{render(await api('/api/state'))}catch(error){node('notice').textContent=error.message+'；逃生入口仍可使用。'}}
  node('memory').onclick=async()=>{
    if(posting)return;posting=true;lastError='';
    try{render(await api('/api/memory/refresh',{}))}
    catch(error){lastError=error.message;node('notice').textContent=lastError}
    finally{posting=false;await refresh()}
  };
  node('escape').onclick=async()=>{
    // Independent of current turn, creator options, pause or in-flight model work.
    node('escape').disabled=true;lastError='';
    try{render(await api('/api/escape',{}));pending=null}
    catch(error){lastError=error.message;node('notice').textContent=lastError}
    finally{node('escape').disabled=false;signature='';await refresh()}
  };
  setInterval(refresh,750);refresh();
})();
</script></body></html>`
