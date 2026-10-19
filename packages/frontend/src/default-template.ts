import { createReadingPlayback } from './reading-playback.ts'
import { STAGE_STYLE } from './stage-style.ts'

export const DEFAULT_PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Perspectra 对话</title><link rel="stylesheet" href="/frontend/default.css"></head>
<body><main>
  <div class="backdrop" aria-hidden="true"></div>
  <header class="world-header"><div class="scene-heading"><div><h2 id="scene">正在进入情景</h2><h1 id="title">正在进入世界</h1><div id="status-bar" class="status-bar" role="group" aria-label="你知道的状态" hidden></div></div></div><nav class="stage-tools" aria-label="舞台工具"><span id="status" class="status" role="status">正在连接</span><button id="history-toggle" type="button" aria-expanded="false">文字记录</button><button id="actions-toggle" type="button" aria-expanded="false">行动 <span id="action-count">0</span></button></nav></header>
  <div id="characters" aria-label="当前可见角色"></div>
  <p id="movement-toast" class="movement-toast" role="status" hidden></p>
  <section class="stage-bottom" aria-label="故事与对话">
    <div class="dialogue-wrap" id="dialogue-wrap"><div class="dialogue-meta"><strong id="speaker" class="speaker-label">序幕</strong><span id="reading-count" class="reading-count"></span></div><button id="dialogue" class="dialogue" type="button" aria-label="阅读下一段">世界正在醒来……</button><div id="auto-progress" class="auto-progress" hidden><div id="auto-progress-bar" class="auto-progress-bar"></div></div><div class="dialogue-footer"><span id="continue-hint">点击继续</span><button id="auto-read" type="button" aria-pressed="false">自动</button><button id="skip-read" type="button" title="跳到已经发生的最新内容">跳过</button>      <div id="round-tools" class="round-tools" role="group" aria-label="末端回合候选" hidden><button id="candidate-prev" type="button" aria-label="上一个候选" title="上一个候选">‹</button><span id="candidate-count" aria-live="polite"></span><button id="candidate-next" type="button" aria-label="下一个候选" title="下一个候选">›</button><button id="regenerate-round" type="button" aria-label="重新生成" title="重新生成此回合"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 3l1 3M4 12l1 3a8 8 0 0 0 13 3"/></svg></button><button id="cancel-round" type="button" aria-label="取消重新生成" title="取消重新生成" hidden>停止</button></div>
</div></div>
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
        <span class="composer-keys">Enter 发送 · Shift+Enter 换行</span><button id="send" type="button">发送 <span aria-hidden="true">↑</span></button></div>
        <p id="audience-preview" class="visually-hidden" aria-live="polite"></p>
        </div><div id="quick-actions" class="quick-actions" role="group" aria-label="可以尝试的行动" hidden></div></div>
      </div>
  </section>
  <section id="history-panel" class="panel history-panel" aria-label="文字记录" hidden><div class="panel-header"><span>文字记录 · <span id="player"></span></span><button id="history-close" type="button" aria-label="关闭文字记录">×</button></div><section id="history" aria-label="玩家可见对话记录"></section><button id="latest" class="latest secondary" type="button" hidden>回到最新对话 ↓</button></section>
  <section id="action-panel" class="panel action-panel" aria-label="可用行动" hidden><div class="panel-header"><span>当前可用行动</span><button id="actions-close" type="button" aria-label="关闭行动">×</button></div><div id="actions"></div></section>
</main><script src="/frontend/sdk.js"></script><script src="/frontend/default.js"></script></body></html>`;

export const DEFAULT_STYLE = STAGE_STYLE;

/** Status bar rows grouped by holder, in the order the view lists them; a stale value reads "上次确认". */
function statusBarRows(view: { player: { name: string }; statusBar?: { label: string; holderId: string | null; holderName?: string; value: unknown; current: boolean }[] }) {
  const groups: { holder: string; items: { label: string; value: string; note: string }[] }[] = []
  for (const entry of view.statusBar || []) {
    const holder = entry.holderId === null ? '世界' : entry.holderName === view.player.name ? '你' : entry.holderName || entry.holderId
    let group = groups.find(item => item.holder === holder)
    if (!group) { group = { holder, items: [] }; groups.push(group) }
    group.items.push({ label: entry.label, value: entry.value === true ? '是' : entry.value === false ? '否' : String(entry.value),
      note: entry.current ? '' : '上次确认' })
  }
  return groups
}
/** Quick-action group of one option; status operations belong with items and interactions. */
function quickActionGroup(option: { action?: { actionType?: string; parameters?: { definitionRef?: { id?: unknown }; targetRef?: { kind?: unknown }; arguments?: { recipientId?: unknown } } } }) {
  const action = option.action || {}, p = action.parameters || {}, definition = String(p.definitionRef?.id || '')
  if (action.actionType === 'move') return 'move'
  if (definition.startsWith('host:activity') || definition.startsWith('activity:')) return 'activity'
  if (definition.startsWith('status:')) return 'items'
  if (p.targetRef?.kind === 'character' || typeof p.arguments?.recipientId === 'string') return 'people'
  return 'items'
}

export const DEFAULT_SCRIPT = String.raw`(() => {
 const playback=(${createReadingPlayback.toString()})();
 const api=window.Perspectra,node=id=>document.getElementById(id);
 let latest,posting=false,pending,connected=false,historyKey='',actionsKey='',statusKey='',canRegenerate=false,requestVersion=0,submittedPlayers=0;
 const statusRows=(${statusBarRows.toString()});
 const actionGroup=(${quickActionGroup.toString()});
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
   node('send').disabled=disabled||(policy.speech!=='free'&&!policy.narration)||!((policy.speech==='free'&&node('input').value.trim())||(policy.narration&&node('narration').value.trim()))||((speechScope()==='direct'||speechScope()==='private')&&!node('speech-recipient').value);
   for(const radio of document.querySelectorAll('input[name="speech-scope"]'))radio.disabled=disabled;
   node('audience-button').disabled=disabled;if(disabled)audienceMenu(false);
   node('speech-recipient').disabled=disabled||!latest?.scene?.recipients?.length;
   node('input').disabled=disabled||policy.speech!=='free';node('input').hidden=policy.speech!=='free';node('narration').disabled=disabled||!policy.narration;node('narration-panel').hidden=!policy.narration;
   for(const button of node('expression-choices').querySelectorAll('button'))button.disabled=disabled||(['direct','private'].includes(speechScope())&&!node('speech-recipient').value);
   const canReply=!disabled&&(policy.speech!=='none'||policy.narration);
   const mode=readingBlocked||posting||(!canReply&&!activityOpen)?'reading':activityOpen?'activity':(composerExpanded&&canReply)?'response':'reading';
   document.querySelector('main').dataset.mode=mode;
   document.querySelector('main').dataset.hasActivity=String(!!(latest?.activity||latest?.activities?.length));
   if(connected&&latest?.status==='ready')node('status').textContent=mode==='response'?'等待你的回应':mode==='activity'?'可以操作':readingBlocked?'阅读中':'已读完';
   node('composer').hidden=mode!=='response';node('dialogue-wrap').hidden=mode==='response';
   const unit=playback.current();node('reply-speaker').textContent=unit?.speaker||'当前情景';node('reply-summary').textContent=unit?.text||'故事从你的回应开始。';
   node('actions-toggle').disabled=actionDisabled;
   if(actionDisabled)node('action-panel').hidden=true;
   node('actions-toggle').setAttribute('aria-expanded',String(!node('action-panel').hidden));
   node('continue-hint').textContent=readingBlocked?'点击或按空格继续 · 上滚查看记录':latest?.status==='busy'?'角色还在回应，新内容到达后继续':canReply?'轮到你了 · 点击这里回应':'已读完 · 可以选择行动';
   for(const button of node('actions').querySelectorAll('button'))button.disabled=actionDisabled||button.dataset.unavailable==='true';
   for(const picker of node('actions').querySelectorAll('select'))picker.disabled=actionDisabled;
   for(const button of node('quick-actions').querySelectorAll('button[data-option]'))button.disabled=actionDisabled;
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
 }
 function bottom(){history.scrollTop=history.scrollHeight;node('latest').hidden=true}
 history.onscroll=()=>{node('latest').hidden=history.scrollHeight-history.scrollTop-history.clientHeight<70};
 node('latest').onclick=bottom;
 function render(view){
   if(posting&&pending?.method==='speak'&&view.canInterrupt&&view.history.filter(line=>line.player).length>submittedPlayers){
     if(node('input').value.trim()===pending.payload.text)node('input').value='';
     if(node('narration').value.trim()===(pending.payload.narration||''))node('narration').value='';
     posting=false;pending=null;requestVersion++;
   }
   const candidate=tail=>tail?.candidateIds?.[(tail.candidateIndex||1)-1]||null;
   if(latest?.tailRound?.id&&latest.tailRound.id===view.tailRound?.id&&candidate(latest.tailRound)!==candidate(view.tailRound))playback.invalidateScene();
   latest=view;renderRecipients(view);const hadPending=playback.pending();playback.update(view.history);if(!hadPending&&playback.pending())composerExpanded=false;renderStage();
   const expression=view.expression||{speech:'free',speechChoices:[],narration:true};
   if(JSON.stringify(expression)!==expressionKey){expressionKey=JSON.stringify(expression);node('expression-choices').replaceChildren();if(expression.speech==='choices')for(const text of expression.speechChoices){const button=document.createElement('button');button.type='button';button.textContent=text;button.onclick=()=>send('speak',{text,scope:speechScope(),addresseeIds:['direct','private'].includes(speechScope())?[node('speech-recipient').value]:[]});node('expression-choices').append(button)}}
   document.documentElement.dataset.palette=['sakura','lamp','moon','forest'].includes(view.settings?.palette)?view.settings.palette:'sakura';
   const reading=view.settings?.reading||{fontSize:17,lineHeight:1.9,autoFollow:true};
   document.documentElement.style.setProperty('--fs-story',reading.fontSize+'px');document.documentElement.style.setProperty('--story-line-height',String(reading.lineHeight));
   node('input').maxLength=node('narration').maxLength=view.settings?.inputCharacters||2000;
   node('title').textContent=view.game.title;node('player').textContent='你 · '+view.player.name;
   const nextStatus=JSON.stringify([view.player.name,view.statusBar||[]]);
   if(nextStatus!==statusKey){statusKey=nextStatus;const bar=node('status-bar'),rows=statusRows(view);bar.replaceChildren();bar.hidden=!rows.length;
     for(const group of rows){const section=document.createElement('span');section.className='status-group';const holder=document.createElement('small');holder.textContent=group.holder;section.append(holder);
       for(const item of group.items){const entry=document.createElement('span');entry.className='status-item';entry.append(item.label+' ');const value=document.createElement('strong');value.textContent=item.value;entry.append(value);
         if(item.note){const note=document.createElement('span');note.className='hint';note.textContent=item.note;entry.append(' ',note)}section.append(entry)}
       bar.append(section)}}
   node('status').textContent=({ready:playback.pending()?'阅读中':'可以回应',busy:view.responders?.length?view.responders.join('、')+' 正在回应':view.canInterrupt?'可以接着说':view.tailRound?.regenerating?'正在处理回合':'角色正在回应',paused:'已暂停',error:'处理未完成'})[view.status];
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
       const article=document.createElement('article');article.className='line'+(line.player?' player':'');if(!line.player)article.style.setProperty('--hue',String(hueOf(line.speaker)));
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
     actionsKey=nextActions;node('actions').replaceChildren();node('action-count').textContent=String(view.actions.length);
     for(const [type,title] of [['move','移动'],['interact','物品与互动']]){
       const options=view.actions.filter(option=>option.action.actionType===type);if(!options.length)continue;
       const group=document.createElement('section');group.className='action-group';
       const heading=document.createElement('h3');heading.textContent=title;group.append(heading);
       for(const option of options){const button=document.createElement('button');button.type='button';
         const label=document.createElement('span');label.textContent=option.label;const arrow=document.createElement('span');arrow.textContent='↗';arrow.setAttribute('aria-hidden','true');button.append(label,arrow);
         if(option.participantSelection){
           const selection=option.participantSelection,picker=document.createElement('select');picker.setAttribute('aria-label','选择参与角色');
           picker.multiple=selection.max>1;
           for(const candidate of selection.candidates){const item=document.createElement('option');item.value=candidate.id;item.textContent=candidate.name;picker.append(item)}
           button.onclick=()=>{const npcIds=Array.from(picker.selectedOptions,item=>item.value);
             if(npcIds.length<selection.min||npcIds.length>selection.max){node('notice').textContent='请选择 '+selection.min+' 至 '+selection.max+' 名参与角色';return}
             send('perform',{optionId:option.id,npcIds})};group.append(picker);
           if(selection.candidates.length<selection.min)button.dataset.unavailable='true';
         }else button.onclick=()=>send('perform',{optionId:option.id});group.append(button)}
       node('actions').append(group);
     }
     if(!view.actions.length){const empty=document.createElement('p');empty.className='no-actions';empty.textContent='暂时没有可用行动，仍可通过对话表达。';node('actions').append(empty)}
     renderQuickActions(view.actions);
   }
   controls();
 }
 /* 回应时的右栏行动：每类一个按钮，按下后弹出该类可选行动（与发言受众相同的交互）；与当前说话者相关的排在前面。需要选人的行动打开「行动」面板完成。 */
 const QUICK_GROUPS={activity:'活动',people:'与角色',items:'物品与互动',move:'移动'};
 let quickOpen=null;
 function relevance(option){const unit=playback.current(),p=option.action?.parameters||{};let score=0;
   if(unit?.speakerId&&(p.targetRef?.id===unit.speakerId||p.arguments?.recipientId===unit.speakerId))score+=3;
   if(unit?.speaker&&option.label.includes(unit.speaker))score+=2;return score}
 function quickMenu(group){quickOpen=group;for(const wrap of node('quick-actions').querySelectorAll('.quick-group')){const open=wrap.dataset.group===group;
   wrap.querySelector('.quick-menu').hidden=!open;wrap.querySelector('.group-button').setAttribute('aria-expanded',String(open))}}
 function renderQuickActions(actions){
   const box=node('quick-actions');box.replaceChildren();box.hidden=!actions.length;if(!actions.length){quickOpen=null;return}
   const groups=new Map(),order=Object.keys(QUICK_GROUPS);
   actions.map((option,index)=>({option,index,score:relevance(option)})).sort((a,b)=>b.score-a.score||a.index-b.index)
     .forEach(entry=>{const group=actionGroup(entry.option);if(!groups.has(group))groups.set(group,[]);groups.get(group).push(entry)});
   const best=group=>Math.max(...groups.get(group).map(entry=>entry.score));
   if(quickOpen&&!groups.has(quickOpen))quickOpen=null;
   const caption=document.createElement('small');caption.textContent='可以尝试';box.append(caption);
   for(const group of [...groups.keys()].sort((a,b)=>best(b)-best(a)||order.indexOf(a)-order.indexOf(b))){
     const entries=groups.get(group),wrap=document.createElement('div');wrap.className='quick-group';wrap.dataset.group=group;
     const button=document.createElement('button');button.type='button';button.className='group-button';button.setAttribute('aria-haspopup','true');
     button.setAttribute('aria-expanded',String(quickOpen===group));if(best(group)>0)button.classList.add('related');
     const name=document.createElement('span');name.textContent=QUICK_GROUPS[group];const count=document.createElement('span');count.className='count';count.textContent=String(entries.length);
     button.append(name,count);button.onclick=()=>quickMenu(quickOpen===group?null:group);
     const menu=document.createElement('div');menu.className='quick-menu';menu.hidden=quickOpen!==group;
     const title=document.createElement('p');title.textContent=QUICK_GROUPS[group]+' · '+entries.length+' 项';menu.append(title);
     for(const {option,score} of entries){const item=document.createElement('button');item.type='button';item.dataset.option=option.id;item.textContent=option.label;
       if(score>0){item.classList.add('related');item.title='与刚才说话的角色有关'}
       if(option.participantSelection){item.classList.add('needs-choice');item.title='需要选择参与角色';item.onclick=()=>{quickMenu(null);node('action-panel').hidden=false;controls()}}
       else item.onclick=()=>{quickMenu(null);send('perform',{optionId:option.id})};
       menu.append(item)}
     wrap.append(button,menu);box.append(wrap)}
 }
 document.addEventListener('click',event=>{if(quickOpen&&!node('quick-actions').contains(event.target))quickMenu(null)});
 async function refresh(expectedVersion){try{const view=await api.getView();if(expectedVersion!==requestVersion)return;connected=true;render(view)}catch(error){if(expectedVersion!==requestVersion)return;node('notice').textContent=error.message;connected=false;node('status').textContent='连接断开';node('status').dataset.state='disconnected';controls()}}
 async function submit(request){
   const version=++requestVersion;submittedPlayers=latest?.history.filter(line=>line.player).length||0;
   posting=true;controls();node('notice').textContent='正在提交……';
   try{await api.request(request.method,request.payload,request.actionId);if(version!==requestVersion)return;
     const view=await api.getView();if(version!==requestVersion)return;
     if(request.method==='speak'){if(node('input').value.trim()===request.payload.text)node('input').value='';if(node('narration').value.trim()===(request.payload.narration||''))node('narration').value=''}pending=null;node('notice').textContent='';render(view)}
   catch(error){if(version!==requestVersion)return;if((request.method==='regenerate'||request.method==='selectCandidate')&&error.retryable===false)pending=null;node('notice').textContent=error.message+(pending?'；可重试查询同一操作结果。':'')}
   finally{if(version===requestVersion){await refresh(version);if(version===requestVersion){posting=false;controls()}}}
 }
 function send(method,payload){
   const tailOperation=method==='regenerate'||method==='selectCandidate';
   if(posting||!connected||(!tailOperation&&playback.pending())||(tailOperation?!latest?.tailRound?.canRegenerate:!['ready','error'].includes(latest?.status)&&!(method==='speak'&&latest?.canInterrupt)))return;
   composerExpanded=false;node('action-panel').hidden=true;pending={method,payload,actionId:api.newActionId()};submit(pending);
 }
 node('regenerate-round').onclick=()=>send('regenerate',{tailId:latest.tailRound.id});
 function choose(offset){const tail=latest?.tailRound,id=tail?.candidateIds?.[(tail.candidateIndex||1)-1+offset];if(id)send('selectCandidate',{tailId:tail.id,candidateId:id})}
 node('candidate-prev').onclick=()=>choose(-1);node('candidate-next').onclick=()=>choose(1);
 node('cancel-round').onclick=async()=>{try{await api.cancelRegeneration()}catch(error){node('notice').textContent=error.message}};
 node('retry').onclick=()=>{if(!posting&&connected&&pending)submit(pending)};
 node('send').onclick=()=>{const text=latest?.expression&&latest.expression.speech!=='free'?'':node('input').value.trim(),narration=latest?.expression?.narration===false?'':node('narration').value.trim();if(text||narration){const maximum=latest?.settings?.inputCharacters||2000;if(text.length+narration.length>maximum){node('notice').textContent='发言与描写合计不能超过 '+maximum+' 个字符';return}const scope=speechScope(),addresseeIds=scope==='direct'||scope==='private'?[node('speech-recipient').value]:[];if((scope==='direct'||scope==='private')&&!addresseeIds[0])return;send('speak',{text,narration,scope,addresseeIds})}};
 for(const radio of document.querySelectorAll('input[name="speech-scope"]'))radio.onchange=()=>{audience();audienceMenu(false);controls();if(['direct','private'].includes(speechScope()))node('speech-recipient').focus()};
 function audienceMenu(open){node('audience-menu').hidden=!open;node('audience-button').setAttribute('aria-expanded',String(open))}
 node('audience-button').onclick=()=>audienceMenu(node('audience-menu').hidden);
 document.addEventListener('click',event=>{if(!node('audience-picker').contains(event.target))audienceMenu(false)});
 node('speech-recipient').onchange=()=>{audience();controls()};
 audience();
 node('input').oninput=controls;node('narration').oninput=controls;
 node('narration-panel').addEventListener('toggle',()=>{if(node('narration-panel').open)node('narration').focus()});
 node('input').onkeydown=node('narration').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();node('send').click()}};
 let composerExpanded=false,activityOpen=false,auto=false,autoTimer=null,autoKey='',expressionKey='',sceneKey='',toastTimer=null;
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
     if(sceneKey&&scene?.locationName){node('movement-toast').textContent='当前情景 · '+scene.locationName;node('movement-toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>node('movement-toast').hidden=true,3500)}
    sceneKey=key;node('scene').textContent=scene?.locationName||'情景尚未开始';
    if(scene?.locationName){let hue=0;for(const ch of scene.locationName)hue=(hue*31+ch.codePointAt(0))>>>0;document.documentElement.style.setProperty('--scene-hue',String(hue%360))}
    node('characters').replaceChildren();
    for(const {id,name} of scene?.recipients||[]){const portrait=document.createElement('div');portrait.className='portrait';portrait.dataset.characterId=id;portrait.style.setProperty('--hue',String(hueOf(name)));
      const badge=document.createElement('div');badge.className='portrait-badge';badge.hidden=true;badge.textContent=Array.from(name)[0]||'◇';
      const slug=String(name).toLowerCase().split(/[\s（(·]/)[0];
      const img=document.createElement('img');img.src='/frontend/assets/'+encodeURIComponent(slug)+'.png';img.alt=name+'的立绘';img.onerror=()=>{img.remove();badge.hidden=false};portrait.append(img,badge);
      const label=document.createElement('span');label.className='character-name';label.textContent=name;portrait.append(label);node('characters').append(portrait)}
     if(!scene?.recipients.length){const empty=document.createElement('span');empty.className='alone';empty.textContent='片刻的宁静';node('characters').append(empty)}
   }
   if(latest)renderQuickActions(latest.actions||[]);
   for(const portrait of node('characters').children)portrait.classList.toggle('speaking',!!unit?.speakerId&&unit.speakerId===portrait.dataset.characterId);
   scheduleAuto();
 }
 function scheduleAuto(){
   const key=JSON.stringify(playback.current());
   if(autoTimer&&autoKey===key&&auto&&node('history-panel').hidden)return;
   clearTimeout(autoTimer);autoTimer=null;autoKey=key;updateAutoProgress(0);
   if(auto&&playback.pending()&&node('history-panel').hidden){
     const duration=Math.max(2500,Math.min(14000,(playback.current()?.text.length||0)*90));
     updateAutoProgress(duration);
     autoTimer=setTimeout(()=>{autoTimer=null;updateAutoProgress(0);advance()},duration);
   }
 }
 function canReplyNow(){
   const policy=latest?.expression||{speech:'free',speechChoices:[],narration:true};
   return !posting&&connected&&(['ready','error'].includes(latest?.status)||latest?.canInterrupt)&&(policy.speech!=='none'||policy.narration);
 }
 function advance(){
   if(!node('history-panel').hidden)return;
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
 function historyPanel(open){node('history-panel').hidden=!open;node('history-toggle').setAttribute('aria-expanded',String(open));if(open){clearTimeout(autoTimer);autoTimer=null;updateAutoProgress(0);node('history-close').focus();bottom()}else{node('history-toggle').focus();scheduleAuto()}controls()}
 node('dialogue').onclick=advance;
 node('skip-read').onclick=()=>{updateAutoProgress(0);playback.skip();renderStage();if(canReplyNow())composerExpanded=true;controls();if(canReplyNow())node('input').focus()};
 node('auto-read').onclick=()=>{auto=!auto;node('auto-read').setAttribute('aria-pressed',String(auto));node('auto-read').classList.toggle('active',auto);scheduleAuto()};
 node('history-toggle').onclick=()=>historyPanel(node('history-panel').hidden);node('history-close').onclick=()=>historyPanel(false);
 node('actions-toggle').onclick=()=>{node('action-panel').hidden=!node('action-panel').hidden;controls()};node('actions-close').onclick=()=>{node('action-panel').hidden=true;controls()};
 node('reply-context').onclick=()=>{composerExpanded=false;controls()};
 document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(!node('audience-menu').hidden){audienceMenu(false);node('audience-button').focus();return}if(quickOpen){const group=quickOpen;quickMenu(null);node('quick-actions').querySelector('[data-group="'+group+'"] .group-button')?.focus();return}historyPanel(false);node('action-panel').hidden=true;composerExpanded=false;controls();return}if((event.key===' '||event.key==='Enter')&&!['INPUT','TEXTAREA','SELECT','BUTTON','SUMMARY'].includes(document.activeElement?.tagName)){event.preventDefault();advance()}});
 let lastWheel=0;
 document.addEventListener('wheel',event=>{
   if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;
   if(node('history').contains(event.target))return;
   const now=Date.now();
   if(now-lastWheel<280)return;
   if(event.deltaY<-40&&node('history-panel').hidden){lastWheel=now;historyPanel(true)}
   else if(event.deltaY>40&&node('history-panel').hidden){lastWheel=now;advance()}
 },{passive:true});
 api.subscribe(event=>{if(event.type==='presentation'){activityOpen=event.activityOpen===true;if(activityOpen)composerExpanded=false;controls()}if(event.view){connected=true;render(event.view)}if(event.type==='disconnected'){connected=false;node('status').textContent='连接断开';node('status').dataset.state='disconnected';controls()}});
 controls();api.ready.then(info=>{canRegenerate=info.capabilities.includes('regenerate');connected=true;render(info.view)}).catch(error=>{node('notice').textContent=error.message;controls()});
})();`;
