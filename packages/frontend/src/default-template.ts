import {
  ACTIVITY_STAGE_HTML,
  ACTIVITY_STAGE_STYLE,
  createActivityStage,
  activityStageRendererSource,
} from './activity-stage.ts'
import type { ActivityStageRenderer } from '@perspectra/sdk/contracts'
import { GAMEPLAY_WIDGETS } from './gameplay-widgets.ts'
import { createRpgReading } from './rpg-reading.ts'
import { createReadingPlayback } from './reading-playback.ts'
import { createStatusPlayback } from './status-playback.ts'
import { actionReplyOutcome } from './request-outcome.ts'
import { createSuccessFeedback } from './success-feedback.ts'
import { STAGE_STYLE } from './stage-style.ts'
import { stagePreferences } from './stage-preferences.ts'
import { createBgmPlayback } from './bgm-playback.ts'
import { createParticipantPicker } from './participant-picker.ts'

export const DEFAULT_PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Perspectra 对话</title><link rel="stylesheet" href="/frontend/default.css"></head>
<body><main>
  <div class="backdrop" aria-hidden="true"><img id="background" alt="" hidden></div>
  <header class="world-header"><div class="scene-heading"><div><h2><button id="scene" class="scene-move" type="button" aria-controls="move-panel" aria-expanded="false">正在进入情景</button></h2><h1 id="title">正在进入世界</h1><button id="status-toggle" class="status-bar" type="button" aria-expanded="false" aria-controls="status-panel"><span>状态</span><span id="status-bar" class="status-preview-list" hidden></span><span id="status-cut" class="status-cut" hidden></span><span class="status-chevron" aria-hidden="true">▾</span></button></div></div><nav class="stage-tools" aria-label="辅助工具"><span id="plugin-tools" hidden></span><button id="history-toggle" type="button" aria-expanded="false" aria-controls="history-panel">记录</button><button id="settings-toggle" type="button" aria-expanded="false" aria-controls="settings-panel">设置</button></nav></header>
  <div id="characters" aria-label="当前可见角色"></div><div id="character-menu" class="character-menu" role="menu" hidden></div>
  <span id="success-announcement" class="visually-hidden" role="status"></span>
  <div class="stage-notifications" aria-live="polite"><p id="movement-toast" class="movement-toast" hidden></p><p id="item-toast" class="movement-toast" hidden></p></div>
  <section id="activity-card" class="activity-card" aria-label="当前活动" hidden><button id="activity-heading" class="activity-heading" type="button" aria-expanded="true"><small>当前活动</small><strong id="activity-title"></strong><span id="activity-phase"></span></button><div id="activity-body"><p id="activity-objective" hidden></p><dl id="activity-state"></dl><p id="activity-result" class="hint" role="status" hidden></p><div id="activity-options"></div><div id="activity-manage" class="activity-manage"></div><details id="activity-rules" hidden><summary>规则与说明</summary><p id="activity-instructions"></p></details></div></section>
  <section class="stage-bottom" aria-label="故事与对话"><nav class="stage-action-bar" aria-label="游戏操作"><button id="actions-toggle" type="button" aria-expanded="false" aria-controls="action-panel">行动</button><button id="activity-discover" type="button" aria-controls="activity-drawer" aria-expanded="false" hidden>活动</button><button id="move-toggle" type="button" aria-controls="move-panel" aria-expanded="false">移动</button><button id="nearby-toggle" type="button" aria-controls="nearby-panel" aria-expanded="false">周围物品</button></nav><span id="status" class="status" role="status">正在连接</span>
    <div class="dialogue-wrap" id="dialogue-wrap"><div class="dialogue-meta"><strong id="speaker" class="speaker-label">序幕</strong><span id="reading-count" class="reading-count"></span></div><div id="dialogue" class="dialogue" tabindex="-1"><span id="dialogue-text">世界正在醒来……</span><span id="read-arrow" aria-hidden="true" hidden></span></div><div id="auto-progress" class="auto-progress" hidden><div id="auto-progress-bar" class="auto-progress-bar"></div></div><div id="feedback" class="feedback"><p id="notice" role="status"></p><p id="host-notice"></p><div id="request-feedback" class="request-feedback" hidden><div class="request-copy" aria-live="polite"><strong id="request-title"></strong><p id="request-detail"></p></div><div class="request-controls"><button id="check-result" type="button">检查结果</button><button id="review-request" type="button">重新选择</button><button id="dismiss-request" type="button" aria-label="收起操作提示">×</button></div></div></div><div class="dialogue-footer"><button id="pickup-item" type="button" hidden>查看物品</button><button id="auto-read" type="button" aria-pressed="false">自动</button><button id="skip-read" type="button" title="跳到已经发生的最新内容">跳过</button>      <div id="round-tools" class="round-tools" role="group" aria-label="末端回合候选" hidden><button id="candidate-prev" type="button" aria-label="上一个候选" title="上一个候选">‹</button><span id="candidate-count" aria-live="polite"></span><button id="candidate-next" type="button" aria-label="下一个候选" title="下一个候选">›</button><button id="regenerate-round" type="button" aria-label="重新生成" title="重新生成此回合"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 3l1 3M4 12l1 3a8 8 0 0 0 13 3"/></svg></button><button id="cancel-round" type="button" aria-label="取消重新生成" title="取消重新生成" hidden>停止</button></div>
</div></div>
<div id="reply-bar" class="reply-bar" hidden><button id="reply-open" type="button">说点什么…</button></div>
      <div class="composer" id="composer" hidden><div class="reply-context" id="reply-context" role="button" tabindex="0" title="点击返回对白"><span id="reply-speaker"></span><p id="reply-summary"></p></div>
        <div id="composer-unread" class="composer-unread" hidden><span id="composer-unread-text" role="status"></span><button id="composer-read" type="button">先读未读</button><button id="composer-skip" type="button">跳过并继续编辑</button></div>
        <div class="composer-body"><div class="composer-main">
        <div id="expression-choices" class="expression-choices"></div><label class="visually-hidden" for="input">写下你的回应</label><textarea id="input" maxlength="2000" placeholder="说出你想对角色说的话……" rows="2"></textarea>
        <div class="composer-footer">
        <span id="attached-action" class="attached-action" hidden><span id="attached-label"></span><select id="attached-order" aria-label="说和做的顺序"><option value="before">先说后做</option><option value="after">先做后说</option></select><button id="attached-clear" type="button" aria-label="取消这个行动">×</button></span>


        <details class="composer-more"><summary>更多</summary><div class="composer-more-body"><details class="narration-composer" id="narration-panel"><summary title="描写你的动作、神态或语气（可选），与发言一起发送">描写</summary><label class="visually-hidden" for="narration">细节描写</label><textarea id="narration" maxlength="2000" placeholder="动作、神态或语气（可选）" rows="1" title="不会直接改变位置或物品归属"></textarea></details><button id="composer-actions" type="button" aria-controls="action-panel" aria-expanded="false" title="挑一个行动；输入框有字时，它会和这句话一起提交">＋ 行动</button><button id="composer-message" type="button" aria-controls="message-panel" title="给不在身边的人发消息，单独发送" hidden>短信</button><button id="wait" type="button" hidden title="不说也不做，让这一轮过去">静观</button><span class="composer-keys">Enter 发送 · Shift+Enter 换行</span></div></details><div id="send-cluster" class="send-cluster"><div id="audience-inline" class="audience-inline"><div class="audience-picker" id="audience-picker">
          <button id="audience-button" class="audience-button" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="audience-menu"><span class="audience-dot" aria-hidden="true"></span><span id="audience-badge">公开</span><span class="chevron" aria-hidden="true">▴</span></button>
          <div id="audience-menu" class="audience-menu" role="dialog" aria-label="设置发言受众" hidden>
            <fieldset class="audience-options"><legend>谁能听到这句话</legend>
              <label data-tip="当前场景里有权观察的角色都会收到完整内容。"><input type="radio" name="speech-scope" value="scene_public" checked><span>公开</span><small>在场的人都能听到</small></label>
              <label data-tip="只有选定的角色收到内容，其他角色不会观察到这次发言。"><input type="radio" name="speech-scope" value="direct"><span>定向</span><small>只说给一个人</small></label>
              <label data-tip="只有选定的角色收到内容；其他有权观察的角色只知道你们在私下交谈。"><input type="radio" name="speech-scope" value="private"><span>私密</span><small>悄悄话，旁人只看到在交谈</small></label>
              <label data-tip="只留给你自己，不会传播给任何角色。"><input type="radio" name="speech-scope" value="self"><span>仅自己</span><small>不让任何角色知道</small></label>
            </fieldset>
            <div id="recipient-panel" hidden><label for="speech-recipient">接收对象</label><select id="speech-recipient"></select><p id="recipient-hint" class="hint" hidden></p></div>
            <p id="audience-detail"></p><button id="audience-done" type="button">完成</button>
          </div>
        </div></div><span class="composer-submit"><button id="send" type="button" aria-label="发送"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m21 3-7.1 18-4.1-6.8L3 10.1 21 3Z"/><path d="M21 3 9.8 14.2"/></svg></button></span></div></div>
        <p id="audience-preview" class="visually-hidden" aria-live="polite"></p>
        </div></div>
      </div>
  </section>
  <section id="history-panel" class="panel history-panel" aria-label="文字记录" hidden><div class="panel-header"><span>文字记录 · <span id="player"></span></span><button id="history-close" type="button" aria-label="关闭文字记录">×</button></div><section id="history" aria-label="玩家可见对话记录"></section><button id="latest" class="latest secondary" type="button" hidden>回到最新对话 ↓</button></section>
  <section id="action-panel" class="panel action-panel" aria-label="行动索引" hidden>
    <div class="panel-header"><span>行动</span><button id="actions-close" type="button" aria-label="关闭行动">×</button></div>
    <div class="index-filters">
      <label class="visually-hidden" for="action-search">查找行动</label><input id="action-search" type="search" placeholder="查找行动、地点或对象" autocomplete="off">
      <label class="visually-hidden" for="action-category">按意图分类</label><select id="action-category"><option value="">全部</option><option value="move">前往地点</option><option value="item">使用物品</option><option value="character">交流与互动</option><option value="activity">参加活动</option><option value="other">其他</option></select>
      <p id="action-gate" class="hint" role="status" hidden></p>
    </div>
    <div id="actions" class="panel-body">
      <nav class="index-browse" aria-label="查阅场景">
        <button id="index-browse-move" type="button">查阅地点</button><button id="index-browse-nearby" type="button">查阅周围物品</button><button id="inventory-toggle" type="button" aria-expanded="false" aria-controls="inventory-panel">背包 <span id="inventory-count">0</span></button>
      </nav>
      <section id="index-moves" class="action-group" hidden></section><div id="other-actions"></div>
      <p id="action-empty" class="no-actions" hidden></p>
    </div>
  </section>
  <section id="activity-drawer" class="panel" aria-label="活动" hidden>
    <div class="panel-header"><span>活动</span><button id="activity-drawer-close" type="button" aria-label="关闭活动">×</button></div>
    <div class="panel-body move-body"><p id="activity-drawer-hint" class="hint" role="status"></p><div id="activity-discover-list" class="action-group"></div></div>
  </section>
  <section id="move-panel" class="panel" aria-label="移动地点" hidden><div class="panel-header"><span>移动地点</span><button id="move-close" type="button" aria-label="关闭移动">×</button></div><div class="panel-body move-body"><p id="move-current"></p><p id="move-hint" class="hint" role="status"></p><div id="move-list" class="action-group"></div></div></section>
  <section id="message-panel" class="panel message-panel" aria-label="短信" hidden><div class="panel-header"><span id="message-title">短信</span><button id="message-close" type="button" aria-label="关闭短信">×</button></div><div class="panel-body message-body"><label for="message-to">发给</label><select id="message-to"></select><label for="message-text">内容</label><textarea id="message-text" rows="4" placeholder="写下要发出的内容……"></textarea><p id="message-hint" class="hint">对方不在身边也能收到；同一房间的人看不到内容。</p><button id="message-send" class="primary" type="button">发送</button></div></section>
  <section id="character-panel" class="panel" aria-label="角色详情" hidden>
    <div class="panel-header"><span id="character-detail-name"></span><button id="character-close" type="button" aria-label="关闭角色详情">×</button></div>
    <div id="character-detail-body" class="panel-body"></div>
  </section>
  <section id="nearby-panel" class="panel inventory-panel" aria-label="周围物品" hidden><div class="panel-header"><span>周围 · 场景物品</span><button id="nearby-close" type="button" aria-label="关闭周围物品">×</button></div><div id="nearby-list" class="panel-body"></div></section>
  <section id="inventory-panel" class="panel inventory-panel" aria-label="背包" hidden><div class="panel-header"><span>背包 · 随身物品</span><button id="inventory-close" type="button" aria-label="关闭背包">×</button></div><div id="inventory-list" class="panel-body"></div></section>
  <section id="status-panel" class="panel status-panel" aria-label="状态" hidden><div class="panel-header"><span>状态</span><button id="status-close" type="button" aria-label="关闭状态">×</button></div><div class="panel-body"><p id="status-read-note" class="status-read-note" role="status" hidden></p><div id="status-list"></div><div id="gameplay-panels"></div></div></section>
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
      <fieldset id="gameplay-settings" hidden><legend>玩法设置</legend><div id="gameplay-controls"></div><p id="gameplay-control-notice" class="hint" role="status"></p></fieldset>
      <section id="plugin-settings" hidden aria-label="插件设置"></section>
      <fieldset><legend>故事进度</legend><p class="hint">保存此刻的故事，在启动器中继续。</p><button id="stage-save" class="save-entry" type="button" disabled>保存进度 <span aria-hidden="true">↗</span></button><p id="save-unavailable" class="hint" hidden>当前运行时不支持保存进度。</p></fieldset>
      <p id="settings-notice" class="hint" role="status">阅读、声音和外观即时生效；玩法设置按各项说明保存和生效。</p>
    </div>
  </section>
  <dialog id="save-dialog" class="save-dialog" aria-labelledby="save-heading"><div>
    <div class="save-heading"><span class="eyebrow">故事进度</span><button id="save-close" type="button" aria-label="关闭保存进度">×</button></div><h2 id="save-heading">留住这一刻</h2><p class="hint">将当前位置保存为节点，之后可在启动器中继续。</p>
    <label for="save-title">节点名称</label><input id="save-title" maxlength="80" autocomplete="off" required>
    <p id="save-result" role="status" class="hint"></p><div class="save-buttons"><button id="save-cancel" type="button">取消</button><button id="save-confirm" class="primary" type="button">保存进度</button></div>
  </div></dialog>
</main>${ACTIVITY_STAGE_HTML}<script src="/frontend/sdk.js"></script><script src="/frontend/default.js"></script></body></html>`

export const DEFAULT_STYLE = STAGE_STYLE + ACTIVITY_STAGE_STYLE

/** Status bar rows grouped by holder, in the order the view lists them; a stale value reads "上次确认". */
function statusBarRows(view: {
  statusBar?: {
    label: string
    holderId: string | null
    holderName?: string
    self?: boolean
    value: unknown
    valueText?: string
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
    // A composite value is shortened for the panel only; the SDK view keeps the whole value. The host's readable
    // text, with ids named, is preferred when it sends one.
    const text = typeof entry.valueText === 'string' ? Array.from(entry.valueText) : undefined
    const json = typeof entry.value === 'object' && entry.value !== null ? Array.from(JSON.stringify(entry.value)) : []
    group.items.push({
      label: entry.label,
      value: text
        ? text.length > 120
          ? text.slice(0, 120).join('') + '…'
          : text.join('')
        : entry.value === true
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
 const battleReading=/*BATTLE_READING*/null;
 const playback=(${createReadingPlayback.toString()})();
 const statusPlayback=(${createStatusPlayback.toString()})();
 const classifyReply=(${actionReplyOutcome.toString()});
 const successFeedback=(${createSuccessFeedback.toString()})();
 const api=window.Perspectra,node=id=>document.getElementById(id);
 const normalizePreferences=(${stagePreferences.toString()});
 let preferences=normalizePreferences({}),stageAssets=[],stageConfig=null,canSave=false,hasSpeech=false,hasBgm=false,saving=false,preferencesVersion=0;
 let latest,posting=false,pending,attached=null,connected=false,historyKey='',messageKey='',waitOption=null,statusKey='',canRegenerate=false,requestVersion=0;
 let stageOpen=false,stageId=null,stageFocus=null,stageReadingKey=null;
 let activityReadOffers=[],activityReadKey='',activityReadActive=false;
 let requestIssue=null,checking=false,expiredTail=null;
 const expiredOffers=new Set();
 function hasActiveActivity(view){
   return !!(view?.activity?.active||view?.activities?.some(activity=>activity.active));
 }
 let audienceHovered=false,recipientLost=false,editorContext=null,wasResponse=false,resumeDraft=false;
 const activityStage=(${createActivityStage.toString()})(node('activity-stage'),/*ACTIVITY_STAGE_RENDERERS*/[],(optionId,args)=>send('perform',{optionId,...(Object.keys(args).length?{arguments:args}:{})}),()=>advance());
 function updateActivityStage(disabled,reading){
   const root=node('activity-stage'),main=document.querySelector('main');
   const through=battleReading?.boundary(reading?playback.current()?.seq:undefined);
   const ending=through!==undefined;
   const visible=ending||(stageOpen&&latest?.activityStage?.activityId===stageId&&latest?.status!=='paused');
   const stagePresentation=ending?{readingTitle:'阅读战斗叙事'}:visible&&activityStage.presentationFor(latest);
   if(!visible){
     activityStage.clear();
     stageReadingKey=null;
   }else if(reading){
     // The authorized payload can already contain the next round's numbers. Read before rendering it.
     const readingKey=ending?'ending:'+through:JSON.stringify([stageId,latest.activityStage.renderer]);
     if(stageReadingKey!==readingKey){
       activityStage.clear();
       const next=document.createElement('button');
       next.type='button';next.className='battle-reading';next.onclick=()=>advance();
       if(stagePresentation){
         root.classList.add('battle-stage','battle-reader');
         const layout=document.createElement('div'),heading=document.createElement('h2'),count=document.createElement('small'),line=document.createElement('p'),buttons=document.createElement('div'),skip=document.createElement('button');
         layout.className='battle-layout';heading.textContent=stagePresentation.readingTitle;count.className='battle-reading-count';line.className='battle-reading-line';buttons.className='battle-choices';
         line.setAttribute('aria-live','polite');next.textContent='继续阅读';next.classList.add('battle-primary');skip.type='button';skip.textContent='跳过未读';skip.onclick=()=>node('skip-read').click();
         buttons.append(next,skip);layout.append(count,heading,line,buttons);root.append(layout);
       }else root.append(next);
       stageReadingKey=readingKey;
       if(root.contains(document.activeElement)||document.activeElement===document.body)next.focus({preventScroll:true});
     }
     const unit=playback.current();
     if(stagePresentation){
       root.querySelector('.battle-reading-count').textContent=ending?'战斗记录':playback.remaining()+' 段未读';
       root.querySelector('.battle-reading-line').textContent=[unit?.speaker,unit?.text].filter(Boolean).join('\n')||'当前活动有未读内容';
     }else root.firstElementChild.textContent=(unit?.text||'当前活动有未读内容')+'\n继续阅读';
   }else{
     const restore=stageReadingKey!==null&&root.contains(document.activeElement);
     if(stageReadingKey!==null){activityStage.clear();stageReadingKey=null}
     try{
       const phase=pending&&!posting?'unconfirmed':['expired','rejected'].includes(requestIssue?.kind)?'error':latest.status==='busy'?(latest.responders?.length?'responding':'processing'):posting?'submitting':latest.status==='error'?'error':'ready';
       const resources=stagePresentation?(latest.statusBar||[]).filter(row=>row.self&&row.current&&stagePresentation.selfStatusKeys.includes(row.key)):[];
       const presentation=stagePresentation?{
         phase,resources:resources.map(row=>row.label+' '+(row.valueText??String(row.value))),
         retry:requestIssue?.kind==='unknown'&&!checking?checkResult:undefined,
       }:undefined;
       let notice=requestIssue?requestCopy(requestIssue).join('。'):node('notice').textContent||node('host-notice').textContent;
       if(battleReading?.battle(latest)){
         // The ordinary stage's last host notice has no request identity. Keep actionable issues and real errors.
         notice=requestIssue?requestCopy(requestIssue).join('。'):latest.status==='error'?'处理未完成，请查看已读记录和当前可用操作。':'';
         const cast=pending?.battleSkill,stage=latest.activityStage;
         if(posting&&cast?.id===stage.activityId&&cast.revision===stage.revision&&['submitting','processing'].includes(phase))notice='正在结算'+cast.name;
       }else if(stagePresentation){
         if(['submitting','responding','processing'].includes(phase))notice='';
         else notice=notice.replace(/^游戏操作已提交。\s*/,'');
       }
       const stageView=expiredOffers.size?{...latest,actions:latest.actions.filter(option=>!expiredOffers.has(option.id))}:latest;
       activityStage.update(stageView,disabled||(stagePresentation&&!!pending),false,'',notice,presentation);
       if(restore)root.querySelector('.battle-actions button:enabled')?.focus({preventScroll:true});
     }
     catch{stageOpen=false;parent.postMessage({type:'activity-stage-failed',activityId:stageId,revision:latest?.activityStage?.revision,renderer:latest?.activityStage?.renderer},'*');node('notice').textContent='活动视图无法显示，已返回通用卡片。'}
   }
   const show=visible&&(ending||stageOpen),was=!root.hidden;root.hidden=!show;main.inert=show;
   if(show&&!was){stageFocus=document.activeElement;(root.querySelector('.battle-reading')||root).focus({preventScroll:true})}
   if(!show&&was&&stageFocus?.isConnected)stageFocus.focus({preventScroll:true});
 }

 // Never name who is replying: in hidden turns (who is awake at night) the name alone gives the game away.
 const statusText=(view,reading)=>({ready:reading?'阅读中':'可以回应',busy:view.tailRound?.regenerating?'正在处理回合':view.responders?.length?'角色正在回应':'正在处理',paused:'已暂停',error:'处理未完成'})[view.status];
 // Public fields first, then what only the player knows (its private record, e.g. a dealt role); flat lists read as one line.
 const activityRows=(shown,own)=>{
   const hidden=['statusText','lastResult','objective','instructions','description','phaseLabel'];
   const labels={round:'回合',clues:'线索',funds:'资金',stock:'库存',score:'得分',attempts:'次数',health:'生命',phase:'阶段',inviter:'发出者',invitee:'受邀角色'};
   const text=value=>{
     if(Array.isArray(value))return value.some(item=>item!==null&&typeof item==='object')?'':value.map(text).filter(Boolean).join('、');
     if(typeof value==='boolean')return value?'是':'否';
     if(value===null||typeof value==='object')return '';
     if(typeof value==='string'&&/^character:[a-zA-Z0-9:_-]+$/.test(value))return readableCharacter(value)?.name||'';
     return String(value);
   };
   const rows=[];
   for(const [source,mine] of [[shown||{},false],[own||{},true]])for(const [name,value] of Object.entries(source)){
     const shownValue=text(value);if((!mine&&hidden.includes(name))||!shownValue)continue;
     rows.push({label:labels[name]||name,value:shownValue,own:mine});
   }
   return rows;
 };
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
   node('recipient-hint').hidden=!recipientLost&&!!displayedScene?.recipients?.length;
   node('recipient-hint').textContent=recipientLost?'原接收对象当前不可用，请重新选择。':'当前没有可接收发言的角色。';
   const name=select.value?select.selectedOptions[0].textContent:recipientLost?'请重选对象':'选择对象';
   const label=({scene_public:'公开',direct:'定向 · '+name,private:'私聊 · '+name,self:'仅自己'})[scope];
   node('audience-badge').textContent=label;
   node('audience-button').setAttribute('aria-label','设置发言受众：'+label);
   const preview=({scene_public:'发送效果：当前场景有权观察的角色将收到完整内容。',direct:'发送效果：只有 '+name+' 收到内容，其他角色不会获得这次发言的观察。',private:'发送效果：只有 '+name+' 收到内容，其他有权观察的角色仅知道发生了私密交流。',self:'发送效果：只有玩家自己保留这段表达，不会向其他角色传播。'})[scope];
   node('audience-preview').textContent=preview;node('audience-detail').textContent=direct&&!select.value?'请先选择接收对象。':preview;node('audience-button').title=preview;
   node('send').title=({scene_public:'发送 · 场景公开',direct:'发送 · 定向给 '+name,private:'发送 · 私密给 '+name,self:'发送 · 仅自己'})[scope];syncAudienceDisclosure();
 }
 function renderRecipients(scene){
   const select=node('speech-recipient'),previous=select.value;
   const people=scene?.recipients||[],signature=JSON.stringify(people);
   if(select.dataset.people!==signature){
     select.dataset.people=signature;select.replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='请选择接收对象';select.append(placeholder);
     for(const person of people){const option=document.createElement('option');option.value=person.id;option.textContent=person.name;select.append(option)}
     recipientLost=!!previous&&!people.some(person=>person.id===previous);
     if(people.some(person=>person.id===previous))select.value=previous;
   }
   audience();
 }
 function controls(){
   const policy=latest?.expression||{speech:'free',speechChoices:[],narration:true};
   const readingBlocked=playback.pending(),draftLocked=posting||!!pending||!connected;
   const draftable=policy.speech!=='none'||policy.narration||!!node('input').value||!!node('narration').value;
   const disabled=readingBlocked||posting||sceneArtLoading||!connected||(!['ready','error'].includes(latest?.status)&&!latest?.canInterrupt);
   const actionDisabled=!!actionGate();
   const hasLine=!!((policy.speech==='free'&&node('input').value.trim())||(policy.narration&&node('narration').value.trim()));
   node('send').disabled=!!pending||(attached?actionDisabled:disabled)||(!hasLine&&!attached)||(hasLine&&(speechScope()==='direct'||speechScope()==='private')&&!node('speech-recipient').value);
   node('attached-order').disabled=actionDisabled||!hasLine;
   node('wait').hidden=!waitOption;node('wait').disabled=actionDisabled||hasLine||!!attached;
   for(const radio of document.querySelectorAll('input[name="speech-scope"]'))radio.disabled=draftLocked;
   node('audience-button').disabled=draftLocked;if(draftLocked)audienceMenu(false);
   node('speech-recipient').disabled=draftLocked||!displayedScene?.recipients?.length;
   node('input').readOnly=draftLocked||policy.speech!=='free';node('input').hidden=policy.speech!=='free'&&!node('input').value;
   node('narration').readOnly=draftLocked||!policy.narration;node('narration-panel').hidden=!policy.narration&&!node('narration').value;
   for(const button of node('expression-choices').querySelectorAll('button'))button.disabled=disabled||(['direct','private'].includes(speechScope())&&!node('speech-recipient').value);
   const canReply=!disabled&&canReplyNow();
   const mode=activityOpen?'activity':composerExpanded&&draftable?'response':'reading';
   document.querySelector('main').dataset.mode=mode;
   document.querySelector('main').dataset.hasActivity=String(!!(latest?.activity||latest?.activities?.length));
   if(latest){
     const roleResponding=latest.status==='busy'&&latest.responders?.length>0;
     node('status').textContent=posting&&roleResponding?'角色正在回应':posting?'正在提交……':pending?'结果未确认':!connected?'连接断开':statusText(latest,readingBlocked);
     node('status').hidden=connected&&!posting&&!pending&&latest.status==='ready';
     node('status').dataset.state=posting?'busy':pending?'error':!connected?'disconnected':latest.status;
   }
   node('stage-save').disabled=!canSave||saving||posting||!connected||latest?.status!=='ready'||!!latest?.tailRound?.regenerating;
   node('composer').hidden=mode!=='response';node('dialogue-wrap').hidden=mode==='response';
   // The notice lives inside whichever box is showing: below the dialogue while reading, at the foot of the composer while replying.
   const feedback=node('feedback');
   if(mode==='response'){
     if(feedback.parentElement!==node('composer'))node('composer').append(feedback);
   }else if(feedback.parentElement!==node('dialogue-wrap'))node('dialogue-wrap').insertBefore(feedback,node('dialogue-wrap').querySelector('.dialogue-footer'));
   node('reply-bar').hidden=mode!=='reading'||readingBlocked||!canReply;
   if(mode==='response'&&!wasResponse)editorContext=playback.lastRead();wasResponse=mode==='response';
   const unit=mode==='response'?editorContext:playback.current();node('reply-speaker').textContent=unit?.speaker||'当前情景';node('reply-summary').textContent=unit?.text||'故事从你的回应开始。';
   node('composer-unread').hidden=mode!=='response'||!readingBlocked;node('composer-unread-text').textContent=playback.remaining()+' 段未读 · 草稿和接收设置已保留，读完或跳过后再发送。';
   for(const id of ['auto-read','skip-read','reading-count'])node(id).hidden=!readingBlocked;
   if(mode!=='response'&&!node('audience-menu').hidden)audienceMenu(false);
   renderInventory();node('nearby-toggle').disabled=!connected;
   if(characterMenuAnchor&&!readableCharacter(characterMenuAnchor.dataset.characterId))closeCharacterMenu();
   renderCharacterDetail();
   renderMoveOptions();
   node('move-toggle').disabled=node('scene').disabled=!connected;
   node('move-current').textContent=displayedScene?.locationName?'当前位置：'+displayedScene.locationName:'当前位置尚未确认';
   node('move-hint').textContent=!moveReadOptions?'暂时无法核实地点。读完或跳过后再查看。':readingBlocked?'显示已读地点。读完或跳过后才能移动。':posting?'正在提交操作…':sceneArtLoading?'正在切换场景…':pending?'请先确认上一操作的结果。':'';
   for(const id of ['move-list','inventory-list','nearby-list','character-detail-body'])syncOptionControls(node(id));
   node('composer-message').disabled=actionDisabled;node('message-send').disabled=actionDisabled;
   updateGameplayControls(actionDisabled);
   if(actionDisabled&&!node('message-panel').hidden){
     if(!returnFromIndex('message-panel'))drawer(null);
   }
   if(latest){
     renderActivity(latest);
     renderActivityOffers(readingBlocked);
   }
   scheduleAuto();
   renderActionIndex();updateActionBar(mode,actionDisabled);renderReadStatus();
   const pickups=readablePickups();
   const stagePickup=pickups.get(playback.current()?.seq);
   const shortcut=node('pickup-item');
   shortcut.hidden=!stagePickup;
   shortcut.onclick=stagePickup?()=>openPickup(stagePickup,shortcut,false):null;
   const unreadSeq=readingBlocked?playback.current()?.seq:undefined;
   for(const line of history.querySelectorAll('[data-history-seq]')){
     const seq=Number(line.dataset.historySeq);
     line.hidden=unreadSeq!==undefined&&seq>=unreadSeq;
     const item=pickups.get(seq),previous=line.querySelector('.pickup-history');
     if(previous&&previous.dataset.itemId!==item?.id)previous.remove();
     if(item&&!line.querySelector('.pickup-history')){
       const button=document.createElement('button');button.type='button';button.className='pickup-history';
       button.dataset.itemId=item.id;button.textContent='查看物品';button.onclick=()=>openPickup(item,button,true);
       line.querySelector('.message').append(button);
     }
   }
   for(const control of node('activity-card').querySelectorAll('#activity-options button,#activity-options select,#activity-options input,#activity-options textarea,#activity-manage button'))control.disabled=actionDisabled;
   renderRequestFeedback();renderHostNotice();
   updateActivityStage(actionDisabled,readingBlocked);syncDialogueControl();
   parent.postMessage({type:'frontend-reading',pending:readingBlocked,historyOpen:!node('history-panel').hidden,mode,historySignature:JSON.stringify((latest?.history||[]).map(line=>[line.seq,line.speaker,line.text,line.segments]))},'*');
   const tail=latest?.tailRound,count=tail?.candidateIds?.length||1,index=tail?.candidateIndex||1;
   roundTools.hidden=!tail?.id||!canRegenerate;
   node('candidate-count').textContent=index+'/'+count;
   for(const id of ['candidate-prev','candidate-count','candidate-next'])node(id).hidden=count<2;
   node('candidate-prev').disabled=posting||!!pending||expiredTail===tail?.id||!connected||!tail?.canRegenerate||index<=1;
   node('candidate-next').disabled=posting||!!pending||expiredTail===tail?.id||!connected||!tail?.canRegenerate||index>=count;
   node('regenerate-round').disabled=posting||!!pending||expiredTail===tail?.id||!connected||!tail?.canRegenerate;
   node('regenerate-round').hidden=!!tail?.regenerating;
   node('cancel-round').hidden=!tail?.regenerating;
   scheduleOpening();
 }
 // Status values and authored read-only panels use the same read boundary. The processing
 // indicator at the bottom still follows runtime state immediately.
 function renderReadStatus(){
   const settled=connected&&canReadScene()&&!sceneArtLoading&&!posting&&['ready','error'].includes(latest?.status);
   const snapshot=statusPlayback.update(latest,settled);
   const mark=node('status-cut'),note=node('status-read-note');
   const cut=!snapshot?'等待确认':settled?'':'已读快照';
   const unread=playback.pending();
   const copy=!snapshot?(unread?'读完或跳过未读后，这里会显示能确认的状态。':'目前还没有可确认的已读状态。'):
     unread?'还有未读内容，当前只显示截至已读处的状态。':
       settled?'':'当前显示上一个已读状态。';
   if(mark.textContent!==cut)mark.textContent=cut;
   mark.hidden=!cut;
   if(note.textContent!==copy)note.textContent=copy;
   note.hidden=!copy;
   const known=snapshot?.statusBar||[],panels=snapshot?.panels||[];
   renderGameplayPanels({panels});
   const key=JSON.stringify([known,panels.length,!!snapshot]);
   if(key===statusKey)return;
   statusKey=key;
   const presentable=known.filter(row=>publicText(row.label)&&
     (row.holderId===null||row.self||publicText(row.holderName))&&
     (typeof row.valueText==='string'?publicText(row.valueText):typeof row.value==='string'?publicText(row.value):row.value===null||typeof row.value!=='object'));
   const bar=node('status-bar');bar.replaceChildren();
   const pinned=presentable.filter(row=>row.pinned&&row.current&&row.value!==null&&typeof row.value!=='object');
   const preferred=[...pinned.filter(row=>row.self),...pinned.filter(row=>row.holderId===null)];
   for(const row of preferred.slice(0,2)){
     const reading=statusRows({statusBar:[row]})[0].items[0];
     const item=document.createElement('span');item.className='status-preview';
     const label=document.createElement('span'),value=document.createElement('strong');
     label.textContent=reading.label;value.textContent=reading.value;
     item.append(label,value);bar.append(item);
   }
   bar.hidden=!bar.children.length;
   const groups=statusRows({statusBar:presentable}),list=node('status-list');
   list.replaceChildren();
   if(snapshot&&!groups.length&&!panels.length){
     const empty=document.createElement('p');empty.className='empty-status';empty.textContent='目前没有可显示的状态。';list.append(empty);
   }
   for(const group of groups){
     const section=document.createElement('section');section.className='status-section';
     const heading=document.createElement('h3');heading.textContent=group.holder;
     const table=document.createElement('dl');
     for(const item of group.items){
       const term=document.createElement('dt'),value=document.createElement('dd');
       term.textContent=item.label;value.textContent=item.value+(item.note?'（'+item.note+'）':'');
       table.append(term,value);
     }
     section.append(heading,table);list.append(section);
   }
 }
 function bottom(){history.scrollTop=history.scrollHeight;node('latest').hidden=true}
 history.onscroll=()=>{node('latest').hidden=history.scrollHeight-history.scrollTop-history.clientHeight<70};
 node('latest').onclick=bottom;
 ${GAMEPLAY_WIDGETS}
 function committedInput(view,request){return !!request&&view.inputProgress?.committed===true&&view.inputProgress.actionId===request.actionId}
 function render(view){
   renderPluginControls(view);
   waitOption=view.actions.find(option=>option.id==='wait');
   view={...view,history:view.history.filter(line=>!line.pause),actions:view.actions.filter(option=>option!==waitOption)};
   const committed=committedInput(view,pending)?pending:null;
   const candidate=tail=>tail?.candidateIds?.[(tail.candidateIndex||1)-1]||null;
   const branchChanged=!!(latest?.tailRound?.id&&latest.tailRound.id===view.tailRound?.id&&candidate(latest.tailRound)!==candidate(view.tailRound));
   if(branchChanged){
     playback.invalidateScene();statusPlayback.invalidate();successFeedback.clear();indexSnapshot=null;
   }
   battleReading?.update(latest,view,stageOpen?stageId:null,branchChanged);
   renderItemChanges(latest,view);
   latest=view;playback.update(view.history);validateItemReadPrefix(view);
   for(const id of expiredOffers)if(!view.actions.some(option=>option.id===id)&&waitOption?.id!==id)expiredOffers.delete(id);
   if(expiredTail!==view.tailRound?.id)expiredTail=null;
   if(committed?.battleSkill)committed.battleCommitted=true;
   else if(committed)finishRequest(committed);
   renderStage();
   const expression=view.expression||{speech:'free',speechChoices:[],narration:true};
   if(JSON.stringify(expression)!==expressionKey){expressionKey=JSON.stringify(expression);node('expression-choices').replaceChildren();if(expression.speech==='choices')for(const text of expression.speechChoices){const button=document.createElement('button');button.type='button';button.textContent=text;button.onclick=()=>send('speak',{text,scope:speechScope(),addresseeIds:['direct','private'].includes(speechScope())?[node('speech-recipient').value]:[]});node('expression-choices').append(button)}}
   const reading=preferences;
   node('input').maxLength=node('narration').maxLength=view.settings?.inputCharacters||2000;
   node('title').textContent=view.game.title;node('player').textContent='你 · '+view.player.name;
   node('status').textContent=statusText(view,playback.pending());
   node('status').dataset.state=view.status;
   const nextHistory=JSON.stringify(view.history);
   if(nextHistory!==historyKey){
     const oldTop=history.scrollTop;
     const follow=!historyKey||(reading.autoFollow&&history.scrollHeight-oldTop-history.clientHeight<70);
     historyKey=nextHistory;history.replaceChildren();
     if(!view.history.length){const empty=document.createElement('div');empty.className='empty-history';const title=document.createElement('strong');title.textContent='故事从你的第一句话开始';empty.append(title,document.createTextNode('看看眼前的世界，向角色打个招呼吧。'));history.append(empty)}
     for(const line of view.history){
       const article=document.createElement('article');article.className='line'+(line.player?' player':'');article.dataset.historySeq=String(line.seq);
       const avatar=document.createElement('span');avatar.className='avatar';avatar.setAttribute('aria-hidden','true');avatar.textContent=Array.from(line.speaker)[0]||'·';
       const message=document.createElement('div');message.className='message';
       const speaker=document.createElement('strong');speaker.className='speaker';speaker.textContent=line.speaker;
       const text=document.createElement('div');text.className='text';if(line.segments){for(const segment of line.segments){const span=document.createElement('span');span.className=segment.type==='speech'?'say':'act';span.textContent=segment.text;text.append(span,document.createElement('br'));}}else fillText(text,line.text);
       message.append(speaker,text);article.append(avatar,message);history.append(article);
     }

     if(follow)bottom();else{history.scrollTop=oldTop;node('latest').hidden=false}
   }
   const messages=view.actions.filter(isMessage);
   const nextMessages=JSON.stringify(messages);
   if(nextMessages!==messageKey){messageKey=nextMessages;renderMessages(messages)}
   if(!pending&&attached&&!liveOption(attached.option.id)){detach();node('notice').textContent='附带的行动已经不可用，请重新选择。'}
   renderInventory();
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
   if(!option||actionGate(option.id))return;if(!text){node('notice').textContent='请先写下要发出的内容。';node('message-text').focus();return}
   send('perform',{optionId:option.id,arguments:{text}});
 }
 // Index rows are built from a complete read batch. The live offer can veto submission,
 // but cannot add new labels, targets or argument choices ahead of reading.
 let indexSnapshot=null,indexKey='',indexReturnFocus=null,indexPointerOrigin=null,indexChild=null;
 const indexLabels={move:'前往地点',item:'使用物品',character:'交流与互动',activity:'参加活动',other:'其他'};
 const indexFieldLabels={target:'目标',skill:'技能',recipientId:'对象',text:'内容',amount:'数量',item:'物品',itemId:'物品',destination:'地点'};
 const opaqueText=/\b(?:character|entity|location|map|scene|status|activity|host|experiment|binding):[\w.:-]+/iu;
 function publicText(value){return typeof value==='string'&&!opaqueText.test(value)?value.trim():''}
 function liveOption(id){return expiredOffers.has(id)?undefined:waitOption?.id===id?waitOption:latest?.actions.find(option=>option.id===id)}
 function actionGate(id){
   if(!connected)return '连接尚未就绪。';
   if(playback.pending())return '读完或跳过未读后可执行。';
   if(posting)return '正在提交当前操作。';
   if(pending)return '请先确认上一操作的结果。';
   if(sceneArtLoading)return '场景正在切换。';
   if(latest?.status==='paused')return '当前已暂停。';
   if(!['ready','error'].includes(latest?.status))return '请等待当前处理完成。';
   if(id&&!liveOption(id))return '此行动已不可用。';
   if(id==='wait'&&(composerLine()||attached))return '请先处理当前草稿或附带行动。';
   return '';
 }
 function syncOptionControls(container){
   const blocked=actionGate();
   for(const button of container.querySelectorAll('button[data-option-id]')){
     const reason=actionGate(button.dataset.optionId);
     button.disabled=!!reason||button.dataset.unavailable==='true';
     const row=button.closest('.index-option');
     if(row){
       const hint=row.querySelector('.index-option-hint');
       if(hint){const text=reason===blocked?'':reason;if(hint.textContent!==text)hint.textContent=text;hint.hidden=!text}
     }
     for(const form of [button.closest('.action-form'),button.previousElementSibling?.matches('[data-option-inputs]')?button.previousElementSibling:null])
         for(const input of form?.querySelectorAll('input,select,textarea')||[])input.disabled=!!reason;
   }
 }
 function speechAvailable(policy){return !policy||policy.speech==='free'||(policy.speech==='choices'&&!!policy.speechChoices?.length)}
 function speechGate(id){
   if(!speechAvailable(latest?.expression)||!readableCharacter(id))return '当前无法向这位角色发言。';
   if(latest?.status==='busy'&&latest.canInterrupt&&!playback.pending()&&!posting&&!pending&&!sceneArtLoading)return '';
   return actionGate();
 }
 function speechEntries(name){return [['direct','对 '+name+' 说'],['private','悄悄对 '+name+' 说']]}
 function speakTo(id,scope){
   if(speechGate(id))return;
   drawer(null);
   const radio=document.querySelector('input[name="speech-scope"][value="'+scope+'"]');
   radio.checked=true;node('speech-recipient').value=id;audience();composerExpanded=true;activityOpen=false;
   controls();(node('input').hidden?node('expression-choices').querySelector('button'):node('input'))?.focus();
 }
 function indexCategory(option){
   if(option.kind==='move')return 'move';
   if(option.kind==='activity'||option.kind==='manage'||option.target?.kind==='activity')return 'activity';
   if(option.target?.kind==='item')return 'item';
   if(isMessage(option)||option.target?.kind==='character'||option.characterArguments?.length)return 'character';
   return 'other';
 }
 function describeIndexInputs(option,snapshot){
   const fields=Object.create(null),recipients=snapshot.people;
   for(const [key,spec] of Object.entries(option.argumentSchema?.properties||{})){
     const named=option.characterArguments?.includes(key);
     fields[key]=publicText(spec.title)||publicText(spec.description)||(Object.hasOwn(indexFieldLabels,key)?indexFieldLabels[key]:'')||'参数 '+(Object.keys(fields).length+1);
     const presentable=value=>value===null||typeof value==='number'||typeof value==='boolean'||!!publicText(value);
     if(named){
       if(option.argumentSchema.required?.includes(key)&&!recipients.length)return {reason:'目前没有可选择的角色。'};
     }else if((Array.isArray(spec.enum)?!spec.enum.every(presentable):!['string','integer','number','boolean'].includes(spec.type))||
       (spec.default!==undefined&&!presentable(spec.default)))return {reason:'此行动缺少能在索引中显示的选项。'};
   }
   if(option.participantSelection&&option.participantSelection.candidates.length<option.participantSelection.min)
     return {reason:'当前可选参与者不足。'};
   return {fields,recipients};
 }
 function indexButton(label,run){
   const button=document.createElement('button');
   button.type='button';button.textContent=label;button.onclick=run;return button;
 }
 function addIndexRow(group,label,detail,search,render,fold=false){
   const row=document.createElement(fold?'details':'div');row.className='index-option';row.dataset.search=[label,detail,...search].filter(Boolean).join(' ').toLocaleLowerCase();
   if(fold){const summary=document.createElement('summary');summary.textContent=label;row.append(summary)}
   const body=document.createElement('div');body.className='index-option-body';
   if(detail){const caption=document.createElement('small');caption.className='index-option-detail';caption.textContent=detail;body.append(caption)}
   render(body);
   const reason=document.createElement('p');reason.className='hint index-option-hint';reason.hidden=true;body.append(reason);
   row.append(body);group.append(row);return row;
 }
 function populateActionIndex(snapshot){
   const container=node('other-actions'),move=node('index-moves'),groups=new Map();
   move.replaceChildren();container.replaceChildren();
   for(const [category,title] of Object.entries(indexLabels)){
     const section=category==='move'?move:document.createElement('section');
     section.className='action-group';section.dataset.actionCategory=category;
     const heading=document.createElement('h3');heading.textContent=title;section.append(heading);
     groups.set(category,section);if(category!=='move')container.append(section);
   }
   if(!snapshot)return;
   for(const source of snapshot.options){
     const category=indexCategory(source),target=source.target;
     const item=snapshot.items.find(item=>item.id===target?.id);
     const targetName=publicText(target?.name);
     const title=publicText(source.label)||(targetName?'与 '+targetName+' 互动':'已授权行动');
     const detail=[targetName&&!title.includes(targetName)?targetName:'',
       item?.where==='held'?'背包':item?.where==='here'?'周围':item?.where==='with'?publicText(item.holderName):'',
       publicText(source.group)].filter(Boolean).join(' · ');
     const participants=source.participantSelection;
     const candidates=participants?.candidates.filter(person=>publicText(person.name));
     const option={...source,label:title,...(participants?{participantSelection:{...participants,candidates}}:{})};
     const input=describeIndexInputs(option,snapshot),message=isMessage(option);
     const row=addIndexRow(groups.get(category),title,detail,[indexLabels[category],...(candidates||[]).map(person=>person.name)],
       body=>{
         if(message){const button=indexButton(title,()=>{
           if(actionGate(option.id))return;
           node('message-to').value=option.id;browseFromIndex('message-panel',node('message-text'));
         });button.dataset.optionId=option.id;body.append(button)}
         else if(input.reason){
           const button=indexButton(title,null),note=document.createElement('p');
           button.disabled=true;note.className='hint';note.textContent=input.reason;body.append(button,note);
         }else appendAction(body,option,input);
       },!input.reason&&!message&&(!!participants||Object.keys(input.fields).length>0));
     row.dataset.indexKey=option.id;
   }
   const group=groups.get('character');
   for(const {id,name} of snapshot.people){
     const detail=addIndexRow(group,'查看 '+name,'',[name,'角色详情'],body=>{
       const button=indexButton('查看 '+name,()=>{
         if(!readableCharacter(id))return;
         indexChild={panel:'character-panel',anchor:button};
         openCharacterDetail(id,null);
       });button.dataset.indexCharacter=id;body.append(button);
     });detail.dataset.indexKey='view:'+id;
     if(!snapshot.canSpeak)continue;
     for(const [scope,label] of speechEntries(name)){
       const row=addIndexRow(group,label,'',[name,'交流与互动'],body=>{
         const button=indexButton(label,()=>speakTo(id,scope));button.dataset.indexSpeech=id;body.append(button);
       });row.dataset.indexKey=scope+':'+id;
     }
   }
 }
 function renderActionIndex(){
   if(canReadScene()&&!sceneArtLoading&&['ready','error'].includes(latest.status)){
     indexSnapshot={options:[...latest.actions,...(waitOption?[waitOption]:[])],items:latest.items||[],
       people:(displayedScene?.recipients||[]).filter(person=>publicText(person.name)),canSpeak:speechAvailable(latest.expression)};
   }
   const separatedPeople=indexSnapshot?.people.filter(person=>readableCharacter(person.id)).map(person=>person.id);
   // During unread, keep the text of the last observed character rows; the live view can only disable them.
   const key=JSON.stringify(indexSnapshot);
   if(key!==indexKey){
     indexKey=key;
     const box=node('actions');
     const active=document.activeElement,focused=active?.closest?.('[data-index-key]');
     const forms=new Map(Array.from(box.querySelectorAll('[data-index-key]'),row=>[row.dataset.indexKey,{
       open:row.open,values:[...row.querySelectorAll('input,select,textarea')].map(input=>({value:input.value,checked:input.checked,type:input.type})),
     }]));
     populateActionIndex(indexSnapshot);filterActionIndex();
     for(const row of box.querySelectorAll('[data-index-key]')){
       const draft=forms.get(row.dataset.indexKey);
       if(!draft)continue;
       if(draft.open&&row.tagName==='DETAILS')row.open=true;
       for(const [i,input] of [...row.querySelectorAll('input,select,textarea')].entries()){
         const value=input.type==='checkbox'?draft.values.find(row=>row.type==='checkbox'&&row.value===input.value):draft.values[i];
         if(!value||value.type!==input.type)continue;
         if(input.type==='checkbox'){if(value.value===input.value)input.checked=value.checked}
         else if(input.tagName!=='SELECT'||Array.from(input.options).some(option=>option.value===value.value))input.value=value.value;
       }
       if(row.tagName==='DETAILS'&&row.querySelector('[data-option-inputs]')){
         row.querySelector('[data-option-inputs]').refreshSelection();
       }
       if(focused?.dataset.indexKey===row.dataset.indexKey&&isVisible(row)){
         const selector=active.tagName.toLowerCase(),oldControls=[...focused.querySelectorAll(selector)];
         const target=[...row.querySelectorAll(selector)][oldControls.indexOf(active)];
         if(isVisible(target))target.focus({preventScroll:true});
       }
     }
     if(focused&&!document.activeElement.closest('.index-option')&&!node('action-panel').hidden)node('action-search').focus({preventScroll:true});
   }
   const gate=actionGate(),note=node('action-gate');
   const text=gate||(indexSnapshot?'':'读完已有内容后，可查看已确认的操作。');
   if(note.textContent!==text)note.textContent=text;
   note.hidden=!text;
   syncOptionControls(node('actions'));
   for(const button of node('actions').querySelectorAll('[data-index-speech]'))button.disabled=!!speechGate(button.dataset.indexSpeech);
   for(const button of node('actions').querySelectorAll('[data-index-character]'))button.disabled=!separatedPeople?.includes(button.dataset.indexCharacter);
 }
 function filterActionIndex(){
   const selected=node('action-category').value;
   const words=node('action-search').value.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
   let shown=0;
   for(const group of node('actions').querySelectorAll('[data-action-category]')){
     let any=false;
     for(const row of group.querySelectorAll('.index-option')){
       const matches=(!selected||selected===group.dataset.actionCategory)&&words.every(word=>row.dataset.search.includes(word));
       row.hidden=!matches;if(matches){any=true;shown++}
     }
     group.hidden=!any;
   }
   const empty=node('action-empty');
   empty.hidden=!!shown;
   empty.textContent=words.length||selected?'没有符合条件的行动。':'暂无可显示的行动。';
 }
 function isVisible(element){return !!element?.getClientRects().length&&!element.disabled}
 function toggleActionIndex(trigger,origin){
   if(!node('action-panel').hidden){closeActionIndex();return}
   indexChild=null;indexReturnFocus=[node('input'),node('narration')].includes(origin)?origin:trigger===node('composer-actions')?node('input'):trigger;
   if(trigger===node('composer-actions'))node('composer').querySelector('.composer-more').open=false;
   drawer('action-panel');controls();node('actions-close').focus({preventScroll:true});
 }
 function closeActionIndex(){
   drawer(null);controls();
   (isVisible(indexReturnFocus)?indexReturnFocus:node('actions-toggle')).focus({preventScroll:true});
   indexReturnFocus=null;
 }
 function browseFromIndex(panel,focus){
   indexChild={panel,anchor:document.activeElement};
   drawer(panel);controls();focus.focus({preventScroll:true});
 }
 function returnFromIndex(panel){
   if(indexChild?.panel!==panel)return false;
   const anchor=indexChild.anchor;indexChild=null;
   drawer('action-panel');controls();
   (isVisible(anchor)?anchor:node('action-search')).focus({preventScroll:true});
   return true;
 }
 function updateActionBar(mode,disabled){
   const visible=mode==='reading'&&!disabled&&!stageOpen;
   const contextual=[
     ['activity-discover',activityReadActive||activityReadOffers.length>0],
     ['move-toggle',!!moveReadOptions?.length],
     ['nearby-toggle',!!itemReadView?.items.some(item=>item.where==='here')],
   ];
   for(const [id,available] of contextual){
     const button=node(id),hide=!visible||!available;
     if(hide&&!button.hidden&&document.activeElement===button)node('actions-toggle').focus({preventScroll:true});
     button.hidden=hide;
   }
 }
 // Item controls use the same current options and submission path as the action drawer.
 function appendAction(group,option,display){
   const button=document.createElement('button');button.type='button';if(display)button.setAttribute('aria-label',option.label);
   button.dataset.optionId=option.id;
   const label=document.createElement('span');label.textContent=option.label;const arrow=document.createElement('span');arrow.textContent='↗';arrow.setAttribute('aria-hidden','true');button.append(label,arrow);
   if(option.participantSelection){
     const selection=option.participantSelection,picker=participantPicker(selection,option.label,valid=>{button.dataset.unavailable=String(!valid);controls()});
     picker.element.dataset.optionInputs=option.id;
     picker.element.refreshSelection=()=>{picker.update();button.dataset.unavailable=String(!picker.valid())};
     button.onclick=()=>{const npcIds=picker.read();
       if(npcIds.length<selection.min||npcIds.length>selection.max){node('notice').textContent='请选择 '+selection.min+' 至 '+selection.max+' 名参与角色';return}
       send('perform',{optionId:option.id,npcIds})};group.append(picker.element);
     button.dataset.unavailable=String(!picker.valid());
   }else if(option.argumentSchema){const form=argumentForm(option,display);group.append(form);form.append(button);
     button.onclick=()=>{let args;try{args=form.read()}catch(error){node('notice').textContent=error.message;return}act(option,args)};
   }else button.onclick=()=>option.id==='wait'?send('perform',{optionId:option.id}):act(option);
   if(!button.parentNode)group.append(button);
 }
 let moveReadOptions=null,moveKey='';
 let displayedScene=null,sceneArtLoading=false,preparingArt='',readyBackground=null,moveTrigger=null;
 function renderMoveOptions(){
   const key=JSON.stringify(moveReadOptions);
   if(key===moveKey)return;
   moveKey=key;
   const list=node('move-list');list.replaceChildren();
   if(moveReadOptions?.length){
     for(const option of moveReadOptions)appendAction(list,option);
   }else if(moveReadOptions){
     const empty=document.createElement('p');empty.className='hint';empty.textContent='暂无可执行的移动。';list.append(empty);
   }
 }
 let inventoryKey='',itemReadView=null,itemReadHistory=[];
 function canReadScene(){
   return !!latest&&!playback.pending()&&(!latest.scene||latest.scene.locationId===displayedScene?.locationId);
 }
 function rememberReadItems(){
   if(!canReadScene())return;
   itemReadView={items:structuredClone(latest.items||[]),actions:structuredClone(latest.actions.filter(option=>option.target?.kind==='item'))};
   itemReadHistory=latest.history.map(line=>JSON.stringify(line));inventoryKey='';
 }
 function validateItemReadPrefix(view){
   if(itemReadHistory.some((line,index)=>line!==JSON.stringify(view.history[index]))){
     itemReadView=null;itemReadHistory=[];moveReadOptions=null;indexSnapshot=null;activityReadOffers=[];activityReadActive=false;inventoryKey='';
   }
 }
 function renderInventory(){
   const items=itemReadView?.items||[],options=itemReadView?.actions||[];
   const key=JSON.stringify([items,options,!!itemReadView,playback.pending()]);if(key===inventoryKey)return;inventoryKey=key;
   node('inventory-count').textContent=itemReadView?String(items.filter(item=>item.where==='held').length):'—';
   const nearbyList=node('nearby-list');
   const focusedCard=nearbyList.contains(document.activeElement)?document.activeElement.closest('details[data-item-id]'):null;
   for(const [id,where,title]of [['inventory-list','held','随身物品'],['nearby-list','here','场景物品']]){
     const list=node(id),open=new Set(Array.from(list.querySelectorAll('details[open]'),entry=>entry.dataset.itemId));list.replaceChildren();
     const note=document.createElement('p');note.className='hint item-snapshot-note';note.textContent=!itemReadView?'暂时无法核实你已读到的物品信息。读完或跳过后可查看。':playback.pending()?'按你已读到的内容展示；有未读内容，读完或跳过后再执行。':'按已读进度展示；操作仍由游戏规则复核。';list.append(note);
     if(!itemReadView)continue;
     const entries=items.filter(item=>item.where===where),section=document.createElement('section');section.className='inventory-section';const heading=document.createElement('h3');heading.textContent=title;section.append(heading);
     if(!entries.length){const empty=document.createElement('p');empty.className='hint';empty.textContent=where==='held'?'你还没有携带物品。':'已读内容中没有场景物品。';section.append(empty)}
     for(const item of entries){
       section.append(itemCard(item,options,open.has(item.id),where==='held'?'随身携带':'场景承载'));
     }
     list.append(section);
   }
   // These rows are replaced when the read boundary changes. Keep the same authorized item
   // in focus if it survived. A removed option must never receive focus as a new action.
   if(focusedCard)focusNearbyItem(focusedCard.dataset.itemId);
 }
 // The host binds a held item to an exact custody row. Consult both the read cut and current grant.
 function readablePickups(){
   const bySeq=new Map();
   if(!connected||pending||posting||(requestIssue&&requestIssue.kind!=='confirmed')||playback.pending()||!itemReadView)return bySeq;
   const held=new Map((latest?.items||[]).filter(item=>item.where==='held').map(item=>[item.id,item.pickupResultSeq]));
   for(const item of itemReadView.items){
     if(item.where==='held'&&Number.isSafeInteger(item.pickupResultSeq)&&held.get(item.id)===item.pickupResultSeq)
       bySeq.set(item.pickupResultSeq,item);
   }
   return bySeq;
 }
 let pickupOrigin=null;
 function openPickup(item,anchor,inHistory){
   if(!anchor.isConnected||!isVisible(anchor)||readablePickups().get(item.pickupResultSeq)?.id!==item.id)return;
   const card=Array.from(node('inventory-list').querySelectorAll('details[data-item-id]')).find(row=>row.dataset.itemId===item.id);
   if(!card)return;
   drawer('inventory-panel');pickupOrigin={anchor,inHistory};controls();
   card.open=true;const heading=card.querySelector('summary');heading.focus();heading.scrollIntoView({block:'nearest'});
 }
 function closePickup(){
   const origin=pickupOrigin;drawer(origin.inHistory?'history-panel':null);controls();
   const fallback=origin.inHistory?node('history-close'):node('dialogue-wrap').hidden?node('input'):node('dialogue');
   (origin.anchor.isConnected&&isVisible(origin.anchor)?origin.anchor:fallback).focus({preventScroll:true});
 }
 function focusNearbyItem(previousId){
   const list=node('nearby-list');
   const summaries=Array.from(list.querySelectorAll('details[data-item-id] > summary'));
   const target=summaries.find(summary=>summary.parentElement.dataset.itemId===previousId)||summaries[0]||node('nearby-close');
   target.focus({preventScroll:true});
   if(target!==node('nearby-close')){
     const row=target.getBoundingClientRect(),viewport=list.getBoundingClientRect();
     if(row.top<viewport.top||row.bottom>viewport.bottom)list.scrollTop+=row.top-viewport.top;
   }
 }
 function itemCard(item,options,open,placeText){
   const card=document.createElement('details');card.className='inventory-item';card.dataset.itemId=item.id;card.open=open;
   const summary=document.createElement('summary'),name=document.createElement('strong');
   name.textContent=item.name;summary.append(name);
   if(placeText){const place=document.createElement('small');place.textContent=placeText;summary.append(place)}
   const body=document.createElement('div');body.className='inventory-item-body';
   const description=document.createElement('p');description.className='inventory-description';description.textContent='类型：'+item.kind;body.append(description);
   const actions=document.createElement('div');actions.className='action-group inventory-actions';
   const available=options.filter(option=>option.target.id===item.id);
   for(const option of available)appendAction(actions,option);
   if(!available.length){
     const empty=document.createElement('p');empty.className='hint';empty.textContent='当前没有已授权操作。';actions.append(empty);
   }
   body.append(actions);card.append(summary,body);
   return card;
 }

 let characterMenuAnchor=null,characterDetail=null,characterDetailKey='';
 function readableCharacter(id){
   if(!connected||!displayedScene||latest?.scene?.locationId!==displayedScene.locationId)return;
   if(!latest.scene?.recipients?.some(person=>person.id===id))return;
   return displayedScene.recipients?.find(person=>person.id===id);
 }
 function openCharacterDetail(id,anchor){
   if(!readableCharacter(id))return;
   characterDetail={id,anchor};drawer('character-panel');controls();node('character-close').focus();
 }
 function clearCharacterDetail(){
   characterDetail=null;characterDetailKey='';
   node('character-detail-name').textContent='';node('character-detail-body').replaceChildren();
 }
 function closeCharacterDetail(){
   if(returnFromIndex('character-panel'))return;
   const anchor=characterDetail?.anchor;
   const returnToPortrait=anchor?.isConnected&&readableCharacter(anchor.dataset.characterId);
   drawer(null);
   if(returnToPortrait)anchor.focus({preventScroll:true});
   else if(!node('composer').hidden&&!node('input').hidden&&!node('input').disabled)node('input').focus({preventScroll:true});
   else (node('dialogue-wrap').hidden?node('scene'):node('dialogue')).focus({preventScroll:true});
 }
 function renderCharacterDetail(){
   if(!characterDetail||node('character-panel').hidden)return;
   const person=readableCharacter(characterDetail.id);
   if(!person){closeCharacterDetail();return}
   // Use only fields from the read snapshot. The current authorized view can withdraw a row
   // from that snapshot, but cannot add an item or change what the row says until reading catches up.
   const currentItems=new Set((latest.items||[]).filter(item=>item.where==='with'&&item.holderId===person.id).map(item=>item.id));
   const items=(itemReadView?.items||[]).filter(item=>item.where==='with'&&item.holderId===person.id&&currentItems.has(item.id));
   const currentOptions=new Set(latest.actions.map(option=>option.id));
   const reading=playback.pending();
   // Commit feeds can publish new custody before the round refreshes its action offers.
   const offersReady=!reading&&['ready','error'].includes(latest.status);
   const options=offersReady?(itemReadView?.actions||[]).filter(option=>currentOptions.has(option.id)&&currentItems.has(option.target.id)):[];
   const key=JSON.stringify([person.name,items,options,!!itemReadView,reading]);
   if(key===characterDetailKey)return;
   characterDetailKey=key;
   const body=node('character-detail-body');
   const open=new Set([...body.querySelectorAll('details[open]')].map(card=>card.dataset.itemId));
   const focused=document.activeElement?.closest?.('[data-item-id]');
   const focusedId=focused&&body.contains(focused)?focused.dataset.itemId:null;
   node('character-detail-name').textContent=person.name+' · 角色详情';
   body.replaceChildren();
   const section=document.createElement('section');section.className='inventory-section';
   const heading=document.createElement('h3');heading.textContent='可见携带物';section.append(heading);
   if(!itemReadView||reading){
     const note=document.createElement('p');note.className='hint';
     note.textContent=!itemReadView?'读完或跳过后，可以查看已确认的携带物。':'按你已读到的内容展示。';
     section.append(note);
   }
   if(itemReadView&&!items.length){
     const empty=document.createElement('p');empty.className='hint';empty.textContent='目前没有可显示的携带物。';section.append(empty);
   }
   for(const item of items)section.append(itemCard(item,options,open.has(item.id)));
   body.append(section);
   if(focusedId){
     const card=[...section.querySelectorAll('details')].find(item=>item.dataset.itemId===focusedId);
     (card?.querySelector('summary')||node('character-close')).focus({preventScroll:true});
   }
 }
 /* 进行中的活动：舞台左侧一张卡片，显示标题、阶段、目标和公开状态，以及这场活动此刻允许的操作。
    操作和暂停都来自玩家视图的 actions，提交走同一个 perform；读完当前演出前与其他行动一样置灰。 */
 const PHASES={playing:'进行中',investigation:'调查',prologue:'序章',finished:'已结束','host-aborted':'已中止'};
 let activityKey='';
 function renderActivityOffers(reading){
   const options=latest.actions.filter(option=>option.target?.kind==='activity'&&
     ['host:activity-start','host:activity-resume','host:activity-abandon','host:activity-suspend','host:activity-quick']
       .includes(option.action?.parameters?.definitionRef?.id));
   if(canReadScene()&&['ready','error'].includes(latest.status)){
     activityReadOffers=options;activityReadActive=hasActiveActivity(latest);
   }
   const list=node('activity-discover-list'),panel=node('activity-drawer');
   const shown=activityReadOffers,active=activityReadActive;
   if(!active&&!shown.length&&!panel.hidden)closeActivityDrawer();
   const hint=node('activity-drawer-hint');
   hint.textContent=reading?'读完或跳过未读后可操作。':active?'当前有活动进行中。回场景查看不会暂停或结束活动。':'';
   const key=JSON.stringify(shown);
   if(activityReadKey!==key){
     activityReadKey=key;list.replaceChildren();
     for(const option of shown){
       const group=document.createElement('div');group.dataset.activityOption=option.id;
       appendAction(group,option);list.append(group);
     }
   }
   syncOptionControls(list);
 }
 function renderActivity(view){
   const card=node('activity-card');
   if(playback.pending()){card.hidden=true;return}
   const running=(view.activities||[]).find(entry=>entry.active)||(view.activity?.active?view.activity:null);
   document.querySelector('main').dataset.activity=String(!!running);
   card.hidden=!running;if(!running){activityKey='';node('activity-rules').open=false;return}
   if(!openingHalted&&auto&&running.key===stageConfig?.autoplay?.activity){card.hidden=true;return}
   const options=view.actions.filter(option=>option.kind==='activity'&&option.target?.kind==='activity');
   const manage=view.actions.filter(option=>option.kind==='manage'&&
     (view.status!=='busy'||option.action?.parameters?.definitionRef?.id!=='host:activity-retry'));
   const noOptions=!options.length&&view.status!=='busy';
   const key=JSON.stringify([running,options,manage,noOptions,displayedScene?.recipients]);if(key===activityKey)return;activityKey=key;
   const shown=running.public||{};
   node('activity-title').textContent=running.title;
   node('activity-phase').textContent=shown.statusText||shown.phaseLabel||PHASES[running.phase]||running.phase;
   const objective=node('activity-objective');objective.textContent=typeof shown.objective==='string'?shown.objective:'';objective.hidden=!objective.textContent;
   const instructions=node('activity-instructions');
   instructions.textContent=[...new Set([shown.instructions,shown.description].filter(value=>typeof value==='string'&&value.trim()&&value!==shown.objective))].join('\n\n');
   node('activity-rules').hidden=!instructions.textContent;
   const state=node('activity-state');state.replaceChildren();
   for(const row of activityRows(shown,running.private)){const block=document.createElement('div'),label=document.createElement('dt'),content=document.createElement('dd');if(row.own)block.className='own';label.textContent=row.label;content.textContent=row.value;block.append(label,content);state.append(block)}
   state.hidden=!state.children.length;
   const result=node('activity-result');result.textContent=typeof shown.lastResult==='string'?shown.lastResult:'';result.hidden=!result.textContent;
   const box=node('activity-options');box.replaceChildren();
   for(const option of options){const button=document.createElement('button');button.type='button';button.textContent=option.label;
     if(option.argumentSchema){const form=argumentForm(option);form.append(button);box.append(form);button.onclick=()=>{let args;try{args=form.read()}catch(error){node('notice').textContent=error.message;return}send('perform',{optionId:option.id,arguments:args})}}
     else{button.onclick=()=>send('perform',{optionId:option.id});box.append(button)}}
   if(noOptions){const empty=document.createElement('p');empty.className='hint';empty.textContent='当前没有可执行的活动操作。';box.append(empty)}
   const tools=node('activity-manage');tools.replaceChildren();
   for(const option of manage){const button=document.createElement('button');button.type='button';button.textContent=option.label;button.onclick=()=>send('perform',{optionId:option.id});tools.append(button)}
 }
 node('activity-heading').onclick=()=>{const open=node('activity-heading').getAttribute('aria-expanded')!=='true';node('activity-heading').setAttribute('aria-expanded',String(open));node('activity-body').hidden=!open;if(!open){node('activity-card').style.height='';node('activity-card').style.maxHeight=''}};
 // Grabbing the resize grip lets the card grow down to the dialogue area, never under it, so the grip stays reachable.
 node('activity-card').addEventListener('pointerdown',event=>{
   const card=node('activity-card'),box=card.getBoundingClientRect();
   if(event.clientX<box.right-20||event.clientY<box.bottom-20)return;
   card.style.height=box.height+'px';card.style.maxHeight=Math.max(box.height,activityRoom())+'px';
 });
 function activityRoom(){return document.querySelector('.stage-bottom').getBoundingClientRect().top-node('activity-card').getBoundingClientRect().top-12}
 // When the dialogue area grows (the composer opens), a resized card shrinks back above it.
 new ResizeObserver(()=>{const card=node('activity-card');if(!card.style.maxHeight||card.hidden)return;const room=Math.max(96,activityRoom());card.style.maxHeight=room+'px';if(parseFloat(card.style.height)>room)card.style.height=room+'px'}).observe(document.querySelector('.stage-bottom'));
 function renderHostNotice(){
   const notice=node('host-notice'),view=latest;
   let text='',receiptId='';
   const generic=successFeedback.isRoutineCompletion(view);
   if(view&&!pending&&!requestIssue){
     if(generic){
       const receipt=successFeedback.read(view,playback.pending()||sceneArtLoading);
       if(receipt){text=receipt.text;receiptId=receipt.id}
     }else if(view.status==='error')text='处理未完成，请查看已读记录和当前可用操作。';
     else if(view.canInterrupt)text='可以继续输入。这会打断当前处理，已发生的行动保留。';
     else if(view.status==='busy')text='';
     else if(view.status==='paused')text='当前已暂停。';
     else text=view.feedback?.message||'';
   }
   const live=generic?'off':'polite';
   if(notice.getAttribute('aria-live')!==live)notice.setAttribute('aria-live',live);
   if(notice.textContent!==text)notice.textContent=text;
   if(receiptId)notice.dataset.receipt=receiptId;
   else delete notice.dataset.receipt;
   if(text&&successFeedback.announce(receiptId))node('success-announcement').textContent=text;
 }
 function requestCopy(issue){
   if(issue.kind==='unknown'&&issue.request.battleCommitted)return ['结算结果未确认','主机已确认提交这次出招。请勿重发，可只读检查结果。'];
   if(issue.kind==='unknown')return ['结果未确认',issue.checked==='unreachable'?
     '暂时无法连接以检查结果。操作可能已执行，请勿重发。':
     issue.checked?'这次查询仍无法确认原请求。它可能已执行，请勿重发。':
     '操作可能已执行。请勿重发，可以只读检查结果。'];
   if(issue.kind==='confirmed')return ['已确认提交',
     playback.pending()?'读完或跳过未读后，可查看已获授权的结果。':'已收到这次请求的提交确认，可查看当前已读结果。'];
   return [issue.kind==='expired'?'没执行 · 选项已失效':'没执行',issue.reason];
 }
 function requestLine(request){return request.method==='speak'?request.payload:request.payload.say}
 function renderRequestFeedback(){
   const issue=requestIssue,box=node('request-feedback'),check=node('check-result'),review=node('review-request');
   box.hidden=!issue;
   if(!issue)return;
   const [title,body]=requestCopy(issue);
   if(node('request-title').textContent!==title)node('request-title').textContent=title;
   if(node('request-detail').textContent!==body)node('request-detail').textContent=body;
   box.dataset.kind=issue.kind;
   check.hidden=issue.kind!=='unknown';
   check.disabled=checking;
   check.textContent=checking?'正在检查…':'检查结果';
   const withDraft=!!requestLine(issue.request);
   review.hidden=issue.kind==='confirmed'||(issue.kind==='unknown'&&(!withDraft||!node('composer').hidden));
   review.textContent=withDraft?(issue.kind==='unknown'?'查看草稿':'核对草稿'):'重新选择';
   if(!withDraft&&['regenerate','selectCandidate'].includes(issue.request.method))review.textContent='返回阅读';
   node('dismiss-request').hidden=issue.kind==='unknown';
 }
 function finishRequest(request){
   const wasUnknown=requestIssue?.kind==='unknown';
   pending=null;posting=false;
   requestIssue=wasUnknown?{kind:'confirmed',request}:null;
   const line=requestLine(request);
   if(line){
     if(node('input').value.trim()===line.text)node('input').value='';
     if(node('narration').value.trim()===(line.narration||''))node('narration').value='';
     if(!(node('input').value||node('narration').value))composerExpanded=false;
   }
   const message=node('message-text');
   if(request.message&&message.value.trim()===request.payload.arguments.text)message.value='';
   if(request.method==='perform'&&attached?.option.id===request.payload.optionId)detach();
   if(openingHalted&&!wasUnknown)resumeOpening();
 }
 function setRequestIssue(request,outcome){
   posting=false;
   if(outcome.kind!=='unknown')pending=null;
   if(outcome.kind==='expired'){
     if(request.method==='perform')expiredOffers.add(request.payload.optionId);
     else expiredTail=request.payload.tailId;
   }
   requestIssue={...outcome,request};
   node('notice').textContent='';
   if(openingSeen)haltOpening();
 }
 async function refreshRequestView(version){
   let view;
   try{view=await api.getView()}
   catch{if(version===requestVersion){connected=false;controls()}return false}
   if(version!==requestVersion)return false;
   connected=true;render(view);
   return true;
 }
 async function submit(request){
   const version=++requestVersion;
   posting=true;controls();
   let outcome,reply;
   try{reply=await api.request(request.method,request.payload,request.actionId);outcome=classifyReply(request.method,reply)}
   catch(error){outcome=classifyReply(request.method,undefined,error||{})}
   if(request.battleSkill&&outcome.kind==='acknowledged'){
     if(committedInput(reply,request))request.battleCommitted=true;
     if(reply.activityStage?.activityId===request.battleSkill.id&&reply.activityStage.revision===request.battleSkill.revision)outcome={kind:'unknown'};
   }
   if(pending!==request){
     if(version===requestVersion&&outcome.kind==='acknowledged'){
       successFeedback.bind(request,reply,requestIssue?.kind==='confirmed');
       controls();
     }
     return;
   }
   if(outcome.kind==='acknowledged'){
     successFeedback.bind(request,reply,requestIssue?.kind==='unknown');
     finishRequest(request);
   }
   else setRequestIssue(request,outcome);
   controls();
   if(outcome.kind!=='unknown')await refreshRequestView(version);
 }
 async function checkResult(){
   if(!pending||posting||checking||requestIssue?.kind!=='unknown')return;
   const request=pending,version=requestVersion,button=node('check-result');
   const restore=document.activeElement===button;
   checking=true;controls();
   try{
     const refreshed=await refreshRequestView(version);
     if(pending===request&&requestIssue?.kind==='unknown')requestIssue.checked=refreshed?'unmatched':'unreachable';
   }finally{
     checking=false;controls();
     if(restore&&(document.activeElement===document.body||document.activeElement===button)){
       const target=requestIssue?.kind==='confirmed'?node('dismiss-request'):button;
       if(isVisible(target))target.focus({preventScroll:true});
     }
   }
 }
 function reviewRequest(){
   const issue=requestIssue;
   if(!issue)return;
   const request=issue.request;
   if(requestLine(request)){
     if(issue.kind==='expired'&&attached)detach();
     drawer(null);composerExpanded=true;activityOpen=false;controls();node('input').focus({preventScroll:true});
   }else if(request.method==='perform'){
     const move=request.move;
     drawer(move?'move-panel':'action-panel');controls();
     node(move?'move-close':'actions-close').focus({preventScroll:true});
   }else{
     drawer(null);controls();node('dialogue').focus({preventScroll:true});
   }
 }
 node('check-result').onclick=checkResult;
 node('review-request').onclick=reviewRequest;
 node('dismiss-request').onclick=()=>{if(requestIssue?.kind!=='unknown'){requestIssue=null;controls()}};
 // The opening reads ahead: it may submit while earlier text is still being read.
 function send(method,payload,readingAhead=false){
   const tailOperation=method==='regenerate'||method==='selectCandidate';
   if(posting||!!pending||!connected||(!tailOperation&&!readingAhead&&playback.pending())||(tailOperation?(!latest?.tailRound?.canRegenerate||expiredTail===payload.tailId):!['ready','error'].includes(latest?.status)&&!(method==='speak'&&latest?.canInterrupt)))return;
   if(method==='perform'&&(sceneArtLoading||!liveOption(payload.optionId)))return;
   const option=method==='perform'?liveOption(payload.optionId):null;
   requestIssue=null;successFeedback.clear();node('notice').textContent='';
   if(node('success-announcement').textContent)node('success-announcement').textContent='';
   if(method!=='speak'&&!payload.say)composerExpanded=false;
   drawer(null);pending={method,payload,actionId:api.newActionId(),move:option?.kind==='move',message:!!option&&isMessage(option),
     battleSkill:battleReading?.submittedSkill(latest,option,payload.arguments),
     statusOperation:option?.action?.parameters?.definitionRef?.id?.startsWith('status:')===true};
   submit(pending);
 }
 node('regenerate-round').onclick=()=>send('regenerate',{tailId:latest.tailRound.id});
 function choose(offset){const tail=latest?.tailRound,id=tail?.candidateIds?.[(tail.candidateIndex||1)-1+offset];if(id)send('selectCandidate',{tailId:tail.id,candidateId:id})}
 node('candidate-prev').onclick=()=>choose(-1);node('candidate-next').onclick=()=>choose(1);
 node('cancel-round').onclick=async()=>{try{await api.cancelRegeneration()}catch{node('notice').textContent='暂时无法确认是否已停止，请查看当前回合。'}};
 /* 一个回合 = 一次表达 + 至多一个行动。输入框里有话时，点选的行动先附在发送按钮旁，和这句话一起提交；没有话时直接执行。 */
 function composerLine(){return (latest?.expression&&latest.expression.speech!=='free'?'':node('input').value.trim())||(latest?.expression?.narration===false?'':node('narration').value.trim())}
 function attach(option,args){composerExpanded=true;attached={option,args};node('attached-label').textContent='连同行动：'+option.label;node('attached-action').hidden=false;drawer(null);controls();node('input').focus()}
 function detach(){attached=null;node('attached-action').hidden=true;controls()}
 function act(option,args){if(actionGate(option.id))return;if(composerLine()){attach(option,args);return}send('perform',{optionId:option.id,...(args?{arguments:args}:{})})}
 node('attached-clear').onclick=detach;
 /** What the player can do with one character, from the current view only: speak to them, act on them, give
  * them something that names a character as its one input, or invite them to an activity. */
 function characterMenu(id,anchor){
   const menu=node('character-menu'),person=readableCharacter(id);
   if(!person){closeCharacterMenu();return}
   closeCharacterMenu();
   characterMenuAnchor=anchor;
   anchor.setAttribute('aria-expanded','true');
   menu.replaceChildren();
   const title=document.createElement('p');title.textContent=person.name;menu.append(title);
   const busy=!!actionGate();
   const entry=(text,run,disabled)=>{const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.textContent=text;button.disabled=!!disabled;button.onclick=()=>{closeCharacterMenu();if(readableCharacter(id))run()};menu.append(button)};
   if(speechAvailable(latest?.expression))for(const [scope,label] of speechEntries(person.name)){
     entry(label,()=>speakTo(id,scope),!!speechGate(id));
   }
   entry('查看角色',()=>openCharacterDetail(id,anchor),false);
   for(const option of playback.pending()?[]:latest.actions){
     if(option.kind==='manage')continue;
     const inputs=Object.keys(option.argumentSchema?.properties||{}),named=option.characterArguments||[],selection=option.participantSelection;
     if(selection){if(selection.min<=1&&selection.max>=1&&selection.candidates.some(candidate=>candidate.id===id))entry('邀请 '+person.name+'：'+String(option.label).replace(/^开始 /,''),()=>send('perform',{optionId:option.id,npcIds:[id]}),busy);continue}
     if(option.target?.kind==='character'&&option.target.id===id&&!inputs.length)entry(option.label,()=>act(option),busy);
     else if(named.length===1&&inputs.length===1&&inputs[0]===named[0])entry(option.label+' '+person.name,()=>act(option,{[named[0]]:id}),busy);
   }
   menu.hidden=false;
   positionCharacterMenu();
   syncDialogueControl();(menu.querySelector('button:not(:disabled)')||anchor).focus({preventScroll:true});
 }
 function positionCharacterMenu(){
   if(!characterMenuAnchor)return;
   const menu=node('character-menu'),box=characterMenuAnchor.getBoundingClientRect(),gap=6,margin=8;
   const width=menu.offsetWidth,height=menu.offsetHeight;
   const right=box.right+gap,leftEdge=box.left-gap-width;
   const beside=right+width<=innerWidth-margin?right:leftEdge>=margin?leftEdge:null;
   const left=beside??box.left+(box.width-width)/2;
   const below=box.bottom+gap;
   const top=beside!==null?box.bottom-height:below+height<=innerHeight-margin?below:box.top-gap-height;
   menu.style.left=Math.max(margin,Math.min(left,innerWidth-menu.offsetWidth-margin))+'px';
   menu.style.top=Math.max(margin,Math.min(top,innerHeight-menu.offsetHeight-margin))+'px';
 }
 // Keep the only character trigger reachable as the conversation area grows in short windows.
 const stageBar=document.querySelector('.stage-action-bar'),portraits=node('characters');
 const nameplateLayout=new ResizeObserver(()=>{
   const floor=stageBar.getBoundingClientRect().top-portraits.getBoundingClientRect().top-8;
   portraits.style.setProperty('--nameplate-floor',floor+'px');positionCharacterMenu();
 });
 for(const element of [portraits,document.querySelector('.stage-bottom'),stageBar])nameplateLayout.observe(element);
 // Let buttons handle activation natively. A held opening key cannot activate the newly focused menu item.
 function characterActivationKey(event){
   if(event.key!=='Enter'&&event.key!==' ')return;
   event.stopPropagation();
   if(event.repeat||event.isComposing||event.keyCode===229)event.preventDefault();
 }
 node('character-menu').onkeydown=characterActivationKey;
 function closeCharacterMenu(returnFocus=false){
   const anchor=characterMenuAnchor;characterMenuAnchor=null;
   node('character-menu').hidden=true;node('character-menu').replaceChildren();if(anchor)syncDialogueControl();
   anchor?.setAttribute('aria-expanded','false');
   if(returnFocus&&anchor?.isConnected)anchor.focus({preventScroll:true});
 }
 document.addEventListener('click',event=>{if(!node('character-menu').hidden&&!node('character-menu').contains(event.target))closeCharacterMenu()});
 /** A small form for an action's player inputs: characters come from the scene, other fields follow the schema. */
 function argumentForm(option,display){
   const form=document.createElement('div');form.className='action-form';form.dataset.optionId=option.id;const fields=[],schema=option.argumentSchema,required=new Set(schema.required||[]);
   for(const [key,spec] of Object.entries(schema.properties||{})){
     const label=document.createElement('label'),caption=document.createElement('span');caption.textContent=(display?.fields[key]||spec.title||spec.description||key)+(required.has(key)?'':'（可选）');label.append(caption);
     let input,read;
     const blank=picker=>{const row=document.createElement('option');row.value='';row.textContent='请选择';picker.append(row)};
     if((option.characterArguments||[]).includes(key)){input=document.createElement('select');blank(input);for(const person of display?.recipients||latest?.scene?.recipients||[]){const item=document.createElement('option');item.value=person.id;item.textContent=person.name;input.append(item)}read=()=>input.value||undefined}
     else if(Array.isArray(spec.enum)){input=document.createElement('select');blank(input);for(const value of spec.enum){const item=document.createElement('option');item.value=JSON.stringify(value);item.textContent=String(value);input.append(item)}if(spec.default!==undefined)input.value=JSON.stringify(spec.default);read=()=>input.value===''?undefined:JSON.parse(input.value)}
     else if(spec.type==='boolean'){input=document.createElement('select');blank(input);for(const [value,title] of [['true','是'],['false','否']]){const item=document.createElement('option');item.value=value;item.textContent=title;input.append(item)}if(spec.default!==undefined)input.value=String(spec.default);read=()=>input.value===''?undefined:input.value==='true'}
     else if(spec.type==='integer'||spec.type==='number'){input=document.createElement('input');input.type='number';input.step='any';if(typeof spec.minimum==='number')input.min=String(spec.minimum);if(typeof spec.maximum==='number')input.max=String(spec.maximum);if(spec.default!==undefined)input.value=String(spec.default);read=()=>input.value===''?undefined:Number(input.value)}
     else if(spec.type==='string'){input=document.createElement('input');input.type='text';if(typeof spec.maxLength==='number')input.maxLength=spec.maxLength;if(typeof spec.minLength==='number')input.minLength=spec.minLength;if(spec.default!==undefined)input.value=spec.default;read=()=>input.value===''?undefined:input.value}
     else{input=document.createElement('textarea');input.placeholder='填写 JSON';if(spec.default!==undefined)input.value=JSON.stringify(spec.default);read=()=>{if(!input.value.trim())return undefined;try{return JSON.parse(input.value)}catch{throw new Error(caption.textContent+' 不是有效的 JSON')}};const hint=document.createElement('small');hint.className='hint';hint.textContent='此参数使用结构化 JSON；提交时由游戏规则校验。';label.append(hint)}
     input.name=key;input.required=required.has(key);input.setAttribute('aria-label',caption.textContent);label.append(input);form.append(label);fields.push({key,caption:caption.textContent,input,read,required:required.has(key)});
   }
   form.read=()=>{const values={};for(const field of fields){const value=field.read();if(value===undefined){if(field.required){field.input.focus();throw new Error('请填写 '+field.caption)}continue}if(!field.input.checkValidity()){field.input.focus();throw new Error(field.caption+'：'+field.input.validationMessage)}values[field.key]=value}return values};
   return form}

 node('wait').onclick=()=>{if(waitOption&&!actionGate(waitOption.id))send('perform',{optionId:waitOption.id})};
 node('reply-open').onclick=()=>{composerExpanded=true;activityOpen=false;controls();node('input').focus()};
 node('send').onclick=()=>{const text=latest?.expression&&latest.expression.speech!=='free'?'':node('input').value.trim(),narration=latest?.expression?.narration===false?'':node('narration').value.trim();if(!text&&!narration&&!attached)return;const maximum=latest?.settings?.inputCharacters||2000;if(text.length+narration.length>maximum){node('notice').textContent='发言与描写合计不能超过 '+maximum+' 个字符';return}const scope=speechScope(),addresseeIds=scope==='direct'||scope==='private'?[node('speech-recipient').value]:[];if((text||narration)&&(scope==='direct'||scope==='private')&&!addresseeIds[0])return;
   if(attached){const payload={optionId:attached.option.id,...(attached.args?{arguments:attached.args}:{})};if(text||narration)Object.assign(payload,{say:{text,narration,scope,addresseeIds},order:node('attached-order').value});send('perform',payload);return}
   send('speak',{text,narration,scope,addresseeIds})};
 const sendCluster=node('send-cluster'),audienceButton=node('audience-button'),scopeMenu=node('audience-menu');
 const compactAudience=matchMedia('(hover:none), (max-width:900px)');
 document.querySelector('.stage-bottom').append(scopeMenu);
 function syncAudienceDisclosure(){
   const keyboardFocus=sendCluster.contains(document.activeElement)&&document.activeElement.matches(':focus-visible');
   const open=compactAudience.matches||speechScope()!=='scene_public'||audienceHovered||keyboardFocus||!scopeMenu.hidden;
   sendCluster.dataset.expanded=String(open);
 }
 function positionScopeMenu(){
   const button=audienceButton.getBoundingClientRect(),box=scopeMenu.offsetParent.getBoundingClientRect();
   const width=scopeMenu.offsetWidth;
   scopeMenu.style.left=(Math.max(8,Math.min(button.right-width,innerWidth-width-8))-box.left)+'px';
   scopeMenu.style.bottom=(box.bottom-button.top+6)+'px';
   scopeMenu.style.maxHeight=Math.max(44,button.top-12)+'px';
 }
 function audienceMenu(open,restoreFocus=false){
   scopeMenu.hidden=!open;
   audienceButton.setAttribute('aria-expanded',String(open));
   syncAudienceDisclosure();
   if(open){
     positionScopeMenu();
     scopeMenu.querySelector('input:checked').focus({preventScroll:true});
   }else if(restoreFocus)audienceButton.focus({preventScroll:true});
 }
 audienceButton.onclick=()=>audienceMenu(scopeMenu.hidden);
 node('audience-done').onclick=()=>audienceMenu(false,true);
 for(const radio of scopeMenu.querySelectorAll('input[name="speech-scope"]'))radio.onchange=()=>{audience();controls()};
 node('speech-recipient').onchange=()=>{recipientLost=false;audience();controls()};
 document.addEventListener('click',event=>{if(!scopeMenu.hidden&&!audienceButton.contains(event.target)&&!scopeMenu.contains(event.target))audienceMenu(false)});
 scopeMenu.addEventListener('keydown',event=>{
   if(event.key!=='Tab')return;
   const first=scopeMenu.querySelector('input:checked'),last=node('audience-done');
   if((event.shiftKey&&document.activeElement===first)||(!event.shiftKey&&document.activeElement===last)){
     event.preventDefault();audienceMenu(false,true);
   }
 });
 addEventListener('resize',()=>{syncAudienceDisclosure();if(!scopeMenu.hidden)positionScopeMenu()});
 sendCluster.addEventListener('pointerenter',event=>{if(event.pointerType==='mouse'){audienceHovered=true;syncAudienceDisclosure()}});
 sendCluster.addEventListener('pointerleave',()=>{audienceHovered=false;syncAudienceDisclosure()});
 sendCluster.addEventListener('focusin',syncAudienceDisclosure);
 sendCluster.addEventListener('focusout',()=>queueMicrotask(syncAudienceDisclosure));
 node('send').onkeydown=event=>{if(event.key==='ArrowLeft'){event.preventDefault();audienceButton.focus()}};
 node('composer-read').onclick=()=>{resumeDraft=true;composerExpanded=false;controls();node('dialogue').focus()};
 node('composer-skip').onclick=()=>{playback.skip();rememberReadItems();editorContext=playback.lastRead();renderStage();controls();node('input').focus()};
 audience();
 node('input').oninput=controls;node('narration').oninput=controls;
 node('narration-panel').addEventListener('toggle',()=>{if(node('narration-panel').open)node('narration').focus()});
 node('input').onkeydown=node('narration').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();node('send').click()}};
 let composerExpanded=false,activityOpen=false,auto=false,autoTimer=null,autoKey='',expressionKey='',sceneKey='',dialogueKey='';
 let openingSeen=false,openingPreviousAuto=false,openingHalted=false,openingTimer=null,openingRetried='';
 const toastTimers=new Map();
 function showToast(id,text){const target=node(id);target.textContent=text;target.hidden=false;clearTimeout(toastTimers.get(id));toastTimers.set(id,setTimeout(()=>target.hidden=true,4000))}
 function renderItemChanges(){/* Custody results stay in the authorized narrative queue; no duplicate item toast. */}
 /** Where the head top and waist sit in a portrait (fractions of its height), from the pack's stage.json; an
  * unmarked portrait is taken as full body. The stylesheet scales it so heads line up across characters. */
 function framing(id){const own=stageConfig?.characters?.[id]?.framing;return own||{top:.03,waist:.48}}
 function createPortrait(id,name){
   const portrait=document.createElement('div');portrait.className='portrait';portrait.dataset.characterId=id;
   const frame=framing(id);portrait.style.setProperty('--top',String(frame.top));portrait.style.setProperty('--waist',String(frame.waist));
   const badge=document.createElement('div');badge.className='portrait-badge';badge.textContent=Array.from(name)[0]||'◇';
   const src=art('portraits',id);badge.hidden=!!src;
   if(src){const figure=document.createElement('div');figure.className='figure';const base=document.createElement('img');base.className='base';base.alt=name+'的立绘';base.onerror=()=>{figure.remove();badge.hidden=false};base.src=src;figure.append(base);portrait.append(figure);dress(portrait,stageConfig?.characters?.[id]?.defaultExpression,null)}portrait.append(badge);
   const label=document.createElement('button');label.type='button';label.className='character-name';
   label.textContent=name;label.dataset.characterId=id;label.setAttribute('aria-label',name+'，角色菜单');
   label.setAttribute('aria-haspopup','menu');label.setAttribute('aria-controls','character-menu');label.setAttribute('aria-expanded','false');
   label.onclick=event=>{event.stopPropagation();characterMenu(id,label)};
   label.onkeydown=characterActivationKey;
   portrait.append(label);
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
   node('save-confirm').textContent='保存进度';node('save-cancel').textContent='取消';node('save-result').textContent='';node('save-dialog').dataset.state='idle';node('save-dialog').showModal();syncDialogueControl();scheduleAuto();node('save-title').select();
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
   node('reading-count').textContent=playback.pending()?'待阅读 '+playback.remaining()+' 段':'';
   // New views arrive while a queued text is read; only a different text is redrawn and fades in.
   const shown=JSON.stringify([unit?.seq,unit?.segmentIndex,unit?.speaker,unit?.type,unit?.text]);
   if(shown!==dialogueKey){
     dialogueKey=shown;
     node('speaker').textContent=unit?.speaker||'序幕';node('dialogue-text').replaceChildren();fillText(node('dialogue-text'),unit?.text||'看看眼前的世界，向角色打个招呼吧。');node('dialogue').scrollTop=0;
     node('dialogue').dataset.type=unit?.type||'speech';
     node('dialogue').classList.remove('fade-in');void node('dialogue').offsetWidth;node('dialogue').classList.add('fade-in');
   }
   const candidate=playback.stageScene(latest?.scene||null);
   const changingLocation=candidate?.locationId!==displayedScene?.locationId;
   // Items and destinations lack a per-line projection. Commit a new location only when the whole
   // authorized batch is read, and keep the old image until the new one can be shown.
   let scene=candidate;
   sceneArtLoading=false;
   if(changingLocation&&displayedScene&&(playback.pending()||latest?.status==='busy'))scene=displayedScene;
   else if(changingLocation&&!displayedScene&&playback.pending()&&candidate?.changedAt>(unit?.seq??0))scene=null;
   else if(changingLocation){
     const url=art('backgrounds',candidate?.locationId);
     if(url&&readyBackground?.url!==url){
       scene=displayedScene;
       sceneArtLoading=true;
       if(preparingArt!==url){
         preparingArt=url;
         const image=new Image();image.alt='';image.src=url;
         const finish=loaded=>{
           if(preparingArt!==url)return;
           preparingArt='';readyBackground={url,image:loaded?image:null};
           renderStage();controls();
         };
         image.decode().then(()=>finish(true),()=>finish(false));
       }
     }
   }
   const previousScene=displayedScene;
   const arrived=scene?.locationId!==previousScene?.locationId;
   displayedScene=scene;
   renderRecipients(displayedScene);
   if(canReadScene()){
     if(!itemReadView||arrived)rememberReadItems();
     if(['ready','error'].includes(latest.status))moveReadOptions=latest.actions.filter(option=>option.kind==='move');
   }
   const key=JSON.stringify(scene);
   if(key!==sceneKey){
     if(previousScene&&arrived&&scene?.locationName)showToast('movement-toast','当前情景 · '+scene.locationName);
    sceneKey=key;node('scene').textContent=scene?.locationName||'情景尚未开始';
    if(arrived){
      const image=readyBackground?.url===art('backgrounds',scene?.locationId)?readyBackground?.image:null;
      const background=node('background');
      if(image){image.id='background';background.replaceWith(image)}
      else{background.hidden=true;background.removeAttribute('src')}
    }
    closeCharacterMenu();
    const box=node('characters'),present=scene?.recipients||[],kept=new Map();
    box.querySelector('.alone')?.remove();
    if(arrived)for(const old of box.querySelectorAll('.portrait.leaving'))old.remove();
    for(const old of box.querySelectorAll('.portrait:not(.leaving)')){
      if(present.some(person=>person.id===old.dataset.characterId))kept.set(old.dataset.characterId,old);
      else if(arrived)old.remove();
      else{old.inert=true;old.classList.add('leaving');setTimeout(()=>old.remove(),320)}
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
   const unobstructed=!composerExpanded&&!document.querySelector('.panel:not([hidden])')&&!node('save-dialog').open;
   if(autoTimer&&autoKey===key&&auto&&unobstructed)return;
   clearTimeout(autoTimer);autoTimer=null;autoKey=key;updateAutoProgress(0);
   if(auto&&playback.pending()&&unobstructed){
     const duration=Math.max(1500,Math.min(28000,Math.max(2500,(playback.current()?.text.length||0)*90)/preferences.autoSpeed));
     updateAutoProgress(duration);
     autoTimer=setTimeout(()=>{autoTimer=null;updateAutoProgress(0);if(!composerExpanded)advance()},duration);
   }
 }
 // Author-configured opening: perform only offered actions, queuing the whole opening for reading instead of one text at a time.
 function scheduleOpening(){
   const config=stageConfig?.autoplay;
   if(!config||openingHalted||!latest||!connected||composerExpanded)return;
   const entry=(latest.activities||[]).find(item=>item.key===config.activity);
   const start=latest.actions.find(option=>option.target?.id===config.activity&&option.action?.parameters?.definitionRef?.id==='host:activity-start');
   if(!openingSeen&&(entry?.active||start)){
     openingSeen=true;openingPreviousAuto=auto;setAuto(true);
   }
   if(!openingSeen)return;
   if(entry&&!entry.active&&entry.phase==='finished'&&!playback.pending()&&!posting){
     openingSeen=false;setAuto(openingPreviousAuto);return;
   }
   const next=latest.actions.find(option=>option.target?.id===config.activity&&option.action?.parameters?.definitionRef?.id==='activity:'+config.operation);
   const retry=latest.actions.find(option=>option.target?.id===config.activity&&option.action?.parameters?.definitionRef?.id==='host:activity-retry');
   // A failed character turn comes back as an error view, not a rejected request: ask once more, then stop and hand over the card.
   const failed=latest.status==='error'&&!!entry?.active;
   if(failed&&!posting&&!pending&&(!retry||openingRetried===retry.id)){haltOpening();return}
   if(!auto||posting||pending||openingTimer||(latest.status!=='ready'&&!failed)||document.querySelector('.panel:not([hidden])')||node('save-dialog').open)return;
   const action=failed?retry:entry?.active?(next||retry):start;
   if(!action)return;
   if(action===retry&&openingRetried===action.id){haltOpening();return}
   openingTimer=setTimeout(()=>{openingTimer=null;if(openingHalted||!auto||composerExpanded||posting||pending||!['ready','error'].includes(latest.status)||document.querySelector('.panel:not([hidden])')||node('save-dialog').open)return;if(!latest.actions.some(option=>option.id===action.id)){scheduleOpening();return}if(action===retry)openingRetried=action.id;send('perform',{optionId:action.id},true)},0);
 }
 // A halted opening shows its activity card and leaves auto-read as it was before the opening.
 function haltOpening(){openingHalted=true;setAuto(openingPreviousAuto)}
 // Explicitly turning auto-read back on, or any request that succeeds, lets the opening continue.
 function resumeOpening(){openingHalted=false;openingRetried=''}
 function canReplyNow(){
   const policy=latest?.expression||{speech:'free',speechChoices:[],narration:true};
   return !posting&&!pending&&connected&&(['ready','error'].includes(latest?.status)||latest?.canInterrupt)&&(policy.speech!=='none'||policy.narration);
 }
 function advance(skip=false){
   if(document.querySelector('.panel:not([hidden])')||node('save-dialog').open||!playback.pending())return;
   updateAutoProgress(0);
   const through=skip?battleReading?.boundary(playback.current()?.seq):undefined;
   if(skip&&through!==undefined){while(playback.pending()&&playback.current().seq<=through)playback.advance()}
   else if(skip)playback.skip();else playback.advance();
   rememberReadItems();renderStage();
   const complete=!playback.pending(),restore=complete&&resumeDraft;
   if(complete)resumeDraft=false;
   if(restore)composerExpanded=true;
   controls();
   if(!stageOpen&&restore)node('input').focus({preventScroll:true});
 }
 // Only one drawer is visible at a time; every drawer pauses automatic reading.
 function drawer(name){pickupOrigin=null;if(name!=='status-panel')statusOrigin=null;if(indexChild&&indexChild.panel!==name)indexChild=null;closeCharacterMenu();audienceMenu(false);node('character-panel').hidden=name!=='character-panel';if(name!=='character-panel')clearCharacterDetail();for(const [id,toggle] of [['history-panel','history-toggle'],['action-panel','actions-toggle'],['message-panel','composer-message'],['inventory-panel','inventory-toggle'],['nearby-panel','nearby-toggle'],['move-panel','move-toggle'],['activity-drawer','activity-discover'],['status-panel','status-toggle'],['settings-panel','settings-toggle']]){node(id).hidden=id!==name;node(toggle).setAttribute('aria-expanded',String(id===name))}node('scene').setAttribute('aria-expanded',String(name==='move-panel'));node('composer-actions').setAttribute('aria-expanded',String(name==='action-panel'));scheduleAuto()}
 function historyPanel(open){if(open)drawer('history-panel');else node('history-panel').hidden=true;node('history-toggle').setAttribute('aria-expanded',String(open));if(open){clearTimeout(autoTimer);autoTimer=null;updateAutoProgress(0);node('history-close').focus();bottom()}else{node('history-toggle').focus();scheduleAuto()}controls()}
 // The same reading surface supports a pointer, assistive activation and the stage keyboard shortcut.
 const readBox=node('dialogue-wrap'),readSurface=node('dialogue'),readArrow=node('read-arrow');
 function dailyReadAvailable(){
   return playback.pending()&&!document.querySelector('main').inert&&!activityOpen&&!readBox.hidden&&
     !node('save-dialog').open&&!document.querySelector('.panel:not([hidden]),#character-menu:not([hidden])');
 }
 function syncDialogueControl(){
   const enabled=dailyReadAvailable();
   readArrow.hidden=!enabled;readSurface.tabIndex=enabled?0:-1;
   if(enabled){
     readSurface.setAttribute('role','button');readSurface.setAttribute('aria-label','阅读下一段');
     readSurface.setAttribute('aria-describedby','speaker dialogue-text');
   }else for(const attribute of ['role','aria-label','aria-describedby'])readSurface.removeAttribute(attribute);
 }
 function selectingDialogue(){
   const selected=getSelection();
   return selected?.rangeCount>0&&!selected.isCollapsed&&selected.getRangeAt(0).intersectsNode(node('dialogue-text'));
 }
 let readingPointer=null;
 readBox.addEventListener('pointerdown',event=>{
   readingPointer={id:event.pointerId,x:event.clientX,y:event.clientY,scroll:readSurface.scrollTop,
     ignore:event.button!==0||!event.isPrimary||selectingDialogue()};
 });
 function trackReadingPointer(event){
   if(readingPointer?.id!==event.pointerId)return;
   if(event.type==='pointercancel'||Math.hypot(event.clientX-readingPointer.x,event.clientY-readingPointer.y)>8)
     readingPointer.ignore=true;
 }
 for(const type of ['pointermove','pointerup','pointercancel'])readBox.addEventListener(type,trackReadingPointer);
 readBox.addEventListener('click',event=>{
   const pointer=event.detail>0?readingPointer:null;readingPointer=null;
   if(event.defaultPrevented||event.button!==0||event.target.closest('button,a,input,select,textarea,summary,[contenteditable],#feedback,.round-tools'))return;
   if(pointer&&(pointer.ignore||pointer.scroll!==readSurface.scrollTop)||selectingDialogue())return;
   if(node('save-dialog').open||document.querySelector('main').inert)return;
   if(!node('character-menu').hidden){closeCharacterMenu(true);return}
   if(!node('action-panel').hidden){closeActionIndex();return}
   if(!node('nearby-panel').hidden){closeNearby();return}
   if(pickupOrigin){closePickup();return}
   if(document.querySelector('.panel:not([hidden])')){drawer(null);controls();return}
   if(dailyReadAvailable())advance();
 });
 let heldReadKey='';
 document.addEventListener('keydown',event=>{
   if(event.key!==' '&&event.key!=='Enter')return;
   if(event.repeat&&heldReadKey===event.key){
     event.preventDefault();event.stopImmediatePropagation();return;
   }
   if(event.repeat||event.isComposing||event.keyCode===229||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.defaultPrevented)return;
   if(![readSurface,document.body,document.documentElement,document.querySelector('main')].includes(event.target))return;
   if(!dailyReadAvailable()||selectingDialogue())return;
   event.preventDefault();heldReadKey=event.key;advance();
 },true);
 document.addEventListener('keyup',event=>{if(event.key===heldReadKey)heldReadKey=''});
 addEventListener('blur',()=>{heldReadKey=''});
 node('skip-read').onclick=()=>advance(true);
 // Every change of auto-read goes through here, so the button, the opening card and the timer agree.
 function setAuto(value){auto=value;node('auto-read').setAttribute('aria-pressed',String(auto));node('auto-read').classList.toggle('active',auto);if(latest)renderActivity(latest);scheduleAuto()}
 node('auto-read').onclick=()=>{if(!auto&&openingSeen&&openingHalted)resumeOpening();setAuto(!auto);controls()};
 node('history-toggle').onclick=()=>historyPanel(node('history-panel').hidden);node('history-close').onclick=()=>historyPanel(false);
 for(const id of ['actions-toggle','composer-actions']){
   const trigger=node(id);
   trigger.onpointerdown=()=>{indexPointerOrigin=document.activeElement};
   trigger.onclick=event=>toggleActionIndex(trigger,event.detail?indexPointerOrigin:null);
 }
 node('actions-close').onclick=closeActionIndex;
 node('action-search').oninput=filterActionIndex;node('action-category').onchange=filterActionIndex;
 node('index-browse-move').onclick=()=>browseFromIndex('move-panel',node('move-close'));
 node('index-browse-nearby').onclick=()=>openNearby(true);
 node('inventory-toggle').onclick=()=>browseFromIndex('inventory-panel',node('inventory-close'));
 node('composer-message').onclick=()=>{const open=node('message-panel').hidden;drawer(open?'message-panel':null);controls();if(open)node('message-text').focus()};node('message-close').onclick=()=>{if(!returnFromIndex('message-panel')){drawer(null);controls()}};node('message-send').onclick=sendMessage;
 function closeMovePanel(){
   if(returnFromIndex('move-panel'))return;
   drawer(null);controls();
   (isVisible(moveTrigger)?moveTrigger:node('scene')).focus({preventScroll:true});
 }
 for(const id of ['scene','move-toggle']){
   node(id).onclick=()=>{
     if(!node('move-panel').hidden){closeMovePanel();return}
     moveTrigger=node(id);drawer('move-panel');controls();node('move-close').focus();
   };
 }
 node('move-close').onclick=closeMovePanel;
 function closeActivityDrawer(){
   drawer(null);controls();(isVisible(node('activity-discover'))?node('activity-discover'):node('actions-toggle')).focus({preventScroll:true});
 }
 node('activity-drawer-close').onclick=closeActivityDrawer;
 node('activity-discover').onclick=()=>{
   if(!node('activity-drawer').hidden){closeActivityDrawer();return}
   drawer('activity-drawer');controls();node('activity-drawer-close').focus({preventScroll:true});
 };
 node('character-close').onclick=closeCharacterDetail;
 function openNearby(fromIndex){
   if(fromIndex)indexChild={panel:'nearby-panel',anchor:node('index-browse-nearby')};
   drawer('nearby-panel');controls();
   node('nearby-list').scrollTop=0;focusNearbyItem();
 }
 function closeNearby(){
   if(returnFromIndex('nearby-panel'))return;
   drawer(null);controls();
   (isVisible(node('nearby-toggle'))?node('nearby-toggle'):node('actions-toggle')).focus({preventScroll:true});
 }
 node('nearby-toggle').onclick=()=>{if(node('nearby-panel').hidden)openNearby(false);else closeNearby()};
 node('nearby-close').onclick=closeNearby;
 node('inventory-close').onclick=()=>{if(pickupOrigin){closePickup();return}if(!returnFromIndex('inventory-panel')){drawer(null);controls();node('actions-toggle').focus()}};
 let statusOrigin=null,statusPointerOrigin=null;
 const statusToggle=node('status-toggle'),statusPanel=node('status-panel');
 statusToggle.onpointerdown=event=>{
   statusPointerOrigin=[node('input'),node('narration')].includes(document.activeElement)?document.activeElement:null;
   if(statusPointerOrigin)event.preventDefault();
 };
 statusToggle.onclick=event=>{
   if(!statusPanel.hidden){closeStatusPanel(true);return}
   statusOrigin=event.detail&&statusPointerOrigin?statusPointerOrigin:statusToggle;
   drawer('status-panel');controls();
   if(statusOrigin===statusToggle)node('status-close').focus({preventScroll:true});
 };
 function closeStatusPanel(restore){
   const origin=statusOrigin;
   drawer(null);controls();
   if(restore)(isVisible(origin)?origin:statusToggle).focus({preventScroll:true});
 }
 node('status-close').onclick=()=>closeStatusPanel(true);
 document.addEventListener('click',event=>{
   if(statusPanel.hidden||statusPanel.contains(event.target)||statusToggle.contains(event.target))return;
   // A tap on the reading surface dismisses the inspector without advancing the story.
   const onReadingSurface=readBox.contains(event.target)&&!event.target.closest('button,a,input,select,textarea,summary,[contenteditable],#feedback,.round-tools');
   if(onReadingSurface||event.target.closest('#skip-read,#composer-read,#composer-skip,#reply-context,#reply-open')){
     event.preventDefault();event.stopPropagation();closeStatusPanel(true);return;
   }
   const focused=document.activeElement;
   closeStatusPanel(focused===document.body||statusPanel.contains(focused));
 },true);
 node('settings-toggle').onclick=()=>{const open=node('settings-panel').hidden;drawer(open?'settings-panel':null);if(open)node('settings-close').focus();controls()};node('settings-close').onclick=()=>{drawer(null);node('settings-toggle').focus();controls()};
 node('reply-context').onclick=()=>{composerExpanded=false;controls()};
 node('reply-context').onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();composerExpanded=false;controls();node('dialogue').focus()}};
 document.addEventListener('keydown',event=>{if(node('save-dialog').open)return;if(event.key==='Escape'){if(!stageOpen&&!node('activity-stage').hidden)return;if(!statusPanel.hidden){event.preventDefault();closeStatusPanel(true);return}if(stageOpen){parent.postMessage({type:'activity-stage-close',activityId:stageId,revision:latest?.activityStage?.revision,renderer:latest?.activityStage?.renderer},'*');return}if(!node('character-menu').hidden){closeCharacterMenu(true);return}if(!node('audience-menu').hidden){audienceMenu(false);node('audience-button').focus();return}if(!node('character-panel').hidden){closeCharacterDetail();return}if(!node('move-panel').hidden){closeMovePanel();return}if(!node('activity-drawer').hidden){closeActivityDrawer();return}if(!node('action-panel').hidden){closeActionIndex();return}if(!node('nearby-panel').hidden){node('nearby-close').click();return}if(!node('inventory-panel').hidden){node('inventory-close').click();return}if(!node('message-panel').hidden){node('message-close').click();return}const toggle=document.querySelector('.stage-tools button[aria-expanded="true"]');drawer(null);composerExpanded=false;controls();toggle?.focus();return}});
 let lastWheel=0;
 document.addEventListener('wheel',event=>{
   if(!node('activity-stage').hidden||!statusPanel.hidden)return;
   if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;
   if(event.target.closest('.panel,.character-menu,.audience-menu,.activity-card,dialog,.stage-bottom,button,a,input,textarea,select,summary,[contenteditable]'))return;
   const now=Date.now();
   if(now-lastWheel<280)return;
   if(event.deltaY<-40&&node('history-panel').hidden){lastWheel=now;historyPanel(true)}
   else if(event.deltaY>40&&dailyReadAvailable()&&!selectingDialogue()){lastWheel=now;advance()}
 },{passive:true});
 api.subscribe(event=>{if(event.type==='presentation'){if(typeof event.stageOpen==='boolean'){stageOpen=event.stageOpen;stageId=event.stageId||null;if(stageOpen&&!statusPanel.hidden)drawer(null)}activityOpen=event.activityOpen===true;if(activityOpen)composerExpanded=false;controls()}if(event.view){connected=true;render(event.view)}if(event.type==='disconnected'){connected=false;if(pending&&posting)setRequestIssue(pending,{kind:'unknown'});controls()}});
 controls();api.ready.then(info=>{canRegenerate=info.capabilities.includes('regenerate');hasSpeech=info.capabilities.includes('speech');hasBgm=info.capabilities.includes('bgm');node('setting-bgm').disabled=!hasBgm;node('setting-bgm').checked=hasBgm;node('bgm-hint').textContent=hasBgm?'随阅读进度切换音乐':'尚未安装背景音乐插件';canSave=info.canSave===true;stageAssets=info.stageAssets||[];stageConfig=info.stageConfig||null;preferences=normalizePreferences(info.stagePreferences,{...info.view.settings?.reading,...info.view.settings?.audio,...(info.view.settings?.appearance?{appearance:info.view.settings.appearance}:{})});applyPreferences();node('setting-voiceEnabled').disabled=!hasSpeech;node('voice-hint').textContent=hasSpeech?'朗读当前角色的对白':'尚未安装语音服务';node('save-unavailable').hidden=canSave;connected=true;render(info.view)}).catch(()=>{node('notice').textContent='舞台暂时无法连接。';controls()});
})();`

/** Explicit trusted renderer composition; generic default assets contain no gameplay imports. */
export function defaultFrontendAssets(renderers: readonly ActivityStageRenderer[] = []) {
  const registered = activityStageRendererSource(renderers)
  const hasBattle = renderers.some(row => row.moduleId === 'official-rpg' && row.id === 'official-rpg.battle')
  return {
    page: DEFAULT_PAGE,
    style: DEFAULT_STYLE + '\n' + registered.style,
    script: DEFAULT_SCRIPT.replace('/*BATTLE_READING*/null', () =>
      hasBattle ? '(' + createRpgReading.toString() + ')()' : 'null',
    ).replace('/*ACTIVITY_STAGE_RENDERERS*/[]', () => registered.script),
  }
}
