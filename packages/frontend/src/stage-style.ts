export const STAGE_STYLE = String.raw`
/* Perspectra 舞台 —— 「夜间剧场」：场景色温随地点染色，说话者被聚光，对白是一页剧本。 */
@property --scene-hue{syntax:"<number>";inherits:true;initial-value:216}
:root{
  color-scheme:dark;
  transition:--scene-hue .9s cubic-bezier(0.16, 1, 0.3, 1);
  --ink:#0b111e;--ink-2:#111a2c;--ink-3:#18233b;
  --gold:#e3c086;--gold-hover:#eed3a2;--gold-soft:#e3c0861f;--gold-line:#e3c08659;
  --teal:#9fc6c5;--danger:#e59b86;
  --text:#f2ede3;--muted:#c2cad4;--faint:#8d99ad;
  --line:#a9bed62b;--line-strong:#c4cedb3b;
  --scene-hue:216;
  --font-ui:"Segoe UI","Microsoft YaHei",sans-serif;
  --font-story:"Noto Serif SC","Source Han Serif SC",serif;
  --fs-story:19px;--story-line-height:1.9;
  --ease-out:cubic-bezier(0.16, 1, 0.3, 1);
  --ease-spring:cubic-bezier(0.34, 1.56, 0.64, 1);
  font:14px/1.6 var(--font-ui);
  background:var(--ink);
  color:var(--text);
}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0}
button,input,textarea,select{font:inherit}
button,summary{cursor:pointer}
button{
  color:var(--text);
  border:1px solid var(--line);
  background:#172233cc;
  border-radius:8px;
  padding:8px 16px;
  transition:background .2s var(--ease-out),border-color .2s var(--ease-out),transform .15s var(--ease-out),box-shadow .2s var(--ease-out);
}
button:hover:not(:disabled){
  background:#26364f;
  border-color:#a9bed65e;
  transform:translateY(-1px);
  box-shadow:0 4px 12px rgba(0,0,0,.25);
}
button:active:not(:disabled){
  transform:translateY(0) scale(.98);
}
button:disabled{opacity:.38;cursor:default;transform:none!important;box-shadow:none!important}
:focus-visible{outline:2px solid var(--gold);outline-offset:3px}
textarea,select{
  color:var(--text);
  background:#0c1422;
  border:1px solid var(--line);
  border-radius:8px;
  padding:10px 12px;
  transition:border-color .2s var(--ease-out),box-shadow .2s var(--ease-out);
}
textarea:focus,select:focus{
  border-color:var(--gold-line);
  box-shadow:0 0 0 3px rgba(227,192,134,.12);
  outline:none;
}
textarea{width:100%;resize:vertical;max-height:140px}
p{margin:0}
main{height:100dvh;min-height:540px;overflow:hidden;position:relative;isolation:isolate}

/* —— 剧场背景：随场景染色，增加微光景深 —— */
.backdrop{
  position:absolute;inset:0;z-index:-2;
  background:linear-gradient(160deg,hsl(var(--scene-hue) 30% 12%),hsl(var(--scene-hue) 26% 19%) 55%,hsl(var(--scene-hue) 34% 9%));
  transition:background .9s var(--ease-out);
}
.backdrop:before{
  content:"";position:absolute;inset:0;
  background:radial-gradient(ellipse 75% 60% at 50% 0%,hsl(var(--scene-hue) 50% 50% / .28),transparent 72%),linear-gradient(0deg,#070d19f2,transparent 64%);
}
.backdrop:after{
  content:"";position:absolute;inset:0;
  background:radial-gradient(ellipse at center,transparent 30%,#03070fb8);
}

/* —— 顶栏 —— */
.world-header{
  position:absolute;top:0;left:0;right:0;z-index:3;
  display:flex;align-items:center;justify-content:space-between;
  padding:18px 32px;gap:18px;
  background:linear-gradient(#08101ee0 60%,transparent);
  backdrop-filter:blur(8px);
  transition:padding-right .3s var(--ease-out);
}
main[data-has-activity="true"] .world-header{
  padding-right:380px;
}
main[data-mode="activity"] .world-header{
  padding-right:400px;
}
.eyebrow{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:var(--gold);margin-bottom:3px}
h1{font-size:13px;font-weight:400;color:var(--muted);margin:0}
h2{font-family:var(--font-story);margin:0;font-size:24px;font-weight:500;letter-spacing:1px}
.scene-heading{display:flex;align-items:center;gap:18px}
.scene-heading:before{
  content:"◇";font-size:28px;color:var(--gold);
  text-shadow:0 0 16px rgba(227,192,134,.35);
  animation:gentleSpin 14s linear infinite;
}
@keyframes gentleSpin{0%,100%{transform:rotate(0deg)}50%{transform:rotate(180deg)}}
.stage-tools{display:flex;align-items:center;gap:8px}
.stage-tools button{font-size:12px;background:#17223366}
.status{
  display:inline-flex;align-items:center;gap:7px;
  font-size:11px;color:var(--muted);padding:5px 13px;
  border:1px solid var(--line);border-radius:20px;
  background:#101b2ecc;backdrop-filter:blur(6px);
  transition:all .3s var(--ease-out);
}
.status:before{
  content:"";width:7px;height:7px;border-radius:50%;
  background:var(--faint);transition:all .3s var(--ease-out);
}
.status[data-state="ready"]:before{
  background:var(--gold);box-shadow:0 0 8px rgba(227,192,134,.6);
}
.status[data-state="busy"]:before{
  background:var(--gold);box-shadow:0 0 10px rgba(227,192,134,.8);
  animation:pulse 1.2s ease-in-out infinite;
}
.status[data-state="error"]:before{
  background:var(--danger);box-shadow:0 0 8px rgba(229,155,134,.7);
}
.status[data-state="paused"]:before,.status[data-state="disconnected"]:before{background:var(--faint)}
@keyframes pulse{50%{opacity:.25;transform:scale(.8)}}

/* —— 立绘区：说话者聚光、前后景深 —— */
#characters{
  position:absolute;inset:76px 6% 96px;
  display:flex;justify-content:center;align-items:flex-end;
  gap:20px;pointer-events:none;overflow:hidden;
  transition:right .35s var(--ease-out);
}
.portrait{
  position:relative;flex:0 1 320px;height:100%;
  display:flex;align-items:flex-end;justify-content:center;
  animation:appear .5s var(--ease-out);
  filter:brightness(.62) saturate(.86);
  transform:translateY(8px) scale(.96);
  transform-origin:center bottom;
  transition:filter .4s var(--ease-out),transform .4s var(--ease-out);
}
.portrait.speaking{
  filter:brightness(1.06) saturate(1.02);
  transform:translateY(0) scale(1);
  z-index:2;
}
.portrait.speaking:after{
  content:"";position:absolute;inset:-8% -20% 0;z-index:-1;
  background:radial-gradient(ellipse 60% 45% at 50% 12%,hsl(var(--scene-hue) 65% 72% / .22),transparent 72%);
  animation:subtleBreathe 3s ease-in-out infinite alternate;
}
@keyframes subtleBreathe{0%{opacity:.65}100%{opacity:1}}
.portrait img{
  height:100%;width:100%;object-fit:contain;object-position:center bottom;
  mask-image:linear-gradient(#000 75%,transparent 99%);
  transition:transform .4s var(--ease-out);
}
.portrait-badge{
  display:grid;place-items:center;width:min(58%,220px);
  aspect-ratio:3/4;margin-bottom:9%;
  border-radius:48% 48% 12% 12%/36% 36% 10% 10%;
  font:56px var(--font-story);
  color:hsl(var(--hue,220) 45% 88%);
  background:linear-gradient(170deg,hsl(var(--hue,220) 28% 32% / .55),hsl(var(--hue,220) 32% 16% / .2));
  border:1px solid hsl(var(--hue,220) 45% 72% / .32);
  mask-image:linear-gradient(#000 74%,transparent);
  box-shadow:inset 0 0 30px hsl(var(--hue,220) 40% 40% / .15);
  text-shadow:0 2px 14px hsl(var(--hue,220) 50% 70% / .4);
}
.character-name{
  position:absolute;bottom:24%;font-size:12px;letter-spacing:3px;
  padding:5px 18px;border:1px solid var(--line);
  background:#0f1a2cf0;backdrop-filter:blur(8px);
  border-radius:30px;
  box-shadow:0 4px 14px rgba(0,0,0,.3);
  transition:all .35s var(--ease-out);
}
.portrait.speaking .character-name{
  color:var(--gold);border-color:var(--gold-line);
  background:#142138;
  box-shadow:0 0 16px rgba(227,192,134,.22),0 4px 16px rgba(0,0,0,.4);
  transform:scale(1.05);
}
.alone{align-self:center;color:#bac9d566;letter-spacing:6px;font-family:var(--font-story)}

/* —— 底部对白 dock：一页剧本 —— */
.stage-bottom{
  position:absolute;bottom:24px;left:50%;transform:translateX(-50%);
  width:min(1080px,calc(100% - 64px));z-index:4;
  display:flex;flex-direction:column;gap:8px;
  transition:width .35s var(--ease-out),left .35s var(--ease-out),transform .35s var(--ease-out);
}
.dialogue-wrap{
  border:1px solid rgba(169,190,214,.18);border-radius:16px;
  background:rgba(12,20,34,.62);
  box-shadow:0 20px 60px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter:blur(24px) saturate(160%);
  -webkit-backdrop-filter:blur(24px) saturate(160%);
  transition:border-color .3s var(--ease-out),box-shadow .3s var(--ease-out),background .3s var(--ease-out);
}
.dialogue-wrap:hover{
  border-color:rgba(227,192,134,.28);
  background:rgba(14,24,40,.72);
}
.dialogue-meta{
  padding:14px 24px 0;display:flex;justify-content:space-between;align-items:baseline;
}
.speaker-label{
  font:600 17px var(--font-story);color:var(--gold);letter-spacing:2px;
  display:inline-flex;align-items:center;gap:8px;
}
.speaker-label:before{
  content:"";width:4px;height:14px;border-radius:2px;background:var(--gold);
}
.reading-count{color:var(--faint);font-size:11px}
.dialogue{
  border:0;background:transparent!important;text-align:left;display:block;
  width:100%;min-height:84px;max-height:25dvh;overflow:auto;
  padding:12px 24px 8px;font:var(--fs-story)/var(--story-line-height) var(--font-story);
  white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text);
  transition:opacity .2s var(--ease-out);
}
.dialogue.fade-in{
  animation:dialogueGlideIn .25s var(--ease-out);
}
@keyframes dialogueGlideIn{
  from{opacity:0;transform:translateY(4px)}
  to{opacity:1;transform:translateY(0)}
}
.dialogue .say{color:#f7ecd8}
.dialogue .act{color:#9fb0c8;font-style:italic}
.dialogue[data-type="narration"]{font-size:calc(var(--fs-story) - 1px);color:#bdc8d6}
.dialogue[data-type="narration"]:before{
  content:"// 描写  ·  ";font:11px var(--font-ui);color:var(--gold);letter-spacing:1px;font-style:normal;
}
.dialogue-footer{
  display:flex;align-items:center;gap:8px;padding:4px 20px 12px;
  color:var(--faint);font-size:11px;
}
.dialogue-footer>span{margin-right:auto}
.dialogue-footer button{
  font-size:11px;padding:5px 11px;background:transparent;border:1px solid transparent;
  border-radius:6px;
}
.dialogue-footer button:hover:not(:disabled){
  border-color:var(--line);background:#17223366;
}
.dialogue-footer button.active{
  color:var(--gold);border-color:var(--gold-line);background:#e3c08614;
}
.round-tools{display:flex;align-items:center;gap:5px}
.round-tools button{padding:4px 8px;border-radius:6px}
.round-tools span{font-size:11px}
.round-tools svg{vertical-align:middle;transition:transform .3s var(--ease-out)}
.round-tools button:hover svg{transform:rotate(45deg)}

/* 自动阅读微进度条 */
.auto-progress{
  height:2px;width:100%;background:rgba(169,190,214,.08);overflow:hidden;
}
.auto-progress-bar{
  height:100%;width:0%;background:linear-gradient(90deg,var(--gold-line),var(--gold));
  transition:width .1s linear;
}

/* —— 回应 composer —— */
.composer{
  padding:18px 24px;border:1px solid rgba(169,190,214,.18);border-radius:16px;
  background:rgba(12,20,34,.68);
  box-shadow:0 20px 60px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter:blur(24px) saturate(160%);
  -webkit-backdrop-filter:blur(24px) saturate(160%);
  max-height:55dvh;overflow:auto;
  animation:composerPop .25s var(--ease-out);
}
@keyframes composerPop{
  from{opacity:0;transform:translateY(8px)}
  to{opacity:1;transform:translateY(0)}
}
.reply-context{
  border-left:2px solid var(--gold);padding:2px 0 2px 14px;
  margin:0 0 14px;color:var(--muted);background:rgba(227,192,134,.04);
  border-radius:0 8px 8px 0;cursor:pointer;
  transition:background .2s var(--ease-out);
}
.reply-context:hover{
  background:rgba(227,192,134,.09);
}
.reply-context span{font-size:11px;color:var(--gold);font-weight:600}
.reply-context p{
  font:14px/1.7 var(--font-story);white-space:pre-wrap;overflow-wrap:anywhere;
  max-height:72px;overflow:auto;margin:4px 0 0;
}
.audience-heading,.composer-footer{
  display:flex;justify-content:space-between;align-items:center;gap:12px;
  font-size:12px;margin-bottom:10px;
}
.audience-heading strong{font-weight:400;color:var(--gold)}
.audience-heading span{color:var(--muted)}

/* 胶囊分段选项卡 (Pill Segmented Control) */
.audience-options{
  display:flex;gap:6px;flex-wrap:wrap;border:0;padding:0;margin:0 0 12px;
}
.audience-options label{
  display:inline-flex;align-items:center;padding:5px 13px;border-radius:20px;
  border:1px solid var(--line);background:#121c2e;color:var(--muted);
  font-size:11px;cursor:pointer;transition:all .2s var(--ease-out);user-select:none;
}
.audience-options label:hover{
  background:#1a273f;border-color:#a9bed655;color:var(--text);transform:translateY(-1px);
}
.audience-options label:has(input:checked){
  background:var(--gold-soft);border-color:var(--gold);color:var(--gold);
  font-weight:500;box-shadow:0 0 12px rgba(227,192,134,.16);
}
.audience-options input{
  margin:0 5px 0 0;accent-color:var(--gold);
}
#recipient-panel{
  margin-bottom:12px;font-size:12px;display:flex;align-items:center;gap:10px;
}
#recipient-panel select{flex:1;max-width:240px}
.narration-composer{
  border:1px solid var(--line);border-radius:9px;padding:8px 12px;
  background:#0c142288;margin-bottom:10px;transition:border-color .2s var(--ease-out);
}
.narration-composer[open]{border-color:var(--gold-line)}
.narration-composer summary{font-size:11px;color:var(--muted);outline:none;user-select:none}
.narration-composer summary span{color:var(--faint);margin-left:10px}
.narration-composer textarea{margin-top:8px}
.composer-footer{margin:8px 0 0;color:var(--faint);font-size:11px}
#send{
  background:linear-gradient(135deg,#e3c086,#d4ad6e);
  color:#171107;border:0;min-width:104px;font-weight:600;
  border-radius:8px;padding:9px 18px;
  box-shadow:0 2px 10px rgba(227,192,134,.22);
  transition:all .2s var(--ease-out);
}
#send:hover:not(:disabled){
  background:linear-gradient(135deg,#eed4a7,#e3c086);
  box-shadow:0 4px 16px rgba(227,192,134,.35);
  transform:translateY(-1px);
}
#send:active:not(:disabled){transform:translateY(0) scale(.97)}
.audience-preview{font-size:11px;color:var(--faint);margin:6px 0}
.feedback{font-size:12px;color:#ecc691}
.feedback:has(#notice:not(:empty)){
  padding:9px 20px;background:#18223af2;border:1px solid var(--line-strong);border-radius:10px;
}
#retry{font-size:11px;padding:5px 12px;margin:5px}
.expression-choices{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.expression-choices button{
  background:#1a273f;border-color:var(--gold-line);color:var(--gold);font-size:12px;
}
.expression-choices button:hover:not(:disabled){background:#243656;border-color:var(--gold)}

/* —— 覆盖面板（文字记录 / 行动） —— */
.panel{
  position:absolute;z-index:7;background:rgba(12,21,36,.76);
  border:1px solid rgba(169,190,214,.2);border-radius:16px;
  box-shadow:0 24px 80px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter:blur(28px) saturate(160%);
  -webkit-backdrop-filter:blur(28px) saturate(160%);
  animation:panelPop .22s var(--ease-out);
}
@keyframes panelPop{
  from{opacity:0;transform:scale(.98) translateY(8px)}
  to{opacity:1;transform:scale(1) translateY(0)}
}
.panel-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:16px 24px;border-bottom:1px solid var(--line);letter-spacing:2px;font-size:13px;
}
.panel-header button{padding:3px 12px;font-size:14px;border-radius:6px}
.history-panel{
  inset:80px max(24px,calc((100% - 960px)/2)) 24px;display:flex;flex-direction:column;
}
#history{flex:1;min-height:0;overflow:auto;padding:24px 32px;scrollbar-width:thin}
.line{
  display:flex;gap:16px;margin-bottom:24px;
  animation:lineFadeIn .2s var(--ease-out);
}
@keyframes lineFadeIn{
  from{opacity:0;transform:translateY(4px)}
  to{opacity:1;transform:translateY(0)}
}
.avatar{
  display:grid;place-items:center;flex-shrink:0;width:34px;height:34px;
  border:1px solid var(--line);border-radius:50%;color:var(--gold);
  background:#141f33;font-weight:600;
}
.message{min-width:0}
.speaker{font-size:12px;color:var(--gold)}
.text{font:16px/1.9 var(--font-story);white-space:pre-wrap;overflow-wrap:anywhere}
.act{color:#aebcca;font-style:italic}
.player .speaker{color:var(--teal)}
.empty-history{color:var(--muted);padding:30px}
.empty-history strong{display:block;margin-bottom:6px}
.action-panel{
  top:76px;right:32px;width:320px;max-height:min(440px,calc(100dvh - 140px));overflow:auto;
  transition:right .3s var(--ease-out);
}
main[data-has-activity="true"] .action-panel,
main[data-mode="activity"] .action-panel{
  right:360px;
}
.action-group{padding:12px 18px}
.action-group h3{font-size:11px;font-weight:500;color:var(--gold);margin:0 0 6px}
.action-group button{
  display:flex;justify-content:space-between;width:100%;text-align:left;
  margin:7px 0;font-size:12px;overflow-wrap:anywhere;
}
.action-group select{width:100%}
.no-actions{padding:20px;color:var(--muted)}
.hint{font-size:11px;color:var(--faint)}
#latest{align-self:center;margin-bottom:10px;font-size:12px}

/* —— 其余舞台元素 —— */
.movement-toast{
  position:absolute;top:90px;left:50%;transform:translateX(-50%);
  padding:10px 24px;background:#172439f0;border:1px solid var(--gold-line);
  border-radius:30px;color:var(--gold);font-size:13px;z-index:5;
  max-width:80%;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.5);
  animation:toastPop .3s var(--ease-out);
}
@keyframes toastPop{
  from{opacity:0;transform:translate(-50%,-10px)}
  to{opacity:1;transform:translate(-50%,0)}
}
.visually-hidden{position:absolute;clip:rect(0,0,0,0);width:1px;height:1px;overflow:hidden}
main[data-mode="activity"] .stage-bottom{
  left:calc((100% - 350px) / 2);
  transform:translateX(-50%);
  width:min(840px,calc(100% - 400px));
}
main[data-mode="activity"] #characters{
  right:350px;
}
main[data-mode="activity"] .dialogue{font-size:16px;max-height:100px;min-height:0}
main[data-mode="activity"] .dialogue-footer{padding-bottom:10px}

@keyframes appear{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

@media(min-width:1500px){
  .stage-bottom{bottom:36px}
  .portrait{flex-basis:420px}
  .dialogue{padding-top:14px;padding-bottom:14px}
  .dialogue-meta{padding-top:18px}
}

@media(max-width:640px){
  main{min-height:480px}
  .world-header{padding:14px;align-items:flex-start}
  .scene-heading{gap:10px}.scene-heading:before{font-size:22px}
  h2{font-size:18px}h1{font-size:10px;max-width:180px}
  .stage-tools{flex-wrap:wrap;justify-content:flex-end;max-width:200px;gap:4px}
  .stage-tools button{padding:6px 8px;font-size:11px}
  .status{width:fit-content}
  #characters{inset:76px 0 110px;gap:0}
  .portrait{min-width:0}
  .character-name{font-size:10px;padding:3px 9px;letter-spacing:1px}
  .stage-bottom{width:calc(100% - 24px);bottom:14px;gap:8px}
  .dialogue-meta{padding:12px 16px 0}
  .dialogue{padding:10px 16px;min-height:72px;max-height:23dvh;font-size:calc(var(--fs-story) - 1px)}
  .dialogue-footer{padding:4px 10px 10px;flex-wrap:wrap}
  .dialogue-footer>span{width:100%}
  .composer{padding:12px 14px;max-height:55dvh}
  .reply-context p{max-height:55px}
  .audience-options{gap:6px}
  .history-panel{inset:74px 12px 14px}
  .panel-header{padding:12px 16px}
  #history{padding:20px 16px}
  .action-panel{top:74px;right:12px;width:calc(100% - 24px);max-height:calc(100dvh - 100px)}
  main[data-has-activity="true"] .world-header,main[data-mode="activity"] .world-header{padding-right:14px}
  main[data-mode="activity"] .stage-bottom{left:50%;width:calc(100% - 24px)}
  main[data-mode="activity"] #characters{right:0}
}
`;
