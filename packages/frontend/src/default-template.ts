import { createReadingPlayback } from './reading-playback.ts'
import { STAGE_STYLE } from './stage-style.ts'
import { stagePreferences } from './stage-preferences.ts'
import { createBgmPlayback } from './bgm-playback.ts'
import { createParticipantPicker } from './participant-picker.ts'

export const DEFAULT_PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Perspectra 对话</title><link rel="stylesheet" href="/frontend/default.css"></head>
<body><main>
  <div class="backdrop" aria-hidden="true"><img id="background" alt="" hidden></div>
  <header class="world-header"><div class="scene-heading"><div><h2 id="scene">正在进入情景</h2><h1 id="title">正在进入世界</h1><div id="status-bar" class="status-bar" role="group" aria-label="你知道的状态" hidden></div></div></div><nav class="stage-tools" aria-label="舞台工具"><span id="status" class="status" role="status">正在连接</span><span id="plugin-tools" hidden></span><button id="history-toggle" type="button" aria-expanded="false" aria-controls="history-panel">记录</button><button id="actions-toggle" type="button" aria-expanded="false" aria-controls="action-panel">行动 <span id="action-count">0</span></button><button id="inventory-toggle" type="button" aria-expanded="false" aria-controls="inventory-panel">背包 <span id="inventory-count">0</span></button><button id="status-toggle" type="button" aria-expanded="false" aria-controls="status-panel">状态</button><button id="settings-toggle" type="button" aria-expanded="false" aria-controls="settings-panel">设置</button></nav></header>
  <div id="characters" aria-label="当前可见角色"></div><div id="character-menu" class="character-menu" role="menu" hidden></div>
  <div class="stage-notifications" aria-live="polite"><p id="movement-toast" class="movement-toast" hidden></p><p id="item-toast" class="movement-toast" hidden></p></div>
  <section id="activity-card" class="activity-card" aria-label="当前活动" hidden><button id="activity-heading" class="activity-heading" type="button" aria-expanded="true"><small>当前活动</small><strong id="activity-title"></strong><span id="activity-phase"></span></button><div id="activity-body"><p id="activity-objective"></p><dl id="activity-state"></dl><div id="activity-options"></div><p id="activity-result" class="hint" role="status"></p><div id="activity-manage" class="activity-manage"></div></div></section>
  <section class="stage-bottom" aria-label="故事与对话">
    <div class="dialogue-wrap" id="dialogue-wrap"><div class="dialogue-meta"><strong id="speaker" class="speaker-label">序幕</strong><span id="reading-count" class="reading-count"></span></div><button id="dialogue" class="dialogue" type="button" aria-label="阅读下一段">世界正在醒来……</button><div id="auto-progress" class="auto-progress" hidden><div id="auto-progress-bar" class="auto-progress-bar"></div></div><div class="dialogue-footer"><span id="continue-hint">点击继续</span><button id="auto-read" type="button" aria-pressed="false">自动</button><button id="skip-read" type="button" title="跳到已经发生的最新内容">跳过</button>      <div id="round-tools" class="round-tools" role="group" aria-label="末端回合候选" hidden><button id="candidate-prev" type="button" aria-label="上一个候选" title="上一个候选">‹</button><span id="candidate-count" aria-live="polite"></span><button id="candidate-next" type="button" aria-label="下一个候选" title="下一个候选">›</button><button id="regenerate-round" type="button" aria-label="重新生成" title="重新生成此回合"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 3l1 3M4 12l1 3a8 8 0 0 0 13 3"/></svg></button><button id="cancel-round" type="button" aria-label="取消重新生成" title="取消重新生成" hidden>停止</button></div>
</div></div>
<div id="reply-bar" class="reply-bar" hidden><button id="reply-open" type="button">说点什么…</button><button id="reply-wait" type="button" hidden title="不说也不做，让这一轮过去">静观</button></div>
<div class="feedback"><p id="notice" role="status"></p><button id="retry" class="secondary" type="button" hidden>重试同一操作</button></div>      <div class="composer" id="composer" hidden><div class="reply-context" id="reply-context" role="button" tabindex="0" title="点击返回对白"><span id="reply-speaker"></span><p id="reply-summary"></p></div>
        <div class="composer-body"><div class="composer-main">
        <div id="expression-choices" class="expression-choices"></div><label class="visually-hidden" for="input">写下你的回应</label><textarea id="input" maxlength="2000" placeholder="说出你想对角色说的话……" rows="2"></textarea>
        <div class="composer-footer"><div class="audience-picker" id="audience-picker">
          <button id="audience-button" class="audience-button" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="audience-menu"><span class="audience-dot" aria-hidden="true"></span><span id="audience-badge">公开发言</span><span class="chevron" aria-hidden="true">▴</span></button>
          <div id="audience-menu" class="audience-menu" hidden>
            <fieldset class="audience-options"><legend>谁能听到这句话</legend>
              <label data-tip="当前场景里有权观察的角色都会收到完整内容。"><input type="radio" name="speech-scope" value="scene_public" checked><span>公开</span><small>在场的人都能听到</small></label>
              <label data-tip="只有选定的角色收到内容，其他角色不会观察到这次发言。"><input type="radio" name="speech-scope" value="direct"><span>定向</span><small>只说给一个人</small></label>
              <label data-tip="只有选定的角色收到内容；其他有权观察的角色只知道你们在私下交谈。"><input type="radio" name="speech-scope" value="private"><span>私密</span><small>悄悄话，旁人只看到在交谈</small></label>
              <label data-tip="只留给你自己，不会传播给任何角色。"><input type="radio" name="speech-scope" value="self"><span>仅自己</span><small>不让任何角色知道</small></label>
            </fieldset>
          </div>
        </div>
        <div id="recipient-panel" hidden><label for="speech-recipient">对</label><select id="speech-recipient"></select><p id="recipient-hint" class="hint" hidden>当前没有可接收发言的角色。</p></div>
<details class="narration-composer" id="narration-panel"><summary title="描写你的动作、神态或语气（可选），与发言一起发送">描写</summary><label class="visually-hidden" for="narration">细节描写</label><textarea id="narration" maxlength="2000" placeholder="动作、神态或语气（可选）" rows="1" title="不会直接改变位置或物品归属"></textarea></details>
        <span id="attached-action" class="attached-action" hidden><span id="attached-label"></span><select id="attached-order" aria-label="说和做的顺序"><option value="before">先说后做</option><option value="after">先做后说</option></select><button id="attached-clear" type="button" aria-label="取消这个行动">×</button></span>
        <button id="composer-actions" type="button" aria-controls="action-panel" title="挑一个行动；输入框有字时，它会和这句话一起提交">＋ 行动</button>
        <button id="composer-message" type="button" aria-controls="message-panel" title="给不在身边的人发消息，单独发送" hidden>短信</button>
        <span class="composer-keys">Enter 发送 · Shift+Enter 换行</span><span class="composer-submit"><button id="wait" type="button" hidden title="不说也不做，让这一轮过去">静观</button><button id="send" type="button">发送 <span aria-hidden="true">↑</span></button></span></div>
        <p id="audience-preview" class="visually-hidden" aria-live="polite"></p>
        </div></div>
      </div>
  </section>
  <section id="history-panel" class="panel history-panel" aria-label="文字记录" hidden><div class="panel-header"><span>文字记录 · <span id="player"></span></span><button id="history-close" type="button" aria-label="关闭文字记录">×</button></div><section id="history" aria-label="玩家可见对话记录"></section><button id="latest" class="latest secondary" type="button" hidden>回到最新对话 ↓</button></section>
  <section id="action-panel" class="panel action-panel" aria-label="可用行动" hidden><div class="panel-header"><span>当前可用行动</span><button id="actions-close" type="button" aria-label="关闭行动">×</button></div><div id="actions"></div></section>
  <section id="message-panel" class="panel message-panel" aria-label="短信" hidden><div class="panel-header"><span id="message-title">短信</span><button id="message-close" type="button" aria-label="关闭短信">×</button></div><div class="panel-body message-body"><label for="message-to">发给</label><select id="message-to"></select><label for="message-text">内容</label><textarea id="message-text" rows="4" placeholder="写下要发出的内容……"></textarea><p id="message-hint" class="hint">对方不在身边也能收到；同一房间的人看不到内容。</p><button id="message-send" class="primary" type="button">发送</button></div></section>
  <section id="inventory-panel" class="panel inventory-panel" aria-label="背包" hidden><div class="panel-header"><span>背包 · 随身物品</span><button id="inventory-close" type="button" aria-label="关闭背包">×</button></div><div id="inventory-list" class="panel-body"></div></section>
  <section id="status-panel" class="panel status-panel" aria-label="状态" hidden><div class="panel-header"><span>状态</span><button id="status-close" type="button" aria-label="关闭状态">×</button></div><div id="status-list" class="panel-body"></div></section>
  <section id="settings-panel" class="panel settings-panel" aria-label="设置" hidden>
    <div class="panel-header"><span>舞台设置</span><button id="settings-close" type="button" aria-label="关闭设置">×</button></div>
    <div class="panel-body settings-body">
      <p class="settings-intro">让故事以你喜欢的方式展开。</p>
      <fieldset><legend>阅读</legend>
        <label class="setting-range" for="setting-fontSize"><span>字号</span><output id="value-fontSize"></output><input id="setting-fontSize" type="range" min="14" max="28" step="1"></label>
        <label class="setting-range" for="setting-lineHeight"><span>行距</span><output id="value-lineHeight"></output><input id="setting-lineHeight" type="range" min="1.4" max="2.4" step="0.1"></label>
        <label class="setting-range" for="setting-autoSpeed"><span>自动阅读速度</span><output id="value-autoSpeed"></output><input id="setting-autoSpeed" type="range" min="0.5" max="2" step="0.25"></label>
        <label class="setting-check"><span>记录跟随最新<small>新内容到达时，停在记录底部</small></span><input id="setting-autoFollow" type="checkbox" role="switch"></label>
      </fieldset>
      <fieldset><legend>声音</legend>
        <label class="setting-range" for="setting-volume"><span>音量</span><output id="value-volume"></output><input id="setting-volume" type="range" min="0" max="100" step="1"></label>
        <label class="setting-check"><span>静音</span><input id="setting-muted" type="checkbox" role="switch"></label>
        <label class="setting-check"><span>角色语音<small id="voice-hint">尚未安装语音服务</small></span><input id="setting-voiceEnabled" type="checkbox" role="switch" disabled></label>
        <p id="voice-notice" class="hint" role="status"></p>
        <label class="setting-check"><span>背景音乐<small id="bgm-hint">尚未安装背景音乐插件</small></span><input id="setting-bgm" type="checkbox" role="switch" disabled></label>
        <p id="bgm-notice" class="hint" role="status"></p>
      </fieldset>
      <fieldset><legend>外观</legend><div class="appearance-options" role="group" aria-label="界面外观"><label><input type="radio" name="appearance" value="system"><span>跟随系统</span></label><label><input type="radio" name="appearance" value="light"><span>浅色</span></label><label><input type="radio" name="appearance" value="dark"><span>深色</span></label></div></fieldset>
      <section id="plugin-settings" hidden aria-label="插件设置"></section>
      <fieldset><legend>故事进度</legend><p class="hint">保存此刻的故事，在启动器中继续。</p><button id="stage-save" class="save-entry" type="button" disabled>保存进度 <span aria-hidden="true">↗</span></button><p id="save-unavailable" class="hint" hidden>当前运行时不支持保存进度。</p></fieldset>
      <p id="settings-notice" class="hint" role="status">设置仅影响本机显示，即时生效。</p>
    </div>
  </section>
  <dialog id="save-dialog" class="save-dialog" aria-labelledby="save-heading"><div>
    <div class="save-heading"><span class="eyebrow">故事进度</span><button id="save-close" type="button" aria-label="关闭保存进度">×</button></div><h2 id="save-heading">留住这一刻</h2><p class="hint">将当前位置保存为节点，之后可在启动器中继续。</p>
    <label for="save-title">节点名称</label><input id="save-title" maxlength="80" autocomplete="off" required>
    <p id="save-result" role="status" class="hint"></p><div class="save-buttons"><button id="save-cancel" type="button">取消</button><button id="save-confirm" class="primary" type="button">保存进度</button></div>
  </div></dialog>
</main><script src="/frontend/sdk.js"></script><script src="/frontend/default.js"></script></body></html>`

export const DEFAULT_STYLE = STAGE_STYLE

/** Status bar rows grouped by holder, in the order the view lists them; a stale value reads "上次确认". */
function statusBarRows(view: {
  statusBar?: {
    label: string
    holderId: string | null
    holderName?: string
    self?: boolean
    value: unknown
    current: boolean
  }[]
}) {
  // Grouped by holder ID, never by display name: two characters may share a name.
  const groups: { id: string | null; holder: string; items: { label: string; value: string; note: string }[] }[] = []
  for (const entry of view.statusBar || []) {
    let group = groups.find(item => item.id === entry.holderId)
    if (!group) {
      group = {
        id: entry.holderId,
        holder: entry.holderId === null ? '世界' : entry.self === true ? '你' : entry.holderName || entry.holderId,
        items: [],
      }
      groups.push(group)
    }
    // A composite value is shortened for the panel only; the SDK view keeps the whole value.
    const json = typeof entry.value === 'object' && entry.value !== null ? Array.from(JSON.stringify(entry.value)) : []
    group.items.push({
      label: entry.label,
      value:
        entry.value === true
          ? '是'
          : entry.value === false
            ? '否'
            : entry.value === null
              ? '空'
              : json.length
                ? json.length > 120
                  ? json.slice(0, 120).join('') + '…'
                  : json.join('')
                : String(entry.value),
      note: entry.current ? '' : '上次确认',
    })
  }
  return groups.map(({ holder, items }) => ({ holder, items }))
}

export const DEFAULT_SCRIPT = String.raw`(() => {
 const participantPicker=(${createParticipantPicker.toString()});
 const playback=(${createReadingPlayback.toString()})();
 const api=window.Perspectra,node=id=>document.getElementById(id);
 const normalizePreferences=(${stagePreferences.toString()});
 let preferences=normalizePreferences({}),stageAssets=[],stageConfig=null,canSave=false,hasSpeech=false,hasBgm=false,saving=false,preferencesVersion=0;
 let latest,posting=false,pending,attached=null,connected=false,historyKey='',actionsKey='',waitOption=null,statusKey='',canRegenerate=false,requestVersion=0,submittedPlayers=0;
 // Never name who is replying: in hidden turns (who is awake at night) the name alone gives the game away.
 const statusText=(view,reading)=>({ready:reading?'阅读中':'可以回应',busy:view.responders?.length?'正在回复中':view.canInterrupt?'可以接着说':view.tailRound?.regenerating?'正在处理回合':'正在回复中',paused:'已暂停',error:'处理未完成'})[view.status];
 // Public fields first, then what only the player knows (its private record, e.g. a dealt role); flat lists read as one line.
 const activityRows=(shown,own)=>{const hidden=['statusText','lastResult','objective','instructions','description','phaseLabel'],labels={round:'回合',clues:'线索',funds:'资金',stock:'库存',score:'得分',attempts:'次数',health:'生命',phase:'阶段'},text=value=>Array.isArray(value)?(value.some(item=>item!==null&&typeof item==='object')?'':value.join('、')):typeof value==='boolean'?(value?'是':'否'):value===null||typeof value==='object'?'':String(value),rows=[];for(const [source,mine] of [[shown||{},false],[own||{},true]])for(const [name,value] of Object.entries(source)){const shownValue=text(value);if((!mine&&hidden.includes(name))||!shownValue)continue;rows.push({label:labels[name]||name,value:shownValue,own:mine})}return rows};
 // Keep statusRows and roundTools adjacent and in this order: frontend-reading tests extract the helper by these markers.
 const statusRows=(${statusBarRows.toString()});
 const roundTools=node('round-tools');
 const history=node('history');
 const QUOTE=/([“”"「『][^“”"」』\n]*[“”"」』])/;
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
   const preview=({scene_public:'发送效果：当前场景有权观察的角色将收到完整内容。',direct:'发送效果：只有 '+name+' 收到内容，其他角色不会获得这次发言的观察。',private:'发送效果：只有 '+name+' 收到内容，其他有权观察的角色仅知道发生了私密交流。',self:'发送效果：只有玩家自己保留这段表达，不会向其他角色传播。'})[scope];
   node('audience-preview').textContent=preview;node('audience-button').title=preview;
 }
 function renderRecipients(view){
   const select=node('speech-recipient'),previous=select.value;
   select.replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='请选择接收对象';select.append(placeholder);
   for(const person of view.scene?.recipients||[]){const option=document.createElement('option');option.value=person.id;option.textContent=person.name;select.append(option)}
   if(Array.from(select.options).some(option=>option.value===previous))select.value=previous;
   audience();
 }
 function controls(){
   const policy=latest?.expression||{speech:'free',speechChoices:[],narration:true};
   const readingBlocked=playback.pending();
   const disabled=readingBlocked||posting||!connected||(!['ready','error'].includes(latest?.status)&&!latest?.canInterrupt);
   const actionDisabled=readingBlocked||posting||!connected||!['ready','error'].includes(latest?.status);
   const hasLine=!!((policy.speech==='free'&&node('input').value.trim())||(policy.narration&&node('narration').value.trim()));
   node('send').disabled=(attached?actionDisabled:disabled)||(!hasLine&&!attached)||(hasLine&&(speechScope()==='direct'||speechScope()==='private')&&!node('speech-recipient').value);
   node('attached-order').disabled=actionDisabled||!hasLine;
   node('wait').hidden=!waitOption;node('wait').disabled=actionDisabled||hasLine||!!attached;
   for(const radio of document.querySelectorAll('input[name="speech-scope"]'))radio.disabled=disabled;
   node('audience-button').disabled=disabled;if(disabled)audienceMenu(false);
   node('speech-recipient').disabled=disabled||!latest?.scene?.recipients?.length;
   node('input').disabled=disabled||policy.speech!=='free';node('input').hidden=policy.speech!=='free';node('narration').disabled=disabled||!policy.narration;node('narration-panel').hidden=!policy.narration;
   for(const button of node('expression-choices').querySelectorAll('button'))button.disabled=disabled||(['direct','private'].includes(speechScope())&&!node('speech-recipient').value);
   const canReply=!disabled&&(policy.speech!=='none'||policy.narration);
   const mode=readingBlocked||posting||(!canReply&&!activityOpen)?'reading':activityOpen?'activity':(composerExpanded&&canReply)?'response':'reading';
   document.querySelector('main').dataset.mode=mode;
   document.querySelector('main').dataset.hasActivity=String(!!(latest?.activity||latest?.activities?.length));
   if(connected&&latest?.status==='ready')node('status').textContent=readingBlocked?'阅读中':'可以回应';
   node('stage-save').disabled=!canSave||saving||posting||!connected||latest?.status!=='ready'||!!latest?.tailRound?.regenerating;
   node('composer').hidden=mode!=='response';node('dialogue-wrap').hidden=mode==='response';
   node('reply-bar').hidden=mode!=='reading'||readingBlocked||!canReply;node('reply-wait').hidden=!waitOption;node('reply-wait').disabled=actionDisabled;
   const unit=playback.current();node('reply-speaker').textContent=unit?.speaker||'当前情景';node('reply-summary').textContent=unit?.text||'故事从你的回应开始。';
   node('actions-toggle').disabled=actionDisabled;
   if(actionDisabled)node('action-panel').hidden=true;
   node('actions-toggle').setAttribute('aria-expanded',String(!node('action-panel').hidden));
   node('continue-hint').textContent=readingBlocked?'点击或按空格继续 · 上滚查看记录':latest?.status==='busy'?'角色还在回应，新内容到达后继续':canReply?'轮到你了 · 点击这里回应':'已读完 · 可以选择行动';
   for(const box of [node('actions'),node('inventory-list')]){
     for(const button of box.querySelectorAll('button'))button.disabled=actionDisabled||button.dataset.unavailable==='true';
     for(const picker of box.querySelectorAll('select,input,textarea'))picker.disabled=actionDisabled;
   }
   node('composer-actions').disabled=actionDisabled;node('composer-message').disabled=actionDisabled;node('message-send').disabled=actionDisabled;
   if(actionDisabled)node('message-panel').hidden=true;
   for(const control of node('activity-card').querySelectorAll('#activity-options button,#activity-options select,#activity-options input,#activity-options textarea,#activity-manage button'))control.disabled=actionDisabled;
  const retryAllowed=['ready','error'].includes(latest?.status)||(pending?.method==='speak'&&latest?.canInterrupt===true);
  node('retry').hidden=!pending;node('retry').disabled=posting||!connected||!retryAllowed;
   parent.postMessage({type:'frontend-reading',pending:readingBlocked,historyOpen:!node('history-panel').hidden,mode,historySignature:JSON.stringify((latest?.history||[]).map(line=>[line.seq,line.speaker,line.text,line.segments]))},'*');
   const tail=latest?.tailRound,count=tail?.candidateIds?.length||1,index=tail?.candidateIndex||1;
   roundTools.hidden=!tail?.id||!canRegenerate;
   node('candidate-count').textContent=index+'/'+count;
   for(const id of ['candidate-prev','candidate-count','candidate-next'])node(id).hidden=count<2;
   node('candidate-prev').disabled=posting||!connected||!tail?.canRegenerate||index<=1;
   node('candidate-next').disabled=posting||!connected||!tail?.canRegenerate||index>=count;
   node('regenerate-round').disabled=posting||!connected||!tail?.canRegenerate;
   node('regenerate-round').hidden=!!tail?.regenerating;
   node('cancel-round').hidden=!tail?.regenerating;
   scheduleOpening();
 }
 function bottom(){history.scrollTop=history.scrollHeight;node('latest').hidden=true}
 history.onscroll=()=>{node('latest').hidden=history.scrollHeight-history.scrollTop-history.clientHeight<70};
 node('latest').onclick=bottom;
 function render(view){
   waitOption=view.actions.find(option=>option.id==='wait');
   view={...view,history:view.history.filter(line=>!line.pause),actions:view.actions.filter(option=>option!==waitOption)};
   if(posting&&pending?.method==='speak'&&view.canInterrupt&&view.history.filter(line=>line.player).length>submittedPlayers){
     if(node('input').value.trim()===pending.payload.text)node('input').value='';
     if(node('narration').value.trim()===(pending.payload.narration||''))node('narration').value='';
     posting=false;pending=null;requestVersion++;
   }
   const candidate=tail=>tail?.candidateIds?.[(tail.candidateIndex||1)-1]||null;
   if(latest?.tailRound?.id&&latest.tailRound.id===view.tailRound?.id&&candidate(latest.tailRound)!==candidate(view.tailRound))playback.invalidateScene();
   renderItemChanges(latest,view);
   latest=view;renderRecipients(view);const hadPending=playback.pending();playback.update(view.history);if(!hadPending&&playback.pending())composerExpanded=false;renderStage();
   const expression=view.expression||{speech:'free',speechChoices:[],narration:true};
   if(JSON.stringify(expression)!==expressionKey){expressionKey=JSON.stringify(expression);node('expression-choices').replaceChildren();if(expression.speech==='choices')for(const text of expression.speechChoices){const button=document.createElement('button');button.type='button';button.textContent=text;button.onclick=()=>send('speak',{text,scope:speechScope(),addresseeIds:['direct','private'].includes(speechScope())?[node('speech-recipient').value]:[]});node('expression-choices').append(button)}}
   const reading=preferences;
   node('input').maxLength=node('narration').maxLength=view.settings?.inputCharacters||2000;
   node('title').textContent=view.game.title;node('player').textContent='你 · '+view.player.name;
   const nextStatus=JSON.stringify(view.statusBar||[]);
   if(nextStatus!==statusKey){statusKey=nextStatus;const bar=node('status-bar'),rows=statusRows(view),pinned=statusRows({statusBar:(view.statusBar||[]).filter(entry=>entry.pinned)});bar.replaceChildren();bar.hidden=!pinned.length;
     for(const group of pinned){const section=document.createElement('span');section.className='status-group';const holder=document.createElement('small');holder.textContent=group.holder;section.append(holder);
       for(const item of group.items){const entry=document.createElement('span');entry.className='status-item';entry.append(item.label+' ');const value=document.createElement('strong');value.textContent=item.value;entry.append(value);
         if(item.note){const note=document.createElement('span');note.className='hint';note.textContent=item.note;entry.append(' ',note)}section.append(entry)}
       bar.append(section)}
     const list=node('status-list');list.replaceChildren();
     if(!rows.length){const empty=document.createElement('p');empty.className='empty-status';empty.textContent='你还不知道任何状态。';list.append(empty)}
     for(const group of rows){const section=document.createElement('section');section.className='status-section';const heading=document.createElement('h3');heading.textContent=group.holder;const table=document.createElement('dl');
       for(const item of group.items){const term=document.createElement('dt');term.textContent=item.label;const value=document.createElement('dd');value.textContent=item.value+(item.note?'（'+item.note+'）':'');table.append(term,value)}
       section.append(heading,table);list.append(section)}}
   node('status').textContent=statusText(view,playback.pending());
   node('status').dataset.state=view.status;
   node('status').title=view.feedback?.phase||'';
   if(!pending)node('notice').textContent=view.canInterrupt?'可继续输入；尚未完成的回应会被打断，已发生的行动保留。':view.status==='busy'?(view.feedback?.phase||'角色正在处理，已发表的回应会立即显示。'):view.feedback?.message||'';
   const nextHistory=JSON.stringify(view.history);
   if(nextHistory!==historyKey){
     const oldTop=history.scrollTop;
     const follow=!historyKey||(reading.autoFollow&&history.scrollHeight-oldTop-history.clientHeight<70);
     historyKey=nextHistory;history.replaceChildren();
     if(!view.history.length){const empty=document.createElement('div');empty.className='empty-history';const title=document.createElement('strong');title.textContent='故事从你的第一句话开始';empty.append(title,document.createTextNode('看看眼前的世界，向角色打个招呼吧。'));history.append(empty)}
     for(const line of view.history){
       const article=document.createElement('article');article.className='line'+(line.player?' player':'');
       const avatar=document.createElement('span');avatar.className='avatar';avatar.setAttribute('aria-hidden','true');avatar.textContent=Array.from(line.speaker)[0]||'·';
       const message=document.createElement('div');message.className='message';
       const speaker=document.createElement('strong');speaker.className='speaker';speaker.textContent=line.speaker;
       const text=document.createElement('div');text.className='text';if(line.segments){for(const segment of line.segments){const span=document.createElement('span');span.className=segment.type==='speech'?'say':'act';span.textContent=segment.text;text.append(span,document.createElement('br'));}}else fillText(text,line.text);
       message.append(speaker,text);article.append(avatar,message);history.append(article);
     }

     if(follow)bottom();else{history.scrollTop=oldTop;node('latest').hidden=false}
   }
   const nextActions=JSON.stringify(view.actions);
   if(nextActions!==actionsKey){
     actionsKey=nextActions;node('actions').replaceChildren();
     // Messages have their own composer button and panel; the action drawer keeps the rest.
     const listed=view.actions.filter(option=>!isMessage(option));renderMessages(view.actions.filter(isMessage));
     node('action-count').textContent=String(listed.length);
     if(attached&&!view.actions.some(option=>option.id===attached.option.id)){detach();node('notice').textContent='附带的行动已经不可用，请重新选择。'}
     for(const [kind,title] of [['move','移动'],['interact','物品与互动'],['activity','活动'],['manage','活动管理']]){
       const options=listed.filter(option=>option.kind===kind);if(!options.length)continue;
       const group=document.createElement('section');group.className='action-group';
       const heading=document.createElement('h3');heading.textContent=title;group.append(heading);
       for(const option of options)appendAction(group,option);
       node('actions').append(group);
     }
     if(!listed.length){const empty=document.createElement('p');empty.className='no-actions';empty.textContent='暂时没有可用行动，仍可通过对话表达。';node('actions').append(empty)}
   }
   renderInventory(view);
   renderActivity(view);
   controls();
 }
 function isMessage(option){return option.action?.parameters?.bindingId==='experiment:message'}
 let messageOptions=[];
 // One recipient list for every contact; the medium's name comes from the host's label, e.g. 给 Claude 发短信.
 function renderMessages(options){
   messageOptions=options;const picker=node('message-to'),chosen=picker.value;picker.replaceChildren();
   for(const option of options){const item=document.createElement('option');item.value=option.id;item.textContent=option.target?.name||option.label;picker.append(item)}
   if(options.some(option=>option.id===chosen))picker.value=chosen;
   const medium=(/^给 .+ 发(.+)$/.exec(options[0]?.label||'')||[])[1]||'短信';
   node('composer-message').textContent=medium;node('message-title').textContent=medium;node('message-panel').setAttribute('aria-label',medium);
   const limit=options[0]?.argumentSchema?.properties?.text?.maxLength;if(typeof limit==='number')node('message-text').maxLength=limit;
   node('composer-message').hidden=!options.length;if(!options.length&&!node('message-panel').hidden)drawer(null);
 }
 function sendMessage(){
   const option=messageOptions.find(entry=>entry.id===node('message-to').value),text=node('message-text').value.trim();
   if(!option)return;if(!text){node('notice').textContent='请先写下要发出的内容。';node('message-text').focus();return}
   node('message-text').value='';drawer(null);controls();send('perform',{optionId:option.id,arguments:{text}});
 }
 // Item controls use the same current options and submission path as the action drawer.
 function appendAction(group,option){
   const button=document.createElement('button');button.type='button';
   const label=document.createElement('span');label.textContent=option.label;const arrow=document.createElement('span');arrow.textContent='↗';arrow.setAttribute('aria-hidden','true');button.append(label,arrow);
   if(option.participantSelection){
     const selection=option.participantSelection,picker=participantPicker(selection,option.label,valid=>{button.dataset.unavailable=String(!valid);controls()});
     button.onclick=()=>{const npcIds=picker.read();
       if(npcIds.length<selection.min||npcIds.length>selection.max){node('notice').textContent='请选择 '+selection.min+' 至 '+selection.max+' 名参与角色';return}
       send('perform',{optionId:option.id,npcIds})};group.append(picker.element);
     button.dataset.unavailable=String(!picker.valid());
   }else if(option.argumentSchema){const form=argumentForm(option);group.append(form);form.append(button);
     button.onclick=()=>{let args;try{args=form.read()}catch(error){node('notice').textContent=error.message;return}act(option,args)};
   }else button.onclick=()=>act(option);
   if(!button.parentNode)group.append(button);
 }
 let inventoryKey='';
 function renderInventory(view){
   const items=view.items||[],options=view.actions.filter(option=>option.target?.kind==='item');
   const key=JSON.stringify([items,options,view.scene?.recipients]);if(key===inventoryKey)return;inventoryKey=key;
   const list=node('inventory-list'),open=new Set(Array.from(list.querySelectorAll('details[open]'),entry=>entry.dataset.itemId));list.replaceChildren();
   node('inventory-count').textContent=String(items.filter(item=>item.where==='held').length);
   for(const [held,title] of [[true,'随身物品'],[false,'附近物品']]){
     const entries=items.filter(item=>(item.where==='held')===held);
     if(!held&&!entries.length)continue;
     const section=document.createElement('section');section.className='inventory-section';const heading=document.createElement('h3');heading.textContent=title;section.append(heading);
     if(!entries.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='你还没有携带物品。';section.append(empty)}
     for(const item of entries){
       const card=document.createElement('details');card.className='inventory-item';card.dataset.itemId=item.id;card.open=open.has(item.id);
       const summary=document.createElement('summary'),name=document.createElement('strong'),place=document.createElement('small');name.textContent=item.name;place.textContent=item.where==='held'?'随身携带':item.where==='here'?'在这里':'由'+(item.holderName||'别人')+'携带';summary.append(name,place);
       const body=document.createElement('div');body.className='inventory-item-body';const description=document.createElement('p');description.className='inventory-description';description.textContent=item.kind;body.append(description);
       const actions=document.createElement('div');actions.className='action-group inventory-actions';const available=options.filter(option=>option.target.id===item.id);
       for(const option of available)appendAction(actions,option);
       if(!available.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='当前没有可用操作。';actions.append(empty)}
       body.append(actions);card.append(summary,body);section.append(card);
     }
     list.append(section);
   }
 }
 /* 进行中的活动：舞台左侧一张卡片，显示标题、阶段、目标和公开状态，以及这场活动此刻允许的操作。
    操作和暂停都来自玩家视图的 actions，提交走同一个 perform；读完当前演出前与其他行动一样置灰。 */
 const PHASES={playing:'进行中',investigation:'调查',prologue:'序章',finished:'已结束','host-aborted':'已中止'};
 let activityKey='';
 function renderActivity(view){
   const running=(view.activities||[]).find(entry=>entry.active)||(view.activity?.active?view.activity:null),card=node('activity-card');
   document.querySelector('main').dataset.activity=String(!!running);
   card.hidden=!running;if(!running){activityKey='';return}
   if(!openingHalted&&auto&&running.key===stageConfig?.autoplay?.activity){card.hidden=true;return}
   const options=view.actions.filter(option=>option.kind==='activity'&&option.target?.kind==='activity'),manage=view.actions.filter(option=>option.kind==='manage');
   const key=JSON.stringify([running,options,manage]);if(key===activityKey)return;activityKey=key;
   const shown=running.public||{};
   node('activity-title').textContent=running.title;
   node('activity-phase').textContent=shown.statusText||shown.phaseLabel||PHASES[running.phase]||running.phase;
   node('activity-objective').textContent=shown.objective||shown.instructions||shown.description||'选择这场活动允许的操作；角色会在情景里回应。';
   const state=node('activity-state');state.replaceChildren();
   for(const row of activityRows(shown,running.private)){const block=document.createElement('div'),label=document.createElement('dt'),content=document.createElement('dd');if(row.own)block.className='own';label.textContent=row.label;content.textContent=row.value;block.append(label,content);state.append(block)}
   state.hidden=!state.children.length;
   node('activity-result').textContent=typeof shown.lastResult==='string'?shown.lastResult:'';
   const box=node('activity-options');box.replaceChildren();
   for(const option of options){const button=document.createElement('button');button.type='button';button.textContent=option.label;
     if(option.argumentSchema){const form=argumentForm(option);form.append(button);box.append(form);button.onclick=()=>{let args;try{args=form.read()}catch(error){node('notice').textContent=error.message;return}send('perform',{optionId:option.id,arguments:args})}}
     else{button.onclick=()=>send('perform',{optionId:option.id});box.append(button)}}
   if(!options.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='现在没有可执行的操作，等角色回应。';box.append(empty)}
   const tools=node('activity-manage');tools.replaceChildren();
   for(const option of manage){const button=document.createElement('button');button.type='button';button.textContent=option.label;button.onclick=()=>send('perform',{optionId:option.id});tools.append(button)}
 }
 node('activity-heading').onclick=()=>{const open=node('activity-heading').getAttribute('aria-expanded')!=='true';node('activity-heading').setAttribute('aria-expanded',String(open));node('activity-body').hidden=!open};
 async function refresh(expectedVersion){try{const view=await api.getView();if(expectedVersion!==requestVersion)return;connected=true;render(view)}catch(error){if(expectedVersion!==requestVersion)return;node('notice').textContent=error.message;connected=false;node('status').textContent='连接断开';node('status').dataset.state='disconnected';controls()}}
 async function submit(request){
   const version=++requestVersion;submittedPlayers=latest?.history.filter(line=>line.player).length||0;
   posting=true;controls();node('notice').textContent='正在提交……';
   try{await api.request(request.method,request.payload,request.actionId);if(version!==requestVersion)return;
     const view=await api.getView();if(version!==requestVersion)return;
     const line=request.method==='speak'?request.payload:request.payload.say;
     if(line){if(node('input').value.trim()===line.text)node('input').value='';if(node('narration').value.trim()===(line.narration||''))node('narration').value=''}
     if(request.method==='perform'&&attached?.option.id===request.payload.optionId)detach();pending=null;node('notice').textContent='';render(view)}
   catch(error){if(version!==requestVersion)return;if(openingSeen){openingHalted=true;setAuto(openingPreviousAuto)}if((request.method==='regenerate'||request.method==='selectCandidate')&&error.retryable===false)pending=null;node('notice').textContent=error.message+(pending?'；可重试查询同一操作结果。':'')}
   finally{if(version===requestVersion){await refresh(version);if(version===requestVersion){posting=false;controls()}}}
 }
 function send(method,payload){
   const tailOperation=method==='regenerate'||method==='selectCandidate';
   if(posting||!connected||(!tailOperation&&playback.pending())||(tailOperation?!latest?.tailRound?.canRegenerate:!['ready','error'].includes(latest?.status)&&!(method==='speak'&&latest?.canInterrupt)))return;
   composerExpanded=false;drawer(null);pending={method,payload,actionId:api.newActionId()};submit(pending);
 }
 node('regenerate-round').onclick=()=>send('regenerate',{tailId:latest.tailRound.id});
 function choose(offset){const tail=latest?.tailRound,id=tail?.candidateIds?.[(tail.candidateIndex||1)-1+offset];if(id)send('selectCandidate',{tailId:tail.id,candidateId:id})}
 node('candidate-prev').onclick=()=>choose(-1);node('candidate-next').onclick=()=>choose(1);
 node('cancel-round').onclick=async()=>{try{await api.cancelRegeneration()}catch(error){node('notice').textContent=error.message}};
 node('retry').onclick=()=>{if(!posting&&connected&&pending){if(openingHalted&&openingSeen){openingHalted=false;setAuto(true)}submit(pending)}};
 /* 一个回合 = 一次表达 + 至多一个行动。输入框里有话时，点选的行动先附在发送按钮旁，和这句话一起提交；没有话时直接执行。 */
 function composerLine(){return (latest?.expression&&latest.expression.speech!=='free'?'':node('input').value.trim())||(latest?.expression?.narration===false?'':node('narration').value.trim())}
 function attach(option,args){attached={option,args};node('attached-label').textContent='连同行动：'+option.label;node('attached-action').hidden=false;drawer(null);controls();node('input').focus()}
 function detach(){attached=null;node('attached-action').hidden=true;controls()}
 function act(option,args){if(composerLine()){attach(option,args);return}send('perform',{optionId:option.id,...(args?{arguments:args}:{})})}
 node('attached-clear').onclick=detach;
 /** What the player can do with one character, from the current view only: speak to them, act on them, give
  * them something that names a character as its one input, or invite them to an activity. */
 function characterMenu(id,anchor){
   const menu=node('character-menu'),person=(latest?.scene?.recipients||[]).find(entry=>entry.id===id);
   if(!person||!connected){menu.hidden=true;return}
   menu.replaceChildren();
   const title=document.createElement('p');title.textContent=person.name;menu.append(title);
   const busy=playback.pending()||posting||!['ready','error'].includes(latest?.status);
   const entry=(text,run,disabled)=>{const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.textContent=text;button.disabled=!!disabled;button.onclick=()=>{menu.hidden=true;run()};menu.append(button)};
   const speakTo=scope=>{const radio=document.querySelector('input[name="speech-scope"][value="'+scope+'"]');radio.checked=true;node('speech-recipient').value=id;audience();composerExpanded=true;activityOpen=false;controls();node('input').focus()};
   const speakBusy=playback.pending()||posting||(!['ready','error'].includes(latest?.status)&&!latest?.canInterrupt);
   entry('对 '+person.name+' 说',()=>speakTo('direct'),speakBusy);
   entry('悄悄对 '+person.name+' 说',()=>speakTo('private'),speakBusy);
   for(const option of latest.actions||[]){
     if(option.kind==='manage')continue;
     const inputs=Object.keys(option.argumentSchema?.properties||{}),named=option.characterArguments||[],selection=option.participantSelection;
     if(selection){if(selection.min<=1&&selection.max>=1&&selection.candidates.some(candidate=>candidate.id===id))entry('邀请 '+person.name+'：'+String(option.label).replace(/^开始 /,''),()=>send('perform',{optionId:option.id,npcIds:[id]}),busy);continue}
     if(option.target?.kind==='character'&&option.target.id===id&&!inputs.length)entry(option.label,()=>act(option),busy);
     else if(named.length===1&&inputs.length===1&&inputs[0]===named[0])entry(option.label+' '+person.name,()=>act(option,{[named[0]]:id}),busy);
   }
   const box=anchor.getBoundingClientRect(),width=220;
   menu.style.left=Math.min(window.innerWidth-width-8,Math.max(8,box.left+box.width/2-width/2))+'px';
   menu.style.top=Math.min(window.innerHeight-60,Math.max(8,box.top+box.height*0.3))+'px';
   menu.hidden=false;menu.querySelector('button:not(:disabled)')?.focus();
 }
 document.addEventListener('click',event=>{if(!node('character-menu').hidden&&!node('character-menu').contains(event.target))node('character-menu').hidden=true});
 /** A small form for an action's player inputs: characters come from the scene, other fields follow the schema. */
 function argumentForm(option){
   const form=document.createElement('div');form.className='action-form';const fields=[],schema=option.argumentSchema,required=new Set(schema.required||[]);
   for(const [key,spec] of Object.entries(schema.properties||{})){
     const label=document.createElement('label'),caption=document.createElement('span');caption.textContent=(spec.title||spec.description||key)+(required.has(key)?'':'（可选）');label.append(caption);
     let input,read;
     if((option.characterArguments||[]).includes(key)){input=document.createElement('select');const blank=document.createElement('option');blank.value='';blank.textContent='选择角色';input.append(blank);for(const person of latest?.scene?.recipients||[]){const item=document.createElement('option');item.value=person.id;item.textContent=person.name;input.append(item)}read=()=>input.value||undefined}
     else if(Array.isArray(spec.enum)){input=document.createElement('select');for(const value of spec.enum){const item=document.createElement('option');item.value=JSON.stringify(value);item.textContent=String(value);input.append(item)}read=()=>JSON.parse(input.value)}
     else if(spec.type==='boolean'){input=document.createElement('input');input.type='checkbox';read=()=>input.checked}
     else if(spec.type==='integer'||spec.type==='number'){input=document.createElement('input');input.type='number';if(spec.type==='integer')input.step='1';if(typeof spec.minimum==='number')input.min=String(spec.minimum);if(typeof spec.maximum==='number')input.max=String(spec.maximum);read=()=>input.value===''?undefined:Number(input.value)}
     else if(spec.type==='string'){input=document.createElement('input');input.type='text';if(typeof spec.maxLength==='number')input.maxLength=spec.maxLength;read=()=>input.value===''?undefined:input.value}
     else{input=document.createElement('textarea');input.placeholder='JSON';read=()=>{if(!input.value.trim())return undefined;try{return JSON.parse(input.value)}catch{throw new Error(caption.textContent+' 不是有效的 JSON')}}}
     label.append(input);form.append(label);fields.push({key,caption:caption.textContent,read,required:required.has(key)})}
   form.read=()=>{const values={};for(const field of fields){const value=field.read();if(value===undefined){if(field.required)throw new Error('请填写 '+field.caption);continue}values[field.key]=value}return values};
   return form}
 node('wait').onclick=node('reply-wait').onclick=()=>{if(waitOption)send('perform',{optionId:waitOption.id})};
 node('reply-open').onclick=()=>{composerExpanded=true;activityOpen=false;controls();node('input').focus()};
 node('send').onclick=()=>{const text=latest?.expression&&latest.expression.speech!=='free'?'':node('input').value.trim(),narration=latest?.expression?.narration===false?'':node('narration').value.trim();if(!text&&!narration&&!attached)return;const maximum=latest?.settings?.inputCharacters||2000;if(text.length+narration.length>maximum){node('notice').textContent='发言与描写合计不能超过 '+maximum+' 个字符';return}const scope=speechScope(),addresseeIds=scope==='direct'||scope==='private'?[node('speech-recipient').value]:[];if((text||narration)&&(scope==='direct'||scope==='private')&&!addresseeIds[0])return;
   if(attached){const payload={optionId:attached.option.id,...(attached.args?{arguments:attached.args}:{})};if(text||narration)Object.assign(payload,{say:{text,narration,scope,addresseeIds},order:node('attached-order').value});send('perform',payload);return}
   send('speak',{text,narration,scope,addresseeIds})};
 for(const radio of document.querySelectorAll('input[name="speech-scope"]'))radio.onchange=()=>{audience();audienceMenu(false);controls();if(['direct','private'].includes(speechScope()))node('speech-recipient').focus()};
 function audienceMenu(open){const menu=node('audience-menu');
   if(open){const button=node('audience-button').getBoundingClientRect(),box=document.querySelector('.stage-bottom').getBoundingClientRect();menu.style.left=(button.left-box.left)+'px';menu.style.bottom=(box.bottom-button.top+8)+'px';menu.style.maxHeight=Math.max(120,button.top-16)+'px'}
   menu.hidden=!open;node('audience-button').setAttribute('aria-expanded',String(open))}
 node('audience-button').onclick=()=>audienceMenu(node('audience-menu').hidden);addEventListener('resize',()=>audienceMenu(false));
 document.addEventListener('click',event=>{if(!node('audience-picker').contains(event.target))audienceMenu(false)});
 node('speech-recipient').onchange=()=>{audience();controls()};
 audience();
 node('input').oninput=controls;node('narration').oninput=controls;
 node('narration-panel').addEventListener('toggle',()=>{if(node('narration-panel').open)node('narration').focus()});
 node('input').onkeydown=node('narration').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();node('send').click()}};
 let composerExpanded=false,activityOpen=false,auto=false,autoTimer=null,autoKey='',expressionKey='',sceneKey='';
 let openingSeen=false,openingPreviousAuto=false,openingHalted=false,openingTimer=null,openingRetried='';
 const toastTimers=new Map();
 function showToast(id,text){const target=node(id);target.textContent=text;target.hidden=false;clearTimeout(toastTimers.get(id));toastTimers.set(id,setTimeout(()=>target.hidden=true,4000))}
 function renderItemChanges(before,after){
   if(!before)return;
   const prefix=before.history.length<=after.history.length&&before.history.every((line,index)=>JSON.stringify(line)===JSON.stringify(after.history[index]));
   if(!prefix){node('item-toast').hidden=true;return}
   const changes=[];
   for(const item of after.items||[]){const old=(before.items||[]).find(entry=>entry.id===item.id);
     if(item.where==='held'&&old?.where!=='held')changes.push('你拿到了'+item.name);
     else if(old?.where==='held'&&item.where==='with')changes.push(item.name+'交给了'+(item.holderName||'别人'));
     else if(old?.where==='held'&&item.where==='here')changes.push('你放下了'+item.name);
   }
   if(changes.length)showToast('item-toast',changes.join(' · '));
 }
 /** Where the head top and waist sit in a portrait (fractions of its height), from the pack's stage.json; an
  * unmarked portrait is taken as full body. The stylesheet scales it so heads line up across characters. */
 function framing(id){const own=stageConfig?.characters?.[id]?.framing;return own||{top:.03,waist:.48}}
 function createPortrait(id,name){
   const portrait=document.createElement('div');portrait.className='portrait';portrait.dataset.characterId=id;
   const frame=framing(id);portrait.style.setProperty('--top',String(frame.top));portrait.style.setProperty('--waist',String(frame.waist));
   const badge=document.createElement('div');badge.className='portrait-badge';badge.textContent=Array.from(name)[0]||'◇';
   const src=art('portraits',id);badge.hidden=!!src;
   if(src){const figure=document.createElement('div');figure.className='figure';const base=document.createElement('img');base.className='base';base.alt=name+'的立绘';base.onerror=()=>{figure.remove();badge.hidden=false};base.src=src;figure.append(base);portrait.append(figure);dress(portrait,stageConfig?.characters?.[id]?.defaultExpression,null)}portrait.append(badge);
   const label=document.createElement('span');label.className='character-name';label.textContent=name;portrait.append(label);
   portrait.tabIndex=0;portrait.setAttribute('role','button');portrait.setAttribute('aria-haspopup','menu');portrait.title='和'+name+'说话或做些什么';
   portrait.onclick=event=>{event.stopPropagation();characterMenu(id,portrait)};
   portrait.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();characterMenu(id,portrait)}};
   return portrait;
 }
 /** Put a pose and an expression on a portrait, from the pack's stage.json. A pose replaces the base image; an
  * expression is a layer the size of the base, a patch at its box, or one cell of a sheet shown in place. */
 function dress(portrait,expression,pose){
   const figure=portrait.querySelector('.figure'),own=stageConfig?.characters?.[portrait.dataset.characterId];if(!figure||!own)return;
   if((portrait.dataset.expression||'')===(expression||'')&&(portrait.dataset.pose||'')===(pose||''))return;
   // A name the pack never declared changes nothing.
   if(expression&&!own.expressions?.[expression])return;
   portrait.dataset.expression=expression||'';portrait.dataset.pose=pose||'';
   const url=path=>'/frontend/custom/'+path.split('/').map(encodeURIComponent).join('/');
   const base=figure.querySelector('.base'),posed=pose&&own.poses?.[pose];
   if(posed)base.src=url(posed);else{const plain=art('portraits',portrait.dataset.characterId);if(plain&&!base.src.endsWith(plain))base.src=plain}
   figure.querySelector('.layer,.patch')?.remove();
   const layer=expression&&own.expressions?.[expression];if(!layer)return;
   if(typeof layer==='string'){const img=document.createElement('img');img.className='layer';img.alt='';img.src=url(layer);figure.append(img);return}
   const box=layer.at||own.face;if(!box)return;
   const place=element=>{element.className='patch';element.style.left=box[0]*100+'%';element.style.top=box[1]*100+'%';element.style.width=box[2]*100+'%';element.style.height=box[3]*100+'%';figure.append(element)};
   if(layer.image){const img=document.createElement('img');img.alt='';img.src=url(layer.image);place(img);return}
   const sheet=own.sheets?.[layer.sheet];if(!sheet)return;
   const cell=document.createElement('div'),column=layer.cell%sheet.columns,row=Math.floor(layer.cell/sheet.columns);
   cell.style.backgroundImage='url("'+url(sheet.image)+'")';cell.style.backgroundSize=sheet.columns*100+'% '+sheet.rows*100+'%';
   cell.style.backgroundPosition=(sheet.columns>1?column/(sheet.columns-1)*100:0)+'% '+(sheet.rows>1?row/(sheet.rows-1)*100:0)+'%';place(cell);
 }
 function art(folder,id){
   if(!id)return null;const slug=String(id).replace(/^[^:]+:/,'');
   for(const extension of folder==='portraits'?['png','webp']:['jpg','png','webp','jpeg']){
     const path='/frontend/custom/'+folder+'/'+slug+'.'+extension;
     if(stageAssets.includes(path))return '/frontend/custom/'+folder+'/'+encodeURIComponent(slug)+'.'+extension;
   }return null;
 }
 let audioContext=null,audioSource=null,audioGain=null,voiceVersion=0,voiceKey='';
 const bgm=(${createBgmPlayback.toString()})(api,()=>audioContext,message=>node('bgm-notice').textContent=message);
 const bgmVolume=()=>preferences.muted?0:preferences.volume/100;
 function playBgm(){if(hasBgm)bgm.update(playback.current(),bgmVolume())}
 node('setting-bgm').onchange=async event=>{
   bgm.setEnabled(event.target.checked);
   if(event.target.checked){try{audioContext=audioContext||new AudioContext();await audioContext.resume();playBgm()}catch{node('bgm-notice').textContent='无法开启背景音乐，请再次点击页面'}}
 };
 function stopVoice(){voiceVersion++;if(audioSource){audioSource.stop();audioSource=null}}
 async function playVoice(){
   const unit=playback.current(),key=JSON.stringify(unit);
   if(!hasSpeech||!preferences.voiceEnabled||preferences.muted||!preferences.volume||!playback.pending()||unit?.player||unit?.type!=='speech'){stopVoice();voiceKey='';return}
   if(key===voiceKey)return;voiceKey=key;stopVoice();const version=voiceVersion;
   if(!audioContext||audioContext.state!=='running'){node('voice-notice').textContent='点击页面后开始播放语音。';return}
   try{
     const result=await api.synthesizeSpeech(unit.seq,unit.segmentIndex,unit.text);
     if(version!==voiceVersion)return;
     const buffer=await audioContext.decodeAudioData(result.bytes);
     if(version!==voiceVersion)return;
     audioSource=audioContext.createBufferSource();audioGain=audioContext.createGain();audioGain.gain.value=preferences.volume/100;
     audioSource.buffer=buffer;audioSource.connect(audioGain);audioGain.connect(audioContext.destination);audioSource.start();node('voice-notice').textContent='';
   }catch(error){if(version===voiceVersion)node('voice-notice').textContent='语音暂不可用：'+error.message}
 }
 function applyPreferences(){
   const root=document.documentElement;root.dataset.appearance=preferences.appearance;
   root.style.setProperty('--fs-story',preferences.fontSize+'px');root.style.setProperty('--story-line-height',String(preferences.lineHeight));
   for(const key of ['fontSize','lineHeight','autoSpeed','volume']){node('setting-'+key).value=String(preferences[key]);node('value-'+key).textContent=key==='fontSize'?preferences[key]+' px':key==='volume'?preferences[key]+'%':preferences[key]+' ×'}
   for(const key of ['autoFollow','muted','voiceEnabled'])node('setting-'+key).checked=preferences[key];
   for(const radio of document.querySelectorAll('input[name="appearance"]'))radio.checked=radio.value===preferences.appearance;
   if(audioGain)audioGain.gain.value=preferences.muted?0:preferences.volume/100;
   bgm.setVolume(bgmVolume());playBgm();
   autoKey='';clearTimeout(autoTimer);autoTimer=null;scheduleAuto();playVoice();
 }
 async function changePreference(key,value){
   preferences=normalizePreferences({...preferences,[key]:value});applyPreferences();const version=++preferencesVersion;
   try{await api.request('stagePreferences',preferences);if(version===preferencesVersion)node('settings-notice').textContent='已保存到本机，即时生效。'}catch(error){if(version===preferencesVersion)node('settings-notice').textContent=error.message}
 }
 for(const key of ['fontSize','lineHeight','autoSpeed','volume'])node('setting-'+key).oninput=event=>changePreference(key,Number(event.target.value));
 for(const key of ['autoFollow','muted','voiceEnabled'])node('setting-'+key).onchange=async event=>{
   if(key==='voiceEnabled'&&event.target.checked){try{audioContext=audioContext||new AudioContext();await audioContext.resume();voiceKey=''}catch(error){node('voice-notice').textContent='无法开启语音：'+error.message;event.target.checked=false;return}}
   changePreference(key,event.target.checked);
 };
 for(const radio of document.querySelectorAll('input[name="appearance"]'))radio.onchange=()=>changePreference('appearance',radio.value);
 async function unlockVoice(){
   if((!hasSpeech||!preferences.voiceEnabled)&&(!hasBgm||!node('setting-bgm').checked)||audioContext?.state==='running')return;
   try{audioContext=audioContext||new AudioContext();await audioContext.resume();voiceKey='';playVoice();playBgm()}catch(error){node('voice-notice').textContent='无法开启声音：'+error.message}
 }
 document.addEventListener('pointerdown',unlockVoice);
 document.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')unlockVoice()});
 node('stage-save').onclick=()=>{
   if(node('stage-save').disabled)return;
   node('save-title').value=(latest?.scene?.locationName||'故事')+' · '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
   node('save-title').hidden=false;node('save-title').disabled=false;node('save-confirm').hidden=false;node('save-confirm').disabled=false;
   node('save-confirm').textContent='保存进度';node('save-cancel').textContent='取消';node('save-result').textContent='';node('save-dialog').dataset.state='idle';node('save-dialog').showModal();scheduleAuto();node('save-title').select();
 };
 function closeSave(){if(!saving)node('save-dialog').close()}
 node('save-close').onclick=node('save-cancel').onclick=closeSave;
 node('save-dialog').addEventListener('cancel',event=>{event.preventDefault();closeSave()});
 node('save-dialog').addEventListener('close',()=>{node('stage-save').focus();scheduleAuto()});
 node('save-title').onkeydown=event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();node('save-confirm').click()}};
 node('save-confirm').onclick=async()=>{
   if(saving)return;saving=true;controls();
   const dialog=node('save-dialog');dialog.dataset.state='saving';node('save-result').textContent='正在保存此刻的故事……';
   for(const id of ['save-confirm','save-cancel','save-close','save-title'])node(id).disabled=true;
   try{const result=await api.request('saveProgress',{title:node('save-title').value});dialog.dataset.state='success';node('save-result').textContent='已保存「'+result.title+'」';node('save-confirm').hidden=true;node('save-cancel').textContent='完成'}
   catch(error){dialog.dataset.state='error';node('save-result').textContent='保存未完成：'+error.message;node('save-confirm').textContent='重试保存'}
   finally{saving=false;for(const id of ['save-confirm','save-cancel','save-close','save-title'])node(id).disabled=false;controls()}
 };
 window.addEventListener('pagehide',()=>{stopVoice();bgm.close();audioContext?.close()});
 function updateAutoProgress(duration){
   const wrap=node('auto-progress'),bar=node('auto-progress-bar');
   if(!wrap||!bar)return;
   if(duration>0){
     wrap.hidden=false;bar.style.transition='none';bar.style.width='0%';
     void bar.offsetWidth;
     bar.style.transition='width '+duration+'ms linear';bar.style.width='100%';
   }else{
     wrap.hidden=true;bar.style.transition='none';bar.style.width='0%';
   }
 }
 function renderStage(){
   const unit=playback.current();
   node('speaker').textContent=unit?.speaker||'序幕';node('dialogue').replaceChildren();fillText(node('dialogue'),unit?.text||'看看眼前的世界，向角色打个招呼吧。');
   node('dialogue').dataset.type=unit?.type||'speech';node('reading-count').textContent=playback.pending()?'待阅读 '+playback.remaining()+' 段':'已读完';
   node('dialogue').classList.remove('fade-in');void node('dialogue').offsetWidth;node('dialogue').classList.add('fade-in');
   const scene=playback.stageScene(latest?.scene||null),key=JSON.stringify(scene);
   if(key!==sceneKey){
     if(sceneKey&&scene?.locationName&&node('scene').textContent!==scene.locationName)showToast('movement-toast','当前情景 · '+scene.locationName);
    sceneKey=key;node('scene').textContent=scene?.locationName||'情景尚未开始';
    const background=node('background'),backgroundUrl=art('backgrounds',scene?.locationId);
    background.hidden=true;background.onerror=()=>background.hidden=true;background.onload=()=>background.hidden=false;
    if(backgroundUrl)background.src=backgroundUrl;else background.removeAttribute('src');
    node('character-menu').hidden=true;
    const box=node('characters'),present=scene?.recipients||[],kept=new Map();
    box.querySelector('.alone')?.remove();
    for(const old of box.querySelectorAll('.portrait:not(.leaving)')){
      if(present.some(person=>person.id===old.dataset.characterId))kept.set(old.dataset.characterId,old);
      else{old.classList.add('leaving');setTimeout(()=>old.remove(),320)}
    }
    for(const {id,name} of present)box.append(kept.get(id)||createPortrait(id,name));
    if(!present.length){const empty=document.createElement('span');empty.className='alone';empty.textContent='片刻的宁静';box.append(empty)}
   }
   if(unit?.speakerId&&unit.expression){const speaker=[...node('characters').querySelectorAll('.portrait:not(.leaving)')].find(p=>p.dataset.characterId===unit.speakerId);if(speaker)dress(speaker,unit.expression,speaker.dataset.pose||null)}
   for(const portrait of node('characters').querySelectorAll('.portrait'))portrait.classList.toggle('speaking',!!unit?.speakerId&&unit.speakerId===portrait.dataset.characterId);
   playVoice();playBgm();scheduleAuto();
 }
 function scheduleAuto(){
   const key=JSON.stringify(playback.current());
   const unobstructed=!document.querySelector('.panel:not([hidden])')&&!node('save-dialog').open;
   if(autoTimer&&autoKey===key&&auto&&unobstructed)return;
   clearTimeout(autoTimer);autoTimer=null;autoKey=key;updateAutoProgress(0);
   if(auto&&playback.pending()&&unobstructed){
     const duration=Math.max(1500,Math.min(28000,Math.max(2500,(playback.current()?.text.length||0)*90)/preferences.autoSpeed));
     updateAutoProgress(duration);
     autoTimer=setTimeout(()=>{autoTimer=null;updateAutoProgress(0);advance()},duration);
   }
 }
 // Author-configured opening: perform only offered actions, after the current text has been read.
 function scheduleOpening(){
   const config=stageConfig?.autoplay;
   if(!config||openingHalted||!latest||!connected)return;
   const entry=(latest.activities||[]).find(item=>item.key===config.activity);
   const start=latest.actions.find(option=>option.target?.id===config.activity&&option.action?.parameters?.definitionRef?.id==='host:activity-start');
   if(!openingSeen&&(entry?.active||start)){
     openingSeen=true;openingPreviousAuto=auto;setAuto(true);
   }
   if(!openingSeen)return;
   if(entry&&!entry.active&&entry.phase==='finished'&&!playback.pending()&&!posting){
     openingSeen=false;setAuto(openingPreviousAuto);return;
   }
   if(!auto||posting||pending||openingTimer||latest.status!=='ready'||playback.pending()||document.querySelector('.panel:not([hidden])')||node('save-dialog').open)return;
   const next=latest.actions.find(option=>option.target?.id===config.activity&&option.action?.parameters?.definitionRef?.id==='activity:'+config.operation);
   const retry=latest.actions.find(option=>option.target?.id===config.activity&&option.action?.parameters?.definitionRef?.id==='host:activity-retry');
   const action=entry?.active?(next||retry):start;
   if(!action)return;
   if(action===retry&&openingRetried===action.id){openingHalted=true;setAuto(openingPreviousAuto);return}
   openingTimer=setTimeout(()=>{openingTimer=null;if(openingHalted||!auto||posting||pending||latest.status!=='ready'||playback.pending()||document.querySelector('.panel:not([hidden])')||node('save-dialog').open)return;if(!latest.actions.some(option=>option.id===action.id)){scheduleOpening();return}if(action===retry)openingRetried=action.id;send('perform',{optionId:action.id})},0);
 }
 function canReplyNow(){
   const policy=latest?.expression||{speech:'free',speechChoices:[],narration:true};
   return !posting&&connected&&(['ready','error'].includes(latest?.status)||latest?.canInterrupt)&&(policy.speech!=='none'||policy.narration);
 }
 function advance(){
   if(document.querySelector('.panel:not([hidden])')||node('save-dialog').open)return;
   updateAutoProgress(0);
   if(playback.pending()){
     playback.advance();
     renderStage();
     controls();
   }else if(canReplyNow()){
     composerExpanded=true;
     if(activityOpen)activityOpen=false;
     controls();
     node('input').focus();
   }
 }
 // Only one drawer is visible at a time; every drawer pauses automatic reading.
 function drawer(name){node('character-menu').hidden=true;audienceMenu(false);for(const [id,toggle] of [['history-panel','history-toggle'],['action-panel','actions-toggle'],['message-panel','composer-message'],['inventory-panel','inventory-toggle'],['status-panel','status-toggle'],['settings-panel','settings-toggle']]){node(id).hidden=id!==name;node(toggle).setAttribute('aria-expanded',String(id===name))}scheduleAuto()}
 function historyPanel(open){if(open)drawer('history-panel');else node('history-panel').hidden=true;node('history-toggle').setAttribute('aria-expanded',String(open));if(open){clearTimeout(autoTimer);autoTimer=null;updateAutoProgress(0);node('history-close').focus();bottom()}else{node('history-toggle').focus();scheduleAuto()}controls()}
 node('dialogue').onclick=advance;
 node('skip-read').onclick=()=>{updateAutoProgress(0);playback.skip();renderStage();if(canReplyNow())composerExpanded=true;controls();if(canReplyNow())node('input').focus()};
 // Every change of auto-read goes through here, so the button, the opening card and the timer agree.
 function setAuto(value){auto=value;node('auto-read').setAttribute('aria-pressed',String(auto));node('auto-read').classList.toggle('active',auto);if(latest)renderActivity(latest);scheduleAuto()}
 node('auto-read').onclick=()=>{setAuto(!auto);controls()};
 node('history-toggle').onclick=()=>historyPanel(node('history-panel').hidden);node('history-close').onclick=()=>historyPanel(false);
 node('actions-toggle').onclick=()=>{drawer(node('action-panel').hidden?'action-panel':null);controls()};node('actions-close').onclick=()=>{drawer(null);controls()};
 node('composer-actions').onclick=()=>{drawer(node('action-panel').hidden?'action-panel':null);controls()};
 node('composer-message').onclick=()=>{const open=node('message-panel').hidden;drawer(open?'message-panel':null);controls();if(open)node('message-text').focus()};node('message-close').onclick=()=>{drawer(null);controls()};node('message-send').onclick=sendMessage;
 node('inventory-toggle').onclick=()=>{const open=node('inventory-panel').hidden;drawer(open?'inventory-panel':null);if(open)node('inventory-close').focus();controls()};node('inventory-close').onclick=()=>{drawer(null);node('inventory-toggle').focus();controls()};
 node('status-toggle').onclick=()=>{drawer(node('status-panel').hidden?'status-panel':null);controls()};node('status-close').onclick=()=>{drawer(null);controls()};
 node('settings-toggle').onclick=()=>{const open=node('settings-panel').hidden;drawer(open?'settings-panel':null);if(open)node('settings-close').focus();controls()};node('settings-close').onclick=()=>{drawer(null);node('settings-toggle').focus();controls()};
 node('reply-context').onclick=()=>{composerExpanded=false;controls()};
 node('reply-context').onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();composerExpanded=false;controls();node('dialogue').focus()}};
 document.addEventListener('keydown',event=>{if(node('save-dialog').open)return;if(event.key==='Escape'){if(!node('character-menu').hidden){node('character-menu').hidden=true;return}if(!node('audience-menu').hidden){audienceMenu(false);node('audience-button').focus();return}const toggle=document.querySelector('.stage-tools button[aria-expanded="true"]');drawer(null);composerExpanded=false;controls();toggle?.focus();return}if((event.key===' '||event.key==='Enter')&&!['INPUT','TEXTAREA','SELECT','BUTTON','SUMMARY'].includes(document.activeElement?.tagName)){event.preventDefault();advance()}});
 let lastWheel=0;
 document.addEventListener('wheel',event=>{
   if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;
   if(event.target.closest('.panel,.character-menu,.audience-menu,.activity-card,dialog,.composer,.dialogue'))return;
   const now=Date.now();
   if(now-lastWheel<280)return;
   if(event.deltaY<-40&&node('history-panel').hidden){lastWheel=now;historyPanel(true)}
   else if(event.deltaY>40&&node('history-panel').hidden){lastWheel=now;advance()}
 },{passive:true});
 api.subscribe(event=>{if(event.type==='presentation'){activityOpen=event.activityOpen===true;if(activityOpen)composerExpanded=false;controls()}if(event.view){connected=true;render(event.view)}if(event.type==='disconnected'){connected=false;node('status').textContent='连接断开';node('status').dataset.state='disconnected';controls()}});
 controls();api.ready.then(info=>{canRegenerate=info.capabilities.includes('regenerate');hasSpeech=info.capabilities.includes('speech');hasBgm=info.capabilities.includes('bgm');node('setting-bgm').disabled=!hasBgm;node('setting-bgm').checked=hasBgm;node('bgm-hint').textContent=hasBgm?'随阅读进度切换音乐':'尚未安装背景音乐插件';canSave=info.canSave===true;stageAssets=info.stageAssets||[];stageConfig=info.stageConfig||null;preferences=normalizePreferences(info.stagePreferences,{...info.view.settings?.reading,...info.view.settings?.audio,...(info.view.settings?.appearance?{appearance:info.view.settings.appearance}:{})});applyPreferences();node('setting-voiceEnabled').disabled=!hasSpeech;node('voice-hint').textContent=hasSpeech?'朗读当前角色的对白':'尚未安装语音服务';node('save-unavailable').hidden=canSave;connected=true;render(info.view)}).catch(error=>{node('notice').textContent=error.message;controls()});
})();`
