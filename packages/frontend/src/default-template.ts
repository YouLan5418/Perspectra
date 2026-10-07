export const DEFAULT_PAGE = String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Perspectra 对话</title><link rel="stylesheet" href="/frontend/default.css"></head>
<body><main><header><div><small id="template">PERSPECTRA DEFAULT</small><h1 id="title">正在连接</h1><p id="scene"></p></div><span id="status"></span></header><section id="history" aria-live="polite"></section><div id="actions" aria-label="可用操作"></div><div class="composer"><textarea id="input" maxlength="2000" placeholder="说些什么……" aria-label="玩家发言"></textarea><button id="send">发送</button></div><p id="notice" role="status"></p><p class="hint">普通文字作为发言。动作描写用 /narrate；受控行动经 Core 裁定。</p></main><script src="/frontend/sdk.js"></script><script src="/frontend/default.js"></script></body></html>`;
export const DEFAULT_STYLE = String.raw`:root{color-scheme:light;font:15px "Segoe UI",system-ui;background:#f6f5f1;color:#293a34}*{box-sizing:border-box}body{margin:0}main{max-width:940px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;align-items:center}small,.hint{font-size:12px;color:#758178;letter-spacing:.12em}h1{font-size:26px;margin:9px 0}p{line-height:1.5}#scene{color:#788178}#history{height:55vh;overflow:auto;padding:20px;border:1px solid #dde2d9;border-radius:14px;background:#fff}.line{max-width:85%;padding:12px 17px;margin:0 0 15px;background:#edf0ea;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere}.line.player{margin-left:auto;background:#ddebe1}.speaker{display:block;font-size:12px;color:#708277;margin-bottom:5px}.composer{display:flex;gap:10px}textarea{flex:1;min-height:75px;padding:14px;border:1px solid #d2dacf;border-radius:10px;font:inherit;resize:vertical}button{font:inherit;padding:11px 18px;border:1px solid #526c5d;border-radius:9px;background:#294d3e;color:#fff;cursor:pointer}button:disabled{opacity:.45;cursor:default}#actions{display:flex;gap:8px;flex-wrap:wrap;margin:13px 0}#actions button{background:transparent;color:#41624e;padding:7px 12px}#notice{color:#8b653e;min-height:20px}.hint{letter-spacing:0}@media(max-width:600px){main{padding:16px}.composer{flex-wrap:wrap}.composer button{width:100%}}`;
export const DEFAULT_SCRIPT = String.raw`(() => {
 const api=window.Perspectra,node=id=>document.getElementById(id);
 let latest,posting=false,pending;
 function render(view){
   latest=view;node('title').textContent=view.game.title;
   node('scene').textContent=view.scene?view.scene.locationName+' · '+(view.scene.visibleCharacters.join('、')||'眼前没有其他角色'):'场景尚未开始';
   node('status').textContent=({ready:'可以输入',busy:'角色正在回应',paused:'已暂停',error:'处理未完成'})[view.status];
   node('history').replaceChildren();
   for(const line of view.history){
     const article=document.createElement('article');article.className='line'+(line.player?' player':'');
     const speaker=document.createElement('strong');speaker.className='speaker';speaker.textContent=line.speaker;
     article.append(speaker,document.createTextNode(line.text));node('history').append(article);
   }
   node('history').scrollTop=node('history').scrollHeight;
   node('actions').replaceChildren();
   for(const option of view.actions){
     const button=document.createElement('button');button.textContent=option.label;button.disabled=posting||view.status!=='ready';
     button.onclick=()=>send('perform',{optionId:option.id});node('actions').append(button);
   }
   node('send').disabled=posting||view.status!=='ready';
 }
 async function send(method,payload){
   if(posting)return;posting=true;
   pending={method,payload,actionId:api.newActionId()};node('send').disabled=true;node('notice').textContent='正在提交……';
   try{render(await api.request(method,payload,pending.actionId));if(method==='speak')node('input').value='';pending=null;node('notice').textContent=''}
   catch(error){node('notice').textContent=error.message+' 同一请求可点击“重试同一操作”，不会重复执行。'}
   finally{posting=false;render(await api.getView());node('retry').hidden=!pending}
 }
 const retry=document.createElement('button');retry.id='retry';retry.textContent='重试同一操作';retry.hidden=true;node('notice').after(retry);
 retry.onclick=async()=>{if(posting||!pending)return;posting=true;try{render(await api.request(pending.method,pending.payload,pending.actionId));pending=null;node('notice').textContent='';retry.hidden=true}catch(error){node('notice').textContent=error.message}finally{posting=false;render(await api.getView())}};
 node('send').onclick=()=>{const text=node('input').value.trim();if(text)send('speak',{text})};
 node('input').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();node('send').click()}};
 api.subscribe(event=>{if(event.view)render(event.view);if(event.type==='disconnected'){node('status').textContent='连接断开';node('send').disabled=true}});
 api.ready.then(info=>render(info.view));
})();`;
