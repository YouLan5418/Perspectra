export const STAGE_STYLE = String.raw`
/* Perspectra 默认舞台：黑白两色，跟随系统浅色／深色。
   颜色、字体、圆角都在下面两组变量里；包可以只提供 frontend/theme.css 覆盖它们（以及任意规则），
   不必复制整套页面。 */
:root{
  color-scheme:light;
  --bg:#f7f7f7;--surface:#ffffff;--surface-2:#efefef;
  --text:#111111;--muted:#555555;--faint:#8c8c8c;
  --say:#111111;--act:#5a5a5a;--narr:#333333;
  --accent:#111111;--accent-ink:#ffffff;
  --line:rgba(0,0,0,.09);--line-strong:rgba(0,0,0,.2);
  --shade:rgba(0,0,0,.06);--shadow:0 10px 30px rgba(0,0,0,.08);
  --danger:#333333;--veil:rgba(247,247,247,.78);--surface-glass:rgba(255,255,255,.93);
  --space-page:28px;--drawer-width:400px;--space-control:10px;
  --font-ui:"Segoe UI Variable Text","Segoe UI","PingFang SC","Microsoft YaHei UI","Microsoft YaHei",sans-serif;
  --font-story:"Noto Serif SC","Source Han Serif SC","Source Han Serif CN","Songti SC","STSong",serif;
  --radius:10px;--radius-lg:16px;
  --fs-story:19px;--story-line-height:1.9;
  --ease-out:cubic-bezier(0.16, 1, 0.3, 1);
  font:14px/1.6 var(--font-ui);
  background:var(--bg);color:var(--text);
}
@media(prefers-color-scheme:dark){:root:not([data-appearance="light"]){
  color-scheme:dark;
  --bg:#0d0d0d;--surface:#171717;--surface-2:#222222;
  --text:#f2f2f2;--muted:#b3b3b3;--faint:#7c7c7c;
  --say:#f5f5f5;--act:#a6a6a6;--narr:#d0d0d0;
  --accent:#f2f2f2;--accent-ink:#111111;
  --line:rgba(255,255,255,.09);--line-strong:rgba(255,255,255,.22);
  --shade:rgba(255,255,255,.06);--shadow:0 10px 30px rgba(0,0,0,.5);
  --danger:#eeeeee;--veil:rgba(13,13,13,.74);--surface-glass:rgba(23,23,23,.94);
}}
:root[data-appearance="dark"]{
  color-scheme:dark;
  --bg:#0d0d0d;--surface:#171717;--surface-2:#222222;
  --text:#f2f2f2;--muted:#b3b3b3;--faint:#7c7c7c;
  --say:#f5f5f5;--act:#a6a6a6;--narr:#d0d0d0;
  --accent:#f2f2f2;--accent-ink:#111111;
  --line:rgba(255,255,255,.09);--line-strong:rgba(255,255,255,.22);
  --shade:rgba(255,255,255,.06);--shadow:0 10px 30px rgba(0,0,0,.5);
  --danger:#eeeeee;--veil:rgba(13,13,13,.74);--surface-glass:rgba(23,23,23,.94);
}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--bg)}
button,input,textarea,select{font:inherit}
button,summary{cursor:pointer}
button{
  color:var(--text);border:1px solid var(--line-strong);background:var(--surface);
  border-radius:var(--radius);padding:8px 16px;
  transition:background .2s var(--ease-out),border-color .2s var(--ease-out),color .2s var(--ease-out);
}
button:hover:not(:disabled){background:var(--surface-2)}
button:active:not(:disabled){transform:scale(.98)}
button:disabled{opacity:.4;cursor:default;transform:none!important}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
textarea,select,input{
  color:var(--text);background:var(--surface);
  border:1px solid var(--line-strong);border-radius:var(--radius);padding:9px 12px;
}
textarea:focus,select:focus,input:focus{border-color:var(--accent)}
textarea{width:100%;resize:vertical;max-height:140px}
textarea::placeholder{color:var(--faint)}
p{margin:0}
main{height:100dvh;min-height:360px;overflow:hidden;position:relative;isolation:isolate}
.backdrop{position:absolute;inset:0;z-index:-1;background:var(--bg)}
.backdrop img{width:100%;height:100%;object-fit:cover}
.backdrop:after{content:"";position:absolute;inset:0;background:linear-gradient(var(--veil),transparent 40%,var(--veil))}

/* —— 常驻：地点、世界名、钉住的状态；右上角三个抽屉入口 —— */
.world-header{
  position:absolute;top:0;left:0;right:0;z-index:3;
  display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:24px var(--space-page);
}
.scene-heading{display:flex;gap:12px}
.scene-heading:before{content:"";width:2px;align-self:stretch;background:var(--accent)}
h2{font:600 22px/1.3 var(--font-story);margin:0;letter-spacing:.06em}
h1{font:12.5px/1.6 var(--font-story);color:var(--muted);margin:4px 0 0}
.status-bar{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:8px;font-size:12.5px;color:var(--muted)}
.status-group{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}
.status-group small{font-size:11.5px;letter-spacing:.1em;color:var(--faint)}
.status-item{min-width:0;overflow-wrap:anywhere}
.status-item strong{font-weight:600;color:var(--text)}
.stage-tools{display:flex;align-items:center;gap:6px}
.stage-tools button{font-size:12.5px;padding:6px 12px;border-radius:999px}
.stage-tools button[aria-expanded="true"]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
#action-count{display:inline-grid;place-items:center;min-width:18px;height:18px;margin-left:4px;padding:0 5px;border-radius:9px;font-size:11px;font-weight:600;color:var(--accent-ink);background:var(--accent)}
.stage-tools button[aria-expanded="true"] #action-count{color:var(--accent);background:var(--accent-ink)}
.status{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);padding:6px 6px 6px 0}
.status:before{content:"";width:7px;height:7px;border-radius:50%;border:1px solid var(--faint)}
.status[data-state="ready"]:before{background:var(--accent);border-color:var(--accent)}
.status[data-state="busy"]:before{background:var(--accent);border-color:var(--accent);animation:pulse 1.2s ease-in-out infinite}
.status[data-state="error"]:before{background:var(--danger);border-color:var(--danger)}
@keyframes pulse{50%{opacity:.25}}

/* —— 立绘：说话者完整显示，其他人淡一些；点立绘打开人物菜单 —— */
/* 取景：每张立绘按自己的头顶（--top）和腰部（--waist，都是占图片高度的比例）缩放，
   让头顶落在舞台 --head-y、腰部落在 --waist-y；腰部以下延伸到对话框后面或画面外。
   立绘不裁切，相邻的人可以互相遮一点；抽屉和活动卡片打开时立绘不移动。 */
#characters{
  position:absolute;inset:0 4%;display:flex;justify-content:center;pointer-events:none;
  --head-y:9%;--waist-y:78%;
}
.portrait{
  --top:.03;--waist:.48;--span:calc(var(--waist-y) - var(--head-y));
  position:relative;flex:0 1 26%;max-width:34%;height:100%;pointer-events:none;cursor:pointer;
  animation:appear .32s var(--ease-out);
}
.portrait.leaving{animation:leave .32s var(--ease-out) forwards}
@keyframes leave{to{opacity:0}}
.portrait.speaking{z-index:2}
.portrait img{
  position:absolute;left:50%;width:auto;max-width:none;pointer-events:auto;
  height:calc(var(--span) / (var(--waist) - var(--top)));
  top:calc(var(--head-y) - var(--span) * var(--top) / (var(--waist) - var(--top)));
  transform:translateX(-50%);transform-origin:center 20%;
  transition:filter .35s var(--ease-out),transform .35s var(--ease-out);
}
.portrait.speaking img{transform:translateX(-50%) scale(1.03)}
#characters:has(.speaking) .portrait:not(.speaking) img{filter:brightness(.78) saturate(.85)}
#characters:has(.speaking) .portrait:hover img,#characters:has(.speaking) .portrait:focus-visible img{filter:none}
.portrait:focus-visible{outline:none}
.portrait:focus-visible img,.portrait:focus-visible .portrait-badge{outline:1px dashed var(--accent);outline-offset:4px}
.portrait-badge{
  position:absolute;left:50%;top:calc(var(--head-y) + 4%);transform:translateX(-50%);width:min(70%,220px);aspect-ratio:4/5;pointer-events:auto;
  display:flex;align-items:flex-end;justify-content:center;padding-bottom:16%;font:600 30px/1 var(--font-story);color:var(--muted);
}
.portrait-badge:before{content:"";position:absolute;left:50%;top:6%;width:38%;aspect-ratio:1;transform:translateX(-50%);border-radius:50%;background:var(--surface-2);border:1px solid var(--line-strong)}
.portrait-badge:after{content:"";position:absolute;left:4%;right:4%;top:48%;bottom:0;z-index:-1;border-radius:48% 48% 8% 8%/60% 60% 6% 6%;background:var(--surface-2);border:1px solid var(--line-strong)}
.character-name{
  position:absolute;z-index:2;top:calc(var(--waist-y) - 16%);left:50%;transform:translateX(-50%);white-space:nowrap;pointer-events:auto;font:500 13px/1 var(--font-story);letter-spacing:.16em;padding:6px 14px;border-radius:999px;
  color:var(--muted);background:var(--surface);border:1px solid var(--line-strong);
}
.portrait.speaking .character-name{color:var(--accent-ink);background:var(--accent);border-color:var(--accent)}
.alone{align-self:center;pointer-events:auto;color:var(--faint);letter-spacing:.5em;font:16px var(--font-story)}
.character-menu,.audience-menu{
  background:var(--surface);border:1px solid var(--line-strong);border-radius:12px;box-shadow:var(--shadow);padding:6px;
}
.character-menu{position:fixed;z-index:30;width:220px;max-height:min(360px,60dvh);overflow:auto;display:flex;flex-direction:column;gap:2px}
.character-menu p{padding:6px 10px;font-size:11px;color:var(--faint);letter-spacing:.06em}
.character-menu button{width:100%;text-align:left;padding:8px 10px;border:0;border-radius:8px;background:transparent;font-size:13px}
.character-menu button:hover:not(:disabled),.character-menu button:focus-visible{background:var(--surface-2)}

/* —— 对话框：画面焦点。名牌反色，正文用宋体 —— */
.stage-bottom{
  position:absolute;bottom:24px;left:50%;transform:translateX(-50%);width:min(1000px,calc(100% - 56px));z-index:4;
  display:flex;flex-direction:column;gap:8px;transition:width .35s var(--ease-out),left .35s var(--ease-out);
}
.dialogue-wrap{position:relative;margin-top:16px;border:1px solid var(--line-strong);border-radius:var(--radius-lg);background:var(--surface-glass);backdrop-filter:blur(14px);box-shadow:var(--shadow)}
.dialogue-meta{position:absolute;top:-15px;left:24px;right:24px;display:flex;justify-content:space-between;align-items:center;gap:10px;pointer-events:none}
.speaker-label{font:600 15px/1 var(--font-story);letter-spacing:.14em;padding:8px 16px;border-radius:8px;color:var(--accent-ink);background:var(--accent)}
.reading-count{color:var(--faint);font-size:11.5px;padding:2px 10px;border-radius:999px;background:var(--surface);border:1px solid var(--line);margin-top:14px}
.dialogue{
  border:0;background:transparent!important;text-align:left;display:block;width:100%;min-height:96px;max-height:25dvh;overflow:auto;
  padding:32px 32px 14px;font:var(--fs-story)/var(--story-line-height) var(--font-story);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text);
}
.dialogue:active:not(:disabled){transform:none}
.dialogue.fade-in{animation:fadeIn .25s var(--ease-out)}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.dialogue .say{color:var(--say)}
.dialogue .act,.text .act{color:var(--act)}
.dialogue[data-type="narration"]{color:var(--narr)}
.dialogue-footer{display:flex;align-items:center;gap:4px;padding:2px 16px 12px 28px;color:var(--faint);font-size:12px}
.dialogue-footer>span{margin-right:auto}
.dialogue-footer>span:before{content:"▾";margin-right:8px;display:inline-block;animation:nudge 1.6s ease-in-out infinite}
@keyframes nudge{50%{transform:translateY(3px);opacity:.5}}
.dialogue-footer button{font-size:12px;padding:4px 12px;color:var(--muted);background:transparent;border-color:transparent;border-radius:999px}
.dialogue-footer button:hover:not(:disabled){color:var(--text);border-color:var(--line-strong)}
.dialogue-footer button.active{color:var(--accent-ink);background:var(--accent);border-color:var(--accent)}
.round-tools{display:flex;align-items:center;gap:4px;margin-left:6px;padding-left:10px;border-left:1px solid var(--line)}
.round-tools button{padding:4px 9px}
.round-tools span{font-size:11.5px;color:var(--muted)}
.auto-progress{position:absolute;left:28px;right:28px;bottom:6px;height:2px;background:var(--line);overflow:hidden}
.auto-progress-bar{height:100%;width:0%;background:var(--accent)}

/* —— 轮到玩家时的常驻一行：点开输入框，或静观 —— */
.reply-bar{display:flex;gap:8px}
.reply-bar #reply-open{flex:1;text-align:left;color:var(--faint);background:var(--surface);border-radius:999px;padding:10px 18px}
.reply-bar #reply-open:hover:not(:disabled){color:var(--muted)}
.reply-bar #reply-wait{border-radius:999px}

/* —— 输入框：一次点击展开 —— */
.composer{
  padding:14px 18px 12px;border:1px solid var(--line-strong);border-radius:var(--radius-lg);background:var(--surface);box-shadow:var(--shadow);
  max-height:62dvh;overflow:auto;scrollbar-width:thin;animation:rise .2s var(--ease-out);
}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.reply-context{border-left:2px solid var(--accent);padding:2px 0 2px 12px;margin:0 0 10px;color:var(--muted);cursor:pointer}
.reply-context span{font:600 12px var(--font-story);color:var(--text);letter-spacing:.1em}
.reply-context p{font:14px/1.7 var(--font-story);white-space:pre-wrap;overflow-wrap:anywhere;max-height:48px;overflow:auto;margin:4px 0 0}
.composer-body{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
.composer-main{min-width:0;display:flex;flex-direction:column}
.composer-main textarea#input{min-height:64px;flex:1;max-height:none}
.composer-footer{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px;font-size:11.5px;color:var(--faint)}
.composer-footer button,.composer-footer summary{white-space:nowrap}
main:has(.panel:not([hidden])) .composer-keys{display:none}
.composer-keys{margin-left:auto}
.composer-submit{display:flex;gap:8px}
#send{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);min-width:88px;font-weight:600}
#send:hover:not(:disabled){background:var(--accent);opacity:.88}
.audience-picker{position:relative}
.audience-button{display:inline-flex;align-items:center;gap:8px;padding:5px 12px 5px 10px;border-radius:999px;font-size:12.5px}
.audience-button[aria-expanded="true"]{border-color:var(--accent)}
.audience-button .chevron{font-size:9px;color:var(--faint)}
.audience-dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
.audience-picker:has(input[value="direct"]:checked) .audience-dot{background:transparent;border:2px solid var(--accent)}
.audience-picker:has(input[value="private"]:checked) .audience-dot{background:transparent;border:2px dashed var(--accent)}
.audience-picker:has(input[value="self"]:checked) .audience-dot{background:var(--faint)}
.audience-menu{position:absolute;left:0;bottom:calc(100% + 8px);z-index:20;width:236px}
.audience-options{display:grid;gap:2px;border:0;padding:0;margin:0}
.audience-options legend{padding:6px 10px;font-size:11px;color:var(--faint)}
.audience-options label{position:relative;display:grid;grid-template-columns:auto 1fr;column-gap:10px;align-items:center;padding:8px 10px;border-radius:8px;cursor:pointer}
.audience-options label:hover,.audience-options label:has(input:checked){background:var(--surface-2)}
.audience-options input{grid-row:1/3;margin:0;accent-color:var(--accent)}
.audience-options span{font-size:13px;font-weight:600}
.audience-options small{grid-column:2;font-size:11.5px;color:var(--faint)}
.audience-options label:after{
  content:attr(data-tip);position:absolute;left:calc(100% + 12px);top:50%;transform:translateY(-50%);width:220px;padding:8px 12px;border-radius:8px;
  font-size:12px;line-height:1.6;color:var(--text);background:var(--surface);border:1px solid var(--line-strong);box-shadow:var(--shadow);opacity:0;pointer-events:none;
}
.audience-options label:hover:after{opacity:1}
#recipient-panel{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
#recipient-panel select{max-width:160px;padding:4px 10px;border-radius:999px;font-size:12.5px}
#recipient-panel .hint{white-space:nowrap}
.narration-composer{display:flex;align-items:center;gap:8px;min-width:0}
.narration-composer[open]{flex:1}
.narration-composer[open]::details-content{display:contents}
.narration-composer summary{
  flex-shrink:0;list-style:none;user-select:none;padding:5px 12px;border-radius:999px;border:1px solid var(--line-strong);font-size:12.5px;color:var(--muted);
}
.narration-composer summary::-webkit-details-marker{display:none}
.narration-composer summary:before{content:"+ "}
.narration-composer[open] summary{color:var(--accent-ink);background:var(--accent);border-color:var(--accent)}
.narration-composer[open] summary:before{content:"− "}
.narration-composer textarea{flex:1;min-width:0;height:34px;min-height:34px;max-height:34px;resize:none;overflow:hidden;padding:6px 12px;border-radius:999px;white-space:nowrap;font-size:13px;line-height:20px}
.composer-footer:has(.narration-composer[open]) .composer-keys{display:none}
.attached-action{display:inline-flex;align-items:center;gap:6px;padding:3px 4px 3px 10px;border-radius:999px;background:var(--surface-2);font-size:12px;min-width:0}
.attached-action #attached-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
.attached-action select{padding:2px 6px;border-radius:999px;font-size:11.5px}
.attached-action button{padding:0 7px;border-radius:999px;line-height:1.6}
.expression-choices{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.expression-choices:empty{display:none}
.expression-choices button{font:15px var(--font-story);text-align:left}
.feedback{font-size:12.5px;color:var(--muted)}
.feedback:has(#notice:not(:empty)){display:flex;align-items:center;gap:10px;padding:8px 16px;background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius)}
#retry{font-size:12px;padding:4px 12px;margin-left:auto}


/* —— 抽屉：记录、行动、状态都从右侧滑出，同一时间只开一个；打开时对话区让出抽屉的宽度 —— */
main:has(.panel:not([hidden])) .stage-bottom{left:calc((100% - var(--drawer-width) - 24px) / 2);width:min(1000px,calc(100% - var(--drawer-width) - 80px))}
.panel{
  position:absolute;z-index:7;top:80px;right:12px;bottom:12px;width:min(var(--drawer-width),calc(100% - 24px));display:flex;flex-direction:column;
  background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius-lg);box-shadow:var(--shadow);animation:slide .22s var(--ease-out);
}
@keyframes slide{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}
.panel-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line);font:600 15px var(--font-story);letter-spacing:.08em}
.panel-header button{padding:2px 10px;font-size:16px;border-color:transparent;background:transparent}
.panel-body{flex:1;min-height:0;overflow:auto;scrollbar-width:thin}
#history{flex:1;min-height:0;overflow:auto;padding:20px;scrollbar-width:thin}
.line{display:flex;gap:12px;margin-bottom:18px}
.avatar{display:grid;place-items:center;flex-shrink:0;width:30px;height:30px;border-radius:50%;font:600 13px var(--font-story);color:var(--text);background:var(--surface-2);border:1px solid var(--line-strong)}
.player .avatar{color:var(--accent-ink);background:var(--accent);border-color:var(--accent)}
.message{min-width:0}
.speaker{font:600 12.5px var(--font-story);letter-spacing:.08em;color:var(--muted)}
.text{font:calc(var(--fs-story) - 2px)/var(--story-line-height) var(--font-story);white-space:pre-wrap;overflow-wrap:anywhere}
.empty-history{color:var(--muted);padding:24px}
.empty-history strong{display:block;margin-bottom:6px;font-family:var(--font-story)}
#latest{align-self:center;margin:8px 0 14px;font-size:12px;border-radius:999px}
#actions{flex:1;min-height:0;overflow:auto}
.action-group{padding:14px 18px 6px}
.action-group h3,.status-section h3{font-size:11.5px;font-weight:600;letter-spacing:.1em;color:var(--faint);margin:0 0 4px}
.action-group button{display:flex;justify-content:space-between;align-items:center;width:100%;text-align:left;margin:6px 0;font-size:13px;overflow-wrap:anywhere}
.action-group button span:last-child{color:var(--faint)}
.action-group select{width:100%}
.action-form{display:flex;flex-direction:column;gap:6px;margin:6px 0;padding:8px 10px;border:1px solid var(--line);border-radius:var(--radius)}
.action-form label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted)}
.action-form label:has(input[type="checkbox"]){flex-direction:row;align-items:center;gap:8px}
.action-form input:not([type="checkbox"]),.action-form textarea{width:100%}
.no-actions,.empty-status{padding:20px;color:var(--muted)}
.status-section{padding:14px 20px 4px}
.status-section dl{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 14px;font-size:13px}
.status-section dt{color:var(--muted)}
.status-section dd{margin:0;overflow-wrap:anywhere}
.hint{font-size:11.5px;color:var(--faint)}

/* —— 进行中的活动：舞台左侧的卡片，可折叠 —— */
.activity-card{
  position:absolute;z-index:4;top:120px;left:28px;width:300px;max-height:max(150px,calc(100% - 460px));overflow:auto;padding:14px 16px;
  background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius-lg);box-shadow:var(--shadow);
}
.activity-heading{display:grid;grid-template-columns:1fr auto;gap:2px 8px;width:100%;padding:0;border:0;background:transparent!important;text-align:left}
.activity-heading small{font-size:11px;letter-spacing:.1em;color:var(--faint)}
.activity-heading strong{grid-column:1;font:600 16px/1.4 var(--font-story);overflow-wrap:anywhere}
.activity-heading span{grid-column:2;grid-row:1/3;align-self:center;font-size:12px;color:var(--muted)}
#activity-body{margin-top:10px;display:flex;flex-direction:column;gap:10px}
#activity-objective{font:14px/1.7 var(--font-story);color:var(--muted)}
#activity-state{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:0}
#activity-state div{padding:6px 10px;border:1px solid var(--line);border-radius:var(--radius)}
#activity-state dt{font-size:11px;color:var(--faint)}
#activity-state dd{margin:0;font-weight:600;overflow-wrap:anywhere}
#activity-options{display:flex;flex-direction:column;gap:6px}
#activity-options>button,#activity-options .action-form button{width:100%;text-align:left}
.activity-manage{display:flex;flex-wrap:wrap;gap:6px}
.activity-manage:empty{display:none}
.activity-manage button{font-size:12px;padding:4px 10px;color:var(--muted)}

/* —— 其余 —— */
.stage-notifications{position:absolute;top:110px;left:50%;transform:translateX(-50%);z-index:5;display:flex;flex-direction:column;align-items:center;gap:8px;max-width:80%;pointer-events:none}
.movement-toast{
  padding:8px 22px;max-width:100%;text-align:center;overflow-wrap:anywhere;
  background:var(--surface);border:1px solid var(--line-strong);border-radius:999px;font:15px var(--font-story);letter-spacing:.14em;box-shadow:var(--shadow);
}
.settings-body{padding:24px}
.settings-intro{font:15px/1.8 var(--font-story);color:var(--muted);margin-bottom:26px}
.settings-body fieldset{border:0;border-top:1px solid var(--line);padding:18px 0 24px;margin:0;min-width:0}
.settings-body legend{font-size:12px;letter-spacing:.15em;padding:0 12px 0 0;color:var(--muted)}
.setting-range{display:grid;grid-template-columns:1fr auto;gap:10px;margin:0 0 20px;font-size:13px}
.setting-range output{font-size:12px;font-variant-numeric:tabular-nums;color:var(--muted)}
.setting-range input{grid-column:1/-1;width:100%;padding:0;accent-color:var(--accent);cursor:pointer;min-height:24px}
.setting-check{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:14px 0;font-size:13px}
.setting-check small{display:block;color:var(--faint);font-size:11.5px;margin-top:2px}
.setting-check input{accent-color:var(--accent);width:18px;height:18px;flex-shrink:0;cursor:pointer}
.appearance-options{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.appearance-options label{position:relative;cursor:pointer}
.appearance-options input{position:absolute;opacity:0;width:1px;height:1px}
.appearance-options span{display:block;padding:9px 4px;border:1px solid var(--line-strong);border-radius:var(--radius);font-size:12px;text-align:center}
.appearance-options input:checked+span{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.appearance-options input:focus-visible+span{outline:2px solid var(--accent);outline-offset:3px}
.save-entry{display:flex;justify-content:space-between;width:100%;margin-top:14px;text-align:left}
.save-dialog{color:var(--text);background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius-lg);box-shadow:var(--shadow);width:min(440px,calc(100% - 32px));max-height:90dvh;overflow:auto;padding:28px}
.save-dialog::backdrop{background:rgba(0,0,0,.4);backdrop-filter:blur(5px)}
.save-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.eyebrow{font-size:11px;letter-spacing:.2em;color:var(--faint)}
.save-heading button{padding:2px 9px;border:0;background:transparent;font-size:20px}
.save-dialog h2{font-size:26px;margin:0 0 12px}
.save-dialog label{display:block;font-size:12px;color:var(--muted);margin:24px 0 8px}
.save-dialog input{width:100%}
#save-result{min-height:42px;padding:12px 0;overflow-wrap:anywhere}
.save-dialog[data-state="error"] #save-result{font-weight:600;color:var(--text)}
.save-dialog[data-state="success"] #save-result{font:16px/1.8 var(--font-story);color:var(--text)}
.save-buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.primary:hover:not(:disabled){background:var(--accent);opacity:.85}
.visually-hidden{position:absolute;clip:rect(0,0,0,0);width:1px;height:1px;overflow:hidden}
@keyframes appear{from{opacity:0}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media(min-width:1500px){.stage-bottom{bottom:32px}}
@media(min-width:641px) and (max-width:1000px){:root{--drawer-width:340px}.world-header{gap:10px;padding:18px}.stage-tools{gap:2px;flex-wrap:wrap;justify-content:flex-end;max-width:360px}.status{width:100%;justify-content:flex-end}.panel{top:100px}main:has(.panel:not([hidden])) .stage-bottom{width:calc(100% - var(--drawer-width) - 48px)}.composer-keys{display:none}}
@media(max-width:640px){
  main{min-height:360px}
  .activity-card{top:156px;left:12px;right:12px;width:auto;max-height:27dvh}
  .world-header{padding:16px 16px 10px;flex-direction:column;gap:12px}
  h2{font-size:18px}h1{font-size:11px;max-width:170px}
  .scene-heading{max-width:100%}.scene-heading>div{min-width:0}
  .stage-tools{flex-wrap:wrap;justify-content:flex-end;width:100%;max-width:none;gap:4px}
  .status{margin-right:auto;max-width:100%;font-size:11px;padding-right:0}
  .stage-tools button{padding:7px 9px;font-size:11.5px;min-height:34px}
  #characters{inset:0;--head-y:20%;--waist-y:74%}
  .portrait{min-width:0}
  .character-name{font-size:11px;padding:4px 10px;letter-spacing:.08em}
  .stage-bottom{width:calc(100% - 24px);bottom:12px}
  main:has(.panel:not([hidden])) .stage-bottom{left:50%;width:calc(100% - 24px)}
  .dialogue{padding:24px 16px 6px;min-height:80px;max-height:24dvh;font-size:calc(var(--fs-story) - 1px)}
  .dialogue-footer{padding:2px 10px 10px 16px;flex-wrap:wrap}
  .dialogue-footer>span{width:100%}
  .composer{padding:12px}
  .composer-main textarea#input{max-height:24dvh;min-height:60px}
  .composer-keys{display:none}
  .composer-footer{flex-wrap:wrap}
  .narration-composer[open]{order:5;flex-basis:100%}
  .composer-submit{margin-left:auto}
  .audience-options label:after{left:8px;right:8px;top:auto;bottom:calc(100% + 6px);width:auto;transform:none}
  .panel{top:auto;right:0;bottom:0;height:min(78dvh,640px);width:100%;border-width:1px 0 0;border-radius:var(--radius-lg) var(--radius-lg) 0 0}
  .panel-header{padding:14px 18px}.panel-header button{min-height:36px;min-width:36px}
  .stage-notifications{top:150px;width:max-content;max-width:90%}
  .movement-toast{font-size:13px;letter-spacing:.06em;padding:8px 16px}
  .settings-body{padding:20px}
  @keyframes slide{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}
}
`
