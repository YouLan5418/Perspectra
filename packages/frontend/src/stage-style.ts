import { COMPONENT_STYLE } from './stage-components.ts'
import { PARTICIPANT_PICKER_STYLE } from './participant-picker.ts'

export const STAGE_STYLE = String.raw`
${PARTICIPANT_PICKER_STYLE}
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
.status-bar{
  display:inline-flex;align-items:center;gap:8px;max-width:100%;min-height:38px;margin-top:8px;
  padding:4px 10px;border-radius:999px;background:var(--surface-glass);font-size:12.5px;
}
.status-bar[aria-expanded="true"]{outline:1px solid var(--accent);outline-offset:1px}
.status-bar:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.status-preview-list,.status-preview{display:flex;align-items:baseline;min-width:0;gap:7px}
.status-preview{gap:4px;padding-left:8px;border-left:1px solid var(--line-strong);color:var(--muted)}
.status-preview span,.status-preview strong{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.status-preview span{max-width:8em}
.status-preview strong{max-width:11em;color:var(--text);font-weight:650;font-variant-numeric:tabular-nums}
.status-chevron,.status-cut{color:var(--muted);white-space:nowrap}
.status-cut{font-size:11px}
.status-bar[aria-expanded="true"] .status-chevron{transform:rotate(180deg)}
.stage-tools{display:flex;align-items:center;gap:6px}
.stage-tools button{font-size:12.5px;padding:6px 12px;border-radius:999px}
.stage-tools button[aria-expanded="true"]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
/* Pinned above the story area, so it stays in view while reading and while replying. */
.status{position:absolute;right:0;bottom:calc(100% + 6px);display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);padding:5px 12px;border:1px solid var(--line);border-radius:999px;background:var(--surface-glass);backdrop-filter:blur(10px)}
.status:before{content:"";width:7px;height:7px;border-radius:50%;border:1px solid var(--faint)}
.status[data-state="ready"]:before{background:var(--accent);border-color:var(--accent)}
.status[data-state="busy"]:before{width:9px;height:9px;box-sizing:border-box;border:1.5px solid var(--faint);border-top-color:var(--accent);animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.status[data-state="error"]:before{background:var(--danger);border-color:var(--danger)}

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
  position:relative;flex:0 1 26%;max-width:34%;height:100%;pointer-events:none;
  animation:appear .32s var(--ease-out);
}
.portrait.leaving{animation:leave .32s var(--ease-out) forwards}
@keyframes leave{to{opacity:0}}
.portrait.speaking{z-index:2}
/* 一个人物 = 底图（或姿势图）+ 表情层；缩放和定位都在人物上，表情层跟着底图走。 */
.figure{
  position:absolute;left:50%;pointer-events:none;
  height:calc(var(--span) / (var(--waist) - var(--top)));
  top:calc(var(--head-y) - var(--span) * var(--top) / (var(--waist) - var(--top)));
  transform:translateX(-50%);transform-origin:center 20%;
  transition:filter .35s var(--ease-out),transform .35s var(--ease-out);
}
.figure .base{display:block;height:100%;width:auto;max-width:none}
/* 同尺寸图层铺满底图；贴片按框放；拼合图的一格用背景定位显示，不必真的裁开 */
.figure .layer{position:absolute;inset:0;width:100%;height:100%}
.figure .patch{position:absolute;background-repeat:no-repeat}
.figure img.patch{object-fit:fill}
.portrait.speaking .figure{transform:translateX(-50%) scale(1.03)}
#characters:has(.speaking) .portrait:not(.speaking) .figure{filter:brightness(.78) saturate(.85)}
.portrait-badge{
  position:absolute;left:50%;top:calc(var(--head-y) + 4%);transform:translateX(-50%);width:min(70%,220px);aspect-ratio:4/5;pointer-events:none;
  display:flex;align-items:flex-end;justify-content:center;padding-bottom:16%;font:600 30px/1 var(--font-story);color:var(--muted);
}
.portrait-badge:before{content:"";position:absolute;left:50%;top:6%;width:38%;aspect-ratio:1;transform:translateX(-50%);border-radius:50%;background:var(--surface-2);border:1px solid var(--line-strong)}
.portrait-badge:after{content:"";position:absolute;left:4%;right:4%;top:48%;bottom:0;z-index:-1;border-radius:48% 48% 8% 8%/60% 60% 6% 6%;background:var(--surface-2);border:1px solid var(--line-strong)}
.character-name{
  position:absolute;z-index:2;bottom:max(calc(100% - var(--waist-y) + 16% - var(--nameplate-height,32px)),calc(100% - var(--nameplate-floor,100%)));left:50%;transform:translateX(-50%);white-space:nowrap;pointer-events:auto;font:500 13px/1 var(--font-story);letter-spacing:.16em;padding:6px 14px;border-radius:999px;
  color:var(--muted);background:var(--surface);border:1px solid var(--line-strong);
}
.character-name{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:32px}
.character-name::after{content:"";width:6px;height:6px;box-sizing:border-box;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-1px) rotate(45deg)}
.character-name[aria-expanded="true"]::after{transform:translateY(2px) rotate(225deg)}
.character-name:focus-visible{outline:2px solid var(--text);outline-offset:3px}
.character-name:active:not(:disabled){transform:translateX(-50%)}
@media(pointer:coarse){.character-name{--nameplate-height:44px;min-width:44px;min-height:44px}}
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
.stage-action-bar{
  position:absolute;bottom:calc(100% + 6px);left:0;z-index:1;display:flex;align-items:center;gap:5px;
}
.stage-action-bar button{
  flex:none;min-height:38px;padding:5px 12px;font-size:13px;border-radius:999px;background:var(--surface-glass);
  backdrop-filter:blur(10px);white-space:nowrap;
}
.stage-action-bar button:hover:not(:disabled):not([aria-expanded="true"]){background:var(--surface)}
#actions-toggle{font-weight:650;border-color:var(--line-strong)}
.stage-action-bar button[aria-expanded="true"]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
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
.dialogue-footer button{font-size:12px;padding:4px 12px;color:var(--muted);background:transparent;border-color:transparent;border-radius:999px}
.dialogue-footer button:hover:not(:disabled){color:var(--text);border-color:var(--line-strong)}
.dialogue-footer #pickup-item,.pickup-history{color:var(--text);border:1px solid var(--line-strong);border-radius:999px;padding:4px 12px;font-size:13px}
.pickup-history{margin-top:6px}
.dialogue-footer button.active{color:var(--accent-ink);background:var(--accent);border-color:var(--accent)}
.round-tools{display:flex;align-items:center;gap:4px;margin-left:6px;padding-left:10px;border-left:1px solid var(--line)}
.round-tools button{padding:4px 9px}
.round-tools span{font-size:11.5px;color:var(--muted)}
.auto-progress{position:absolute;left:28px;right:28px;bottom:6px;height:2px;background:var(--line);overflow:hidden}
.auto-progress-bar{height:100%;width:0%;background:var(--accent)}

/* —— 轮到玩家时的常驻一行：点开输入框，或静观 —— */
.reply-bar{display:flex;gap:8px}
.reply-bar #reply-open{flex:1;text-align:left;color:var(--muted);background:var(--surface);border:1px solid var(--line-strong);border-radius:999px;padding:10px 18px}
.reply-bar #reply-open:hover:not(:disabled){color:var(--text);background:var(--surface-2)}
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
.audience-button{display:inline-flex;align-items:center;gap:8px;padding:5px 12px 5px 10px;border-radius:999px;font-size:12.5px}
.audience-button[aria-expanded="true"]{border-color:var(--accent)}
.audience-button .chevron{font-size:9px;color:var(--faint)}
.audience-dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
.audience-picker:has(input[value="direct"]:checked) .audience-dot{background:transparent;border:2px solid var(--accent)}
.audience-picker:has(input[value="private"]:checked) .audience-dot{background:transparent;border:2px dashed var(--accent)}
.audience-picker:has(input[value="self"]:checked) .audience-dot{background:var(--faint)}
/* Placed against .stage-bottom by the script: the composer scrolls and would clip a menu opening upward. */
.audience-menu{position:absolute;z-index:20;width:236px;overflow:auto}
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
.feedback:has(:is(#notice,#host-notice):not(:empty)),.feedback:has(.request-feedback:not([hidden])){display:flex;align-items:center;gap:10px;padding:0 28px 6px}
.composer .feedback:has(:is(#notice,#host-notice):not(:empty)),.composer .feedback:has(.request-feedback:not([hidden])){padding:8px 0 0}
:is(#notice,#host-notice){margin:0;min-width:0;overflow-wrap:anywhere}
.feedback :is(#notice,#host-notice):empty{display:none}
.request-feedback{
  width:100%;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px;
  background:var(--surface-2);border-left:2px solid var(--line-strong);border-radius:8px;padding:8px 10px;
}
.request-feedback[data-kind="unknown"]{border-color:var(--accent)}
.request-copy{min-width:0;flex:1 1 245px;overflow-wrap:anywhere}
.request-copy strong{display:block;color:var(--text);font-weight:650}
.request-copy p{line-height:1.5}
.request-controls{display:flex;flex-wrap:wrap;gap:5px}
.request-controls button{min-height:36px;padding:4px 10px;font-size:12px}
@media(max-width:640px){.request-controls button{min-height:44px}}


/* 标准面板互斥。状态与行动采用覆盖式打开，保留对白及编辑器的位置。 */
main:has(.panel:not(.action-panel):not(.status-panel):not([hidden])) .stage-bottom{left:calc((100% - var(--drawer-width) - 24px) / 2);width:min(1000px,calc(100% - var(--drawer-width) - 80px))}
.panel{
  position:absolute;z-index:7;top:80px;right:12px;bottom:12px;width:min(var(--drawer-width),calc(100% - 24px));display:flex;flex-direction:column;
  background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius-lg);box-shadow:var(--shadow);animation:slide .22s var(--ease-out);
}
@keyframes slide{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}
.panel.status-panel{
  top:140px;left:var(--space-page);right:auto;bottom:auto;
  width:min(375px,calc(100% - 2 * var(--space-page)));max-height:calc(100% - 154px);
}
.status-read-note{margin:14px 20px 0;padding:8px 10px;border-radius:8px;background:var(--surface-2);color:var(--muted);font-size:13px}
.status-panel .panel-body{overscroll-behavior:contain;padding-bottom:12px}
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
.index-filters{padding:12px 16px;border-bottom:1px solid var(--line);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}
.index-filters :is(input,select){min-width:0;min-height:42px;font-size:14px}
.index-filters p{grid-column:1/-1}
.index-counter{flex:none;max-height:46%;overflow:auto;padding:8px 16px;border-top:1px solid var(--line);font-size:14px}
.index-counter p{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.index-counter summary,.index-counter button{cursor:pointer}
.index-form{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.index-counter :is(select,input){min-width:0;min-height:36px;max-width:100%}
.index-counter input{flex:1 1 12ch}
#actions{overscroll-behavior:contain;padding-bottom:10px}
#actions .action-group{padding:10px 16px 4px}
#actions .action-group h3{margin:4px 0 8px;font-size:13px;color:var(--muted)}
.index-option{margin:0 0 6px;border:1px solid var(--line);border-radius:10px;padding:4px 8px;overflow-wrap:anywhere}
.index-option button{margin:0;min-height:37px;border:0;background:transparent;font-size:14px;color:var(--text)}
.index-option button:hover:not(:disabled){background:var(--surface-2)}
.index-option summary{min-height:37px;padding:7px 6px;cursor:pointer;font-weight:600}
.index-option[open] .index-option-body{padding:4px 6px 8px}
.index-option-detail,.index-option-hint{display:block;margin:2px 6px;color:var(--muted);font-size:12px}
.index-browse{display:flex;flex-wrap:wrap;gap:6px;padding:12px 16px}
.index-browse button{font-size:13px;min-height:42px}
.action-panel .panel-header button{min-width:42px;min-height:42px}
#action-empty{padding-block:12px}
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

/* Inventory is a view of authorized items, with the author's existing action controls. */
.inventory-section{padding:18px 20px 4px}
.inventory-section h3{margin:0 0 12px;font-size:11.5px;font-weight:600;letter-spacing:.1em;color:var(--muted)}
.inventory-item{margin-bottom:10px;border:1px solid var(--line-strong);border-radius:var(--radius);overflow:hidden}
.inventory-item summary{cursor:pointer;padding:14px 16px;overflow-wrap:anywhere}
.inventory-item summary strong{font:600 15px var(--font-story)}
.inventory-item summary small{display:block;margin:6px 0 0 16px;font-size:11.5px;color:var(--muted)}
.inventory-item[open] summary{border-bottom:1px solid var(--line)}
.inventory-item-body{padding:12px 16px}
.inventory-description{margin:0;font-size:13px;line-height:1.8;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.inventory-actions{padding:6px 0 0}
.inventory-actions .action-form{margin-bottom:8px}
.inventory-actions .hint{margin:8px 0 0}

/* —— 进行中的活动：舞台左侧的卡片，可折叠；右下角可拖动调整大小 —— */
.activity-card{
  position:absolute;z-index:4;top:120px;left:28px;width:300px;max-height:max(150px,calc(100% - 460px));overflow:auto;padding:14px 16px;
  background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius-lg);box-shadow:var(--shadow);
  resize:both;min-width:240px;min-height:96px;max-width:calc(100% - 56px);
}
.activity-heading{display:grid;grid-template-columns:minmax(10em,1fr) minmax(0,auto);gap:2px 8px;width:100%;padding:0;border:0;background:transparent!important;text-align:left}
.activity-heading small{font-size:11px;letter-spacing:.1em;color:var(--faint)}
.activity-heading strong{grid-column:1;font:600 16px/1.4 var(--font-story);overflow-wrap:anywhere}
.activity-heading span{grid-column:2;grid-row:1/3;align-self:center;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
#activity-body{margin-top:10px;display:flex;flex-direction:column;gap:10px}
#activity-objective{font:14px/1.7 var(--font-story);color:var(--muted)}
#activity-rules{font:13px/1.6 var(--font-story);color:var(--muted)}
#activity-rules summary{cursor:pointer}
#activity-instructions{margin-top:6px;white-space:pre-wrap;overflow-wrap:anywhere}
#activity-state{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:0}
#activity-state div{padding:6px 10px;border:1px solid var(--line);border-radius:var(--radius)}
#activity-state dt{font-size:11px;color:var(--faint)}
#activity-state dd{margin:0;font-weight:600;overflow-wrap:anywhere}
#activity-state div.own{border-color:var(--accent)}
#activity-state div.own dt:after{content:" · 只有你知道"}
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
.message-body{display:flex;flex-direction:column;gap:8px;padding:20px}
.message-body label{font-size:12px;color:var(--muted)}
.message-body select,.message-body textarea{width:100%}
.message-body textarea{resize:vertical;min-height:96px}
.message-body .primary{align-self:flex-end;min-width:96px}
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
@media(min-width:641px) and (max-width:1000px){:root{--drawer-width:340px}.world-header{gap:10px;padding:18px}.stage-tools{gap:2px;flex-wrap:wrap;justify-content:flex-end;max-width:360px}.panel{top:100px}main:has(.panel:not(.action-panel):not(.status-panel):not([hidden])) .stage-bottom{width:calc(100% - var(--drawer-width) - 48px)}.composer-keys{display:none}}
@media(max-width:640px){
  main{min-height:360px}
  .activity-card{top:188px;left:12px;right:12px;width:auto!important;min-width:0;max-width:none;max-height:27dvh;resize:vertical}
  .world-header{padding:16px 16px 10px;flex-direction:column;gap:12px}
  h2{font-size:18px}h1{font-size:11px;max-width:170px}
  .scene-heading{max-width:100%}.scene-heading>div{min-width:0}
  .stage-tools{flex-wrap:wrap;justify-content:flex-end;width:100%;max-width:none;gap:4px}
  .status{font-size:11px}
  .status-bar{min-height:44px}
  .status-preview:nth-child(n+2){display:none}
  .status-preview strong{max-width:8em}
  .panel.status-panel{top:auto;right:0;bottom:0;left:0;width:100%;height:min(58dvh,500px);max-height:none}
  #status-close{min-width:44px;min-height:44px}
  .stage-action-bar{gap:4px}
  .stage-action-bar button{min-height:44px;padding:5px 9px}
  .index-option button,.index-option summary,.index-browse button{min-height:44px}
  .stage-tools button{padding:7px 9px;font-size:11.5px;min-height:34px}
  #characters{inset:0;--head-y:20%;--waist-y:74%}
  .portrait{min-width:0}
  .character-name{font-size:11px;padding:4px 10px;letter-spacing:.08em}
  .stage-bottom{width:calc(100% - 24px);bottom:12px}
  main:has(.panel:not(.action-panel):not(.status-panel):not([hidden])) .stage-bottom{left:50%;width:calc(100% - 24px)}
  .dialogue{padding:24px 16px 6px;min-height:80px;max-height:24dvh;font-size:calc(var(--fs-story) - 1px)}
  .dialogue-footer{padding:2px 10px 10px 16px;flex-wrap:wrap}
  .dialogue-wrap .feedback{padding-left:16px!important;padding-right:10px!important}
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

#gameplay-panels{padding:0 20px}
.gameplay-panel{padding:16px 0;border-top:1px solid var(--line);min-width:0}
.gameplay-panel h3{font:600 15px var(--font-story);margin:0 0 12px}
.gameplay-properties{display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,2fr);gap:8px 16px;margin:0}
.gameplay-properties dt{color:var(--muted)}.gameplay-properties dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
.gameplay-entries{list-style:none;padding:0;margin:0}.gameplay-entries li+li{border-top:1px solid var(--line);margin-top:12px;padding-top:12px}
.gameplay-entries p{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
#gameplay-controls select{max-width:45%;min-width:85px}
.action-form input:focus-visible,.action-form select:focus-visible,.action-form textarea:focus-visible,#gameplay-controls input:focus-visible,#gameplay-controls select:focus-visible{outline:2px solid var(--text);outline-offset:2px}
@media(max-width:480px){.gameplay-properties{grid-template-columns:minmax(70px,1fr) minmax(0,2fr);gap:8px}.gameplay-panel h3{font-size:14px}}
/* Let an open drawer scroll independently; focusing the stage again must not scroll its outer canvas. */
main:is([data-mode="reading"],[data-mode="response"]):has(+ #activity-stage[hidden]):not(:has(.panel:not([hidden]))){overflow:clip}
/* Keep the story as the primary surface. Secondary reading controls share its footer. */
#dialogue{user-select:text;-webkit-user-select:text;touch-action:pan-y pinch-zoom;overscroll-behavior:contain}
#dialogue-wrap:has(#dialogue[role="button"]){cursor:pointer}
#dialogue-text{cursor:text}
#dialogue:focus-visible{outline:2px solid var(--accent);outline-offset:-3px;border-radius:var(--radius-lg)}
#dialogue-wrap .dialogue-footer{justify-content:flex-end;padding-right:50px}
.dialogue-footer:has(#pickup-item[hidden]):has(#auto-read[hidden]):has(.round-tools[hidden]){display:none}
#read-arrow{position:absolute;bottom:6px;right:9px;width:32px;height:32px;display:grid;place-items:center;cursor:pointer;z-index:1}
#read-arrow::after{content:"";width:8px;height:8px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:translateY(-2px) rotate(45deg)}
#dialogue-wrap #feedback{cursor:default}
@media(prefers-reduced-motion:reduce){#dialogue.fade-in{animation:none}}
#composer .reply-context{display:flex;align-items:baseline;gap:10px;min-width:0}
#reply-speaker{flex:none;max-width:40%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#reply-summary{min-width:0;flex:1;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* A single focusable audience control stays in tab order even in the collapsed capsule. */
#composer .composer-footer{align-items:center;min-width:0}
#composer .composer-more{order:0;flex:none;margin-right:0}
#composer .composer-footer:has(#attached-action:not([hidden])) #attached-action{order:-1;flex-basis:100%}
#send-cluster{position:relative;isolation:isolate;order:4;min-width:0;max-width:100%;margin-left:auto;flex:0 1 auto;display:flex;align-items:center;justify-content:flex-end;flex-wrap:nowrap;gap:0;border-radius:999px}
#send-cluster .composer-submit{order:1;margin:0;flex:none}
#send-cluster #send{display:grid;place-items:center;width:44px;height:44px;min-width:44px;padding:0;border-radius:50%}
#send-cluster::before{content:'';display:block;position:absolute;inset:0;border:1px solid var(--line-strong);border-radius:999px;background:var(--surface-2);z-index:-1;pointer-events:none;opacity:0}
#send-cluster[data-expanded="true"]::before{opacity:1;animation:audience-open .16s ease-out both}
@keyframes audience-open{from{clip-path:inset(0 0 0 calc(100% - 44px) round 22px)}to{clip-path:inset(0 round 22px)}}
#send-cluster #audience-inline{display:flex;align-items:center;min-width:0;min-height:44px;height:44px;flex:initial;order:0;flex-wrap:nowrap;margin:0;padding:0 2px 0 4px;border:0;background:transparent}
#send-cluster[data-expanded="false"] #audience-inline{position:absolute;right:100%;width:1px;height:1px;min-height:0;overflow:hidden;clip-path:inset(50%);padding:0;pointer-events:none}
#send-cluster .audience-picker{min-width:0;max-width:100%}
#send-cluster .audience-button{max-width:100%;min-width:0;height:42px;padding:6px 10px;border:0;background:transparent}
#audience-badge{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#audience-menu{width:min(292px,calc(100vw - 16px));overscroll-behavior:contain}
#audience-menu #recipient-panel{margin:8px 6px 0;flex-wrap:wrap}
#audience-menu #speech-recipient{flex:1;min-width:70px;max-width:100%;font:inherit}
#audience-menu #recipient-hint{white-space:normal}
#audience-detail{margin:10px 6px;font-size:13px;color:var(--muted);overflow-wrap:anywhere}
#audience-done{margin:2px 6px;padding:5px 12px}
#send-cluster button:focus-visible,#audience-menu button:focus-visible{outline:2px solid var(--text);outline-offset:1px}
@media(max-width:640px){
  #send-cluster{max-width:calc(100% - 64px)}
  #send-cluster #audience-inline{height:auto}
  #send-cluster .audience-button{height:auto;min-height:42px}
  #audience-badge{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;text-align:start}
  #composer .composer-footer{flex-wrap:wrap}
}
@media(prefers-reduced-motion:reduce){#send-cluster::before,#send-cluster #audience-inline{animation:none}}

${COMPONENT_STYLE}
`
