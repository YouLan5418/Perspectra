export const DEFAULT_PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Perspectra 对话</title><link rel="stylesheet" href="/frontend/default.css"></head>
<body><main>
  <header class="world-header"><div><p class="eyebrow">你的故事，正在继续</p><h1 id="title">正在进入世界</h1></div><span id="status" role="status">正在连接</span></header>
  <div class="workspace">
    <aside class="sidebar" aria-label="场景与行动">
      <section class="scene-card"><p class="eyebrow">当前场景</p><h2 id="scene">场景尚未开始</h2><div id="characters" aria-label="当前可见角色"></div></section>
      <details class="action-panel" open><summary>可用行动 <span id="action-count">0</span></summary><div id="actions"></div></details>
      <p class="hint">发言与细节描写可以一起发送。行动选项由当前场景与规则提供；选择后会直接执行。</p>
    </aside>
    <section class="conversation" aria-label="故事与对话">
      <div class="conversation-heading"><span>故事与对话</span><span id="player"></span></div>
      <section id="history" aria-label="玩家可见对话记录" aria-live="polite" aria-relevant="additions text"></section>
      <div id="round-tools" class="round-tools" role="group" aria-label="末端回合候选" hidden><button id="candidate-prev" type="button" aria-label="上一个候选" title="上一个候选">‹</button><span id="candidate-count" aria-live="polite"></span><button id="candidate-next" type="button" aria-label="下一个候选" title="下一个候选">›</button><button id="regenerate-round" type="button" aria-label="重新生成" title="重新生成此回合"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 3l1 3M4 12l1 3a8 8 0 0 0 13 3"/></svg></button><button id="cancel-round" type="button" aria-label="取消重新生成" title="取消重新生成" hidden>停止</button></div>
      <button id="latest" class="latest secondary" type="button" hidden>回到最新对话 ↓</button>
      <div class="composer"><div class="audience-heading"><strong>发送消息</strong><span id="audience-badge">公开发言</span></div>
        <fieldset class="audience-options"><legend class="visually-hidden">发言范围</legend>
          <label><input type="radio" name="speech-scope" value="scene_public" checked>公开 — 在场且有权观察的角色都能听见</label>
          <label><input type="radio" name="speech-scope" value="direct">定向 — 只有指定接收者收到，其他人不知情</label>
          <label><input type="radio" name="speech-scope" value="private">私密 — 其他人只知道发生了私密交流</label>
          <label><input type="radio" name="speech-scope" value="self">仅自己 — 不向其他角色发送</label>
        </fieldset>
        <div id="recipient-panel" hidden><label for="speech-recipient">接收对象</label><select id="speech-recipient"></select><p id="recipient-hint" class="hint" hidden>当前没有可接收发言的角色。</p></div>
        <label class="visually-hidden" for="input">写下你的回应</label><textarea id="input" maxlength="2000" placeholder="说出你想对角色说的话……" rows="2"></textarea>
        <details class="narration-composer" id="narration-panel"><summary>细节描写 <span>可选 · 与发言一起提交</span></summary><label class="visually-hidden" for="narration">细节描写</label><textarea id="narration" maxlength="2000" placeholder="描写你的动作、神态或语气。不会直接改变位置或物品归属。" rows="2"></textarea></details>
        <p id="audience-preview" class="audience-preview" aria-live="polite"></p><div class="composer-footer"><span>Enter 发送 · Shift + Enter 换行</span><button id="send" type="button">发送 <span aria-hidden="true">↑</span></button></div>
        <div class="feedback"><p id="notice" role="status"></p><button id="retry" class="secondary" type="button" hidden>重试同一操作</button></div>
      </div>
    </section>

  </div>
</main><script src="/frontend/sdk.js"></script><script src="/frontend/default.js"></script></body></html>`;

export const DEFAULT_STYLE = String.raw`
/* ===== 设计变量：改外观优先改这里 ===== */
:root{
  color-scheme:light;
  /* 底色与面板 */
  --bg:#f4f3ef;--surface:#fdfdf9;--surface-2:#fafbf6;--surface-sunken:#eeefe7;
  --border:#dfe3d8;--border-soft:#eceee6;
  /* 文字（均满足 AA 对比度） */
  --text:#2b362e;--text-story:#2c3830;--text-act:#5c675a;--text-muted:#5d675c;--text-faint:#6b746a;
  /* 强调色与玩家气泡 */
  --accent:#2f5a47;--accent-hover:#244a3a;--on-accent:#fff;--accent-soft:#e6ede2;--accent-line:#cdd9c7;
  --player-bg:#e8f0e4;--player-border:#d3e1cd;
  /* 状态色 */
  --ok:#5d8a58;--busy:#b08a3c;--warn:#8a5a2e;--danger:#a5563f;
  /* 角色专属色：色相由脚本按角色名选取，这里只定明度 */
  --char-bg-l:88%;--char-fg-l:30%;
  --shadow:0 4px 18px rgb(48 61 52 / .06);
  /* 字体：故事正文可换成自带字体，未安装时自动回退到界面字体 */
  --font-ui:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
  --font-story:"LXGW WenKai","Noto Serif SC","Source Han Serif SC","Segoe UI","Microsoft YaHei",system-ui,sans-serif;
  /* 字号梯度 */
  --fs-xs:12px;--fs-sm:13px;--fs-md:15px;--fs-story:17px;--fs-title:28px;--fs-h2:19px;
  /* 圆角 */
  --r-sm:6px;--r-md:10px;--r-lg:14px;
}
@media (prefers-color-scheme:dark){
  :root{
    color-scheme:dark;
    --bg:#101010;--surface:#191919;--surface-2:#161616;--surface-sunken:#202020;
    --border:#353535;--border-soft:#2b2b2b;
    --text:#e5e5e5;--text-story:#ededed;--text-act:#b0b0b0;--text-muted:#b0b0b0;--text-faint:#999999;
    --accent:#d0d0d0;--accent-hover:#eeeeee;--on-accent:#111111;--accent-soft:#282828;--accent-line:#404040;
    --player-bg:#252525;--player-border:#3a3a3a;
    --ok:#d0d0d0;--busy:#d9b45f;--warn:#d9a46a;--danger:#e0917c;
    --char-bg-l:24%;--char-fg-l:76%;
    --shadow:0 4px 18px rgb(0 0 0 / .25);
  }
}

/* ===== 基础 ===== */
:root{font:var(--fs-md)/1.6 var(--font-ui);background:var(--bg);color:var(--text)}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0}
button,textarea,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}
button:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
main{max-width:1320px;height:100dvh;min-height:430px;margin:auto;padding:26px 36px 28px;display:flex;flex-direction:column;gap:22px}

/* ===== 标题栏 ===== */
.world-header{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-shrink:0}
.eyebrow{margin:0 0 8px;font-size:var(--fs-xs);letter-spacing:1px;color:var(--text-muted)}
h1{font:600 var(--fs-title)/1.35 var(--font-story);letter-spacing:0;margin:0;overflow-wrap:anywhere}
#status{display:flex;align-items:center;gap:8px;flex-shrink:0;border:1px solid var(--border);border-radius:30px;padding:7px 13px;font-size:var(--fs-sm);color:var(--text-muted);background:var(--surface-2)}
#status:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--ok)}
#status[data-state="busy"]:before{background:var(--busy)}
#status[data-state="error"],#status[data-state="paused"],#status[data-state="disconnected"]{color:var(--warn)}
#status[data-state="error"]:before,#status[data-state="disconnected"]:before{background:var(--danger)}

/* ===== 布局 ===== */
.workspace{display:grid;grid-template-columns:300px minmax(0,1fr);gap:24px;min-height:0;flex:1}
.conversation{min-width:0;display:flex;flex-direction:column;position:relative;min-height:0;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--shadow)}
.conversation-heading{display:flex;justify-content:space-between;gap:15px;padding:14px 26px;border-bottom:1px solid var(--border-soft);color:var(--text-muted);font-size:var(--fs-sm)}
.conversation-heading #player{color:var(--text-faint);font-size:var(--fs-sm)}

/* ===== 对话记录 ===== */
#history{flex:1;min-height:0;overflow:auto;padding:28px 30px 8px;scrollbar-width:thin;scrollbar-color:var(--border) transparent;overscroll-behavior:contain}
.line{display:flex;gap:14px;max-width:min(100%,46rem);margin:0 0 28px}
.avatar{width:34px;height:34px;display:grid;place-items:center;flex-shrink:0;border-radius:10px;font-size:var(--fs-sm);background:var(--accent-soft);color:var(--accent)}
.line:not(.player) .avatar{background:hsl(var(--hue,140) 26% var(--char-bg-l));color:hsl(var(--hue,140) 32% var(--char-fg-l))}
.message{min-width:0;flex:1}
.speaker{display:block;font-size:var(--fs-sm);font-weight:600;color:var(--text-muted);margin:4px 0 6px}
.line:not(.player) .speaker{color:hsl(var(--hue,140) 30% var(--char-fg-l))}
.text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:var(--story-line-height,1.9);font:var(--fs-story)/var(--story-line-height,1.9) var(--font-story);color:var(--text-story)}
.text .act{color:var(--text-act)}.text .say{color:var(--text-story)}
.line.player{margin-left:auto;flex-direction:row-reverse}
.line.player .message{flex:0 1 auto;max-width:38rem}
.line.player .speaker{text-align:right}
.line.player .text{background:var(--player-bg);border:1px solid var(--player-border);border-radius:var(--r-md) 2px var(--r-md) var(--r-md);padding:11px 16px}
.empty-history{padding:56px 8px;color:var(--text-muted);text-align:center;line-height:1.9}
.empty-history strong{display:block;font:500 20px/1.5 var(--font-story);color:var(--text);margin-bottom:10px}

/* ===== 输入区 ===== */
.composer{padding:16px 24px 14px;border-top:1px solid var(--border-soft);background:var(--surface-2)}
.composer label{font-size:var(--fs-sm);color:var(--text-muted);display:block;margin-bottom:8px}
textarea{display:block;width:100%;min-height:76px;max-height:170px;resize:vertical;line-height:1.7;padding:0;border:0;background:transparent;color:var(--text-story);font-size:var(--fs-md)}
textarea:focus{outline:none}
textarea:focus-visible{outline:2px solid var(--accent);outline-offset:4px;border-radius:2px}
textarea::placeholder{color:var(--text-faint)}
.composer-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:8px}
.composer-footer>span{font-size:var(--fs-xs);color:var(--text-faint)}
button{border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--accent);padding:9px 14px;transition:background .15s,border-color .15s}
button:hover:not(:disabled){background:var(--accent-soft);border-color:var(--accent-line)}
#send{background:var(--accent);border-color:var(--accent);color:var(--on-accent);min-width:92px;padding:9px 16px;font-weight:600}
#send:hover:not(:disabled){background:var(--accent-hover);border-color:var(--accent-hover)}
#send:disabled{background:var(--accent-soft);border-color:var(--accent-line);color:var(--text-faint);opacity:1}
#send span{margin-left:14px}
.feedback:has(#notice:empty):has(#retry[hidden]){display:none}
.feedback{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:10px}
#notice{margin:0;color:var(--warn);font-size:var(--fs-sm);line-height:1.6;overflow-wrap:anywhere}
.secondary{font-size:var(--fs-xs);padding:6px 11px}
/* 浮动按钮固定在记录区上方，避免遮挡可变高度的发送区。 */
.latest{position:absolute;align-self:center;top:64px;right:24px;bottom:auto;box-shadow:var(--shadow);background:var(--surface)}

.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.narration-composer{margin-top:10px;border-top:1px solid var(--border-soft);padding-top:8px}
.narration-composer summary{cursor:pointer;color:var(--text-muted);font-size:var(--fs-sm)}
.narration-composer summary span{margin-left:8px;font-size:var(--fs-xs);color:var(--text-faint)}
.narration-composer textarea{margin-top:8px;min-height:56px;max-height:110px}
/* ===== 发言受众 ===== */
.audience-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
#audience-badge{font-size:var(--fs-xs);border-radius:20px;background:var(--accent-soft);padding:2px 9px}
.audience-options{border:0;margin:0 0 8px;padding:0;display:grid;gap:4px}
.composer .audience-options label{display:flex;align-items:center;gap:8px;margin:0;color:var(--text)}
.audience-options input{accent-color:var(--accent);flex-shrink:0}
#speech-recipient{width:100%;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text);padding:7px 10px;margin-bottom:8px}
#speech-recipient:focus-visible,.audience-options input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.audience-preview{margin:8px 0 0;font-size:var(--fs-xs);color:var(--text-muted);line-height:1.6}
.composer{flex-shrink:0;max-height:calc(100% - 100px);overflow:auto}
/* ===== 侧栏 ===== */
.sidebar{overflow:auto;min-height:0;scrollbar-width:thin}
.scene-card{padding:20px;border:1px solid var(--border);border-radius:var(--r-md);background:linear-gradient(165deg,var(--surface-sunken),var(--accent-soft));margin-bottom:16px}
h2{font:600 var(--fs-h2)/1.4 var(--font-story);margin:0 0 14px;overflow-wrap:anywhere}
#characters{display:flex;gap:7px;flex-wrap:wrap}
.character{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);padding:4px 9px;font-size:var(--fs-sm);color:var(--text-muted)}
.alone{font-size:var(--fs-sm);color:var(--text-faint)}
.action-panel{border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface-2);overflow:hidden}
.action-panel>summary{display:flex;align-items:center;justify-content:space-between;cursor:pointer;list-style:none;padding:15px 16px;font-size:var(--fs-md);font-weight:600}
.action-panel>summary::-webkit-details-marker{display:none}
#action-count{font-size:var(--fs-xs);font-weight:400;color:var(--text-muted);background:var(--accent-soft);border-radius:var(--r-sm);padding:2px 7px}
.action-group{padding:0 14px 15px}
.action-group h3{margin:0 0 8px;padding-top:3px;color:var(--text-muted);font-size:var(--fs-xs);letter-spacing:.5px;font-weight:600}
.action-group+.action-group{border-top:1px solid var(--border-soft);padding-top:14px}
.action-group button{display:flex;width:100%;justify-content:space-between;gap:8px;text-align:left;align-items:center;color:var(--text);border-color:var(--border);background:var(--surface);margin:6px 0 0;padding:10px 12px;font-size:var(--fs-sm);line-height:1.6;overflow-wrap:anywhere}
.action-group button:hover:not(:disabled){border-color:var(--accent)}
.action-group button span:last-child{color:var(--text-faint)}
.no-actions{padding:0 16px 16px;margin:0;color:var(--text-muted);font-size:var(--fs-sm);line-height:1.7}
.hint{font-size:var(--fs-xs);color:var(--text-faint);line-height:1.9;padding:0 7px;margin:14px 0}

.round-tools{display:flex;align-items:center;gap:4px;margin:4px 0 18px 42px;color:var(--text-muted);font-size:var(--fs-xs)}
.round-tools button{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;padding:4px;border:0;border-radius:6px;background:transparent;color:var(--text-muted)}
.round-tools button:hover:not(:disabled){background:var(--accent-soft);color:var(--text)}
.round-tools span{font-variant-numeric:tabular-nums;min-width:32px;text-align:center}
.round-tools[hidden],.round-tools [hidden]{display:none!important}
/* ===== 响应式 ===== */
@media(max-width:850px){main{padding:20px;gap:18px}.workspace{grid-template-columns:240px minmax(0,1fr);gap:16px}}
@media(max-width:640px){
  main{height:auto;min-height:100dvh;padding:18px 14px;gap:16px}
  .world-header{align-items:flex-start;gap:10px}h1{font-size:24px}#status{font-size:var(--fs-xs);padding:6px 9px}
  .workspace{display:flex;flex-direction:column;gap:16px}
  .conversation{min-height:480px;height:68dvh;flex-shrink:0}.conversation-heading{padding:13px 16px}
  #history{padding:20px 16px 6px}.line{max-width:100%;gap:10px}.composer{padding:15px 16px}
  .sidebar{overflow:visible;order:1}.scene-card{padding:16px;margin-bottom:12px}#characters{gap:6px}
  .action-panel>summary{padding:14px}.action-group button{padding:11px}.hint{margin-bottom:0}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;

export const DEFAULT_SCRIPT = String.raw`(() => {
 const api=window.Perspectra,node=id=>document.getElementById(id);
 let latest,posting=false,pending,connected=false,historyKey='',actionsKey='',canRegenerate=false;
 const roundTools=node('round-tools');
 const history=node('history');
 const QUOTE=/([“”"「『][^“”"」』\n]*[“”"」』])/;
 const HUES=[18,42,96,166,208,262,326];
 function hueOf(name){let h=0;for(const ch of String(name))h=(h*31+ch.codePointAt(0))>>>0;return HUES[h%HUES.length]}
 function fillText(el,text){
   const parts=text.split(QUOTE);
   if(parts.length===1){el.textContent=text;return}
   parts.forEach((part,index)=>{if(!part)return;const span=document.createElement('span');span.className=index%2?'say':'act';span.textContent=part;el.append(span)});
 }
 function speechScope(){return document.querySelector('input[name="speech-scope"]:checked').value}
 function audience(){
   const scope=speechScope(),direct=scope==='direct'||scope==='private',select=node('speech-recipient');
   node('recipient-panel').hidden=!direct;
   node('recipient-hint').hidden=!!latest?.scene?.recipients?.length;
   const name=select.value?select.selectedOptions[0].textContent:'指定角色';
   node('audience-badge').textContent=({scene_public:'公开发言',direct:'定向发言',private:'私密交流',self:'自我表达'})[scope];
   node('audience-preview').textContent=({scene_public:'发送效果：当前场景有权观察的角色将收到完整内容。',direct:'发送效果：只有 '+name+' 收到内容，其他角色不会获得这次发言的观察。',private:'发送效果：只有 '+name+' 收到内容，其他有权观察的角色仅知道发生了私密交流。',self:'发送效果：只有玩家自己保留这段表达，不会向其他角色传播。'})[scope];
 }
 function renderRecipients(view){
   const select=node('speech-recipient'),previous=select.value;
   select.replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='请选择接收对象';select.append(placeholder);
   for(const person of view.scene?.recipients||[]){const option=document.createElement('option');option.value=person.id;option.textContent=person.name;select.append(option)}
   if(Array.from(select.options).some(option=>option.value===previous))select.value=previous;
   audience();
 }
 function controls(){
   const disabled=posting||!connected||!['ready','error'].includes(latest?.status);
   node('send').disabled=disabled||!(node('input').value.trim()||node('narration').value.trim())||((speechScope()==='direct'||speechScope()==='private')&&!node('speech-recipient').value);
   for(const radio of document.querySelectorAll('input[name="speech-scope"]'))radio.disabled=disabled;
   node('speech-recipient').disabled=disabled||!latest?.scene?.recipients?.length;
   node('input').disabled=disabled;node('narration').disabled=disabled;
   for(const button of node('actions').querySelectorAll('button'))button.disabled=disabled;
   node('retry').hidden=!pending;node('retry').disabled=posting||!connected;
   const tail=latest?.tailRound,count=tail?.candidateIds?.length||1,index=tail?.candidateIndex||1;
   roundTools.hidden=!tail?.id||!canRegenerate;
   node('candidate-count').textContent=index+'/'+count;
   for(const id of ['candidate-prev','candidate-count','candidate-next'])node(id).hidden=count<2;
   node('candidate-prev').disabled=posting||!connected||!tail?.canRegenerate||index<=1;
   node('candidate-next').disabled=posting||!connected||!tail?.canRegenerate||index>=count;
   node('regenerate-round').disabled=posting||!connected||!tail?.canRegenerate;
   node('regenerate-round').hidden=!!tail?.regenerating;
   node('cancel-round').hidden=!tail?.regenerating;
 }
 function bottom(){history.scrollTop=history.scrollHeight;node('latest').hidden=true}
 history.onscroll=()=>{node('latest').hidden=history.scrollHeight-history.scrollTop-history.clientHeight<70};
 node('latest').onclick=bottom;
 function render(view){
   latest=view;renderRecipients(view);
   const reading=view.settings?.reading||{fontSize:17,lineHeight:1.9,autoFollow:true};
   document.documentElement.style.setProperty('--fs-story',reading.fontSize+'px');document.documentElement.style.setProperty('--story-line-height',String(reading.lineHeight));
   node('input').maxLength=node('narration').maxLength=view.settings?.inputCharacters||2000;
   node('title').textContent=view.game.title;node('player').textContent='你 · '+view.player.name;
   node('scene').textContent=view.scene?.locationName||'场景尚未开始';
   node('characters').replaceChildren();
   const people=view.scene?.visibleCharacters||[];
   for(const name of people){const chip=document.createElement('span');chip.className='character';chip.textContent=name;node('characters').append(chip)}
   if(!people.length){const empty=document.createElement('span');empty.className='alone';empty.textContent='眼前没有其他角色';node('characters').append(empty)}
   node('status').textContent=({ready:'可以回应',busy:view.tailRound?.regenerating?'正在处理回合':'角色正在回应',paused:'已暂停',error:'处理未完成'})[view.status];
   node('status').dataset.state=view.status;
   node('status').title=view.feedback?.phase||'';
   if(!pending)node('notice').textContent=view.status==='busy'?(view.feedback?.phase||'角色依次处理，已发表的回应会立即显示。'):view.feedback?.message||'';
   const nextHistory=JSON.stringify(view.history);
   if(nextHistory!==historyKey){
     const oldTop=history.scrollTop;
     const follow=!historyKey||(reading.autoFollow&&history.scrollHeight-oldTop-history.clientHeight<70);
     historyKey=nextHistory;history.replaceChildren();
     if(!view.history.length){const empty=document.createElement('div');empty.className='empty-history';const title=document.createElement('strong');title.textContent='故事从你的第一句话开始';empty.append(title,document.createTextNode('看看眼前的世界，向角色打个招呼吧。'));history.append(empty)}
     for(const line of view.history){
       const article=document.createElement('article');article.className='line'+(line.player?' player':'');if(!line.player)article.style.setProperty('--hue',String(hueOf(line.speaker)));
       const avatar=document.createElement('span');avatar.className='avatar';avatar.setAttribute('aria-hidden','true');avatar.textContent=Array.from(line.speaker)[0]||'·';
       const message=document.createElement('div');message.className='message';
       const speaker=document.createElement('strong');speaker.className='speaker';speaker.textContent=line.speaker;
       const text=document.createElement('div');text.className='text';if(line.segments){for(const segment of line.segments){const span=document.createElement('span');span.className=segment.type==='speech'?'say':'act';span.textContent=segment.text;text.append(span,document.createElement('br'));}}else fillText(text,line.text);
       message.append(speaker,text);article.append(avatar,message);history.append(article);
     }
     history.append(roundTools);
     if(follow)bottom();else{history.scrollTop=oldTop;node('latest').hidden=false}
   }
   const nextActions=JSON.stringify(view.actions);
   if(nextActions!==actionsKey){
     actionsKey=nextActions;node('actions').replaceChildren();node('action-count').textContent=String(view.actions.length);
     for(const [type,title] of [['move','移动'],['interact','物品与互动']]){
       const options=view.actions.filter(option=>option.action.actionType===type);if(!options.length)continue;
       const group=document.createElement('section');group.className='action-group';
       const heading=document.createElement('h3');heading.textContent=title;group.append(heading);
       for(const option of options){const button=document.createElement('button');button.type='button';
         const label=document.createElement('span');label.textContent=option.label;const arrow=document.createElement('span');arrow.textContent='↗';arrow.setAttribute('aria-hidden','true');button.append(label,arrow);
         button.onclick=()=>send('perform',{optionId:option.id});group.append(button)}
       node('actions').append(group);
     }
     if(!view.actions.length){const empty=document.createElement('p');empty.className='no-actions';empty.textContent='暂时没有可用行动，仍可通过对话表达。';node('actions').append(empty)}
   }
   controls();
 }
 async function refresh(){try{const view=await api.getView();connected=true;render(view)}catch(error){node('notice').textContent=error.message;connected=false;node('status').textContent='连接断开';node('status').dataset.state='disconnected';controls()}}
 async function submit(request){
   posting=true;controls();node('notice').textContent='正在提交……';
   try{render(await api.request(request.method,request.payload,request.actionId));if(request.method==='speak'){node('input').value='';node('narration').value='';}pending=null;node('notice').textContent=''}
   catch(error){if((request.method==='regenerate'||request.method==='selectCandidate')&&error.retryable===false)pending=null;node('notice').textContent=error.message+(pending?'；可重试查询同一操作结果。':'')}
   finally{posting=false;await refresh();controls()}
 }
 function send(method,payload){
   const tailOperation=method==='regenerate'||method==='selectCandidate';
   if(posting||!connected||(tailOperation?!latest?.tailRound?.canRegenerate:!['ready','error'].includes(latest?.status)))return;
   pending={method,payload,actionId:api.newActionId()};submit(pending);
 }
 node('regenerate-round').onclick=()=>send('regenerate',{tailId:latest.tailRound.id});
 function choose(offset){const tail=latest?.tailRound,id=tail?.candidateIds?.[(tail.candidateIndex||1)-1+offset];if(id)send('selectCandidate',{tailId:tail.id,candidateId:id})}
 node('candidate-prev').onclick=()=>choose(-1);node('candidate-next').onclick=()=>choose(1);
 node('cancel-round').onclick=async()=>{try{await api.cancelRegeneration()}catch(error){node('notice').textContent=error.message}};
 node('retry').onclick=()=>{if(!posting&&connected&&pending)submit(pending)};
 node('send').onclick=()=>{const text=node('input').value.trim(),narration=node('narration').value.trim();if(text||narration){const maximum=latest?.settings?.inputCharacters||2000;if(text.length+narration.length>maximum){node('notice').textContent='发言与描写合计不能超过 '+maximum+' 个字符';return}const scope=speechScope(),addresseeIds=scope==='direct'||scope==='private'?[node('speech-recipient').value]:[];if((scope==='direct'||scope==='private')&&!addresseeIds[0])return;send('speak',{text,narration,scope,addresseeIds})}};
 for(const radio of document.querySelectorAll('input[name="speech-scope"]'))radio.onchange=()=>{audience();controls()};
 node('speech-recipient').onchange=()=>{audience();controls()};
 audience();
 node('input').oninput=controls;node('narration').oninput=controls;
 node('input').onkeydown=node('narration').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();node('send').click()}};
 api.subscribe(event=>{if(event.view){connected=true;render(event.view)}if(event.type==='disconnected'){connected=false;node('status').textContent='连接断开';node('status').dataset.state='disconnected';controls()}});
 controls();api.ready.then(info=>{canRegenerate=info.capabilities.includes('regenerate');connected=true;render(info.view)}).catch(error=>{node('notice').textContent=error.message;controls()});
})();`;
