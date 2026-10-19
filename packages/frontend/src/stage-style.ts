export const STAGE_STYLE = String.raw`
/* Perspectra 舞台 ——「夜幕灯火」：与启动器同一套主题色与宋体；场景只微调色温，说话者被灯光照亮。 */
/* 主题色：由启动器全局设置经 settings.palette 传入；默认樱色。舞台始终是夜色。 */
:root,:root[data-palette="sakura"]{--ink:#120e10;--ink-0:#0b0809;--ink-2:#1a1418;--ink-3:#241c21;--lamp:#f0a0b8;--lamp-strong:#f7bccd;--lamp-deep:#d77a97;--lamp-ink:#2a1119;--text:#f3e8ec;--muted:#c9b5bd;--faint:#927e87;--say:#fdf0f4;--act:#b9a5ad;--narr:#d6c3cb}
:root[data-palette="lamp"]{--ink:#100e0c;--ink-0:#0a0908;--ink-2:#171411;--ink-3:#211d19;--lamp:#e6ad5c;--lamp-strong:#f0bf72;--lamp-deep:#cf8f3f;--lamp-ink:#22170a;--text:#f1ebe1;--muted:#c4baab;--faint:#8e8576;--say:#fbf2e2;--act:#b3a896;--narr:#cfc5b4}
:root[data-palette="moon"]{--ink:#0d1015;--ink-0:#08090c;--ink-2:#13171e;--ink-3:#1c222b;--lamp:#9ab8e8;--lamp-strong:#b6cdf2;--lamp-deep:#6f93cf;--lamp-ink:#0e1626;--text:#e7ecf3;--muted:#b3bccb;--faint:#7d8798;--say:#f2f6fc;--act:#a3adbd;--narr:#c6cfdc}
:root[data-palette="forest"]{--ink:#0e120f;--ink-0:#080a09;--ink-2:#141a16;--ink-3:#1d251f;--lamp:#8fcfa6;--lamp-strong:#a9dcbb;--lamp-deep:#5fae80;--lamp-ink:#0d1f15;--text:#e7efe9;--muted:#b5c4ba;--faint:#7f9086;--say:#f1f8f3;--act:#a6b7ab;--narr:#c7d6cc}
@property --scene-hue{syntax:"<number>";inherits:true;initial-value:30}
:root{
  color-scheme:dark;
  transition:--scene-hue 1.2s cubic-bezier(0.16, 1, 0.3, 1);
  --lamp-soft:color-mix(in srgb,var(--lamp) 12.0%,transparent);--lamp-line:color-mix(in srgb,var(--lamp) 38.0%,transparent);
  --teal:#9cc7bd;--danger:#f08a7e;
  --line:color-mix(in srgb,var(--text) 9.0%,transparent);--line-strong:color-mix(in srgb,var(--text) 17.0%,transparent);
  --glass:color-mix(in srgb,var(--ink-2) 72.0%,transparent);--glass-strong:color-mix(in srgb,var(--ink-2) 86.0%,transparent);
  --scene-hue:30;
  --font-ui:"Segoe UI Variable Text","Segoe UI","PingFang SC","Microsoft YaHei UI","Microsoft YaHei",sans-serif;
  --font-story:"Noto Serif SC","Source Han Serif SC","Source Han Serif CN","Songti SC","STSong",serif;
  --fs-story:19px;--story-line-height:1.9;
  --ease-out:cubic-bezier(0.16, 1, 0.3, 1);
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
  border:1px solid var(--line-strong);
  background:color-mix(in srgb,var(--text) 5.0%,transparent);
  border-radius:9px;
  padding:8px 16px;
  transition:background .2s var(--ease-out),border-color .2s var(--ease-out),color .2s var(--ease-out),transform .15s var(--ease-out);
}
button:hover:not(:disabled){background:color-mix(in srgb,var(--text) 10.0%,transparent);border-color:color-mix(in srgb,var(--text) 28.0%,transparent)}
button:active:not(:disabled){transform:scale(.98)}
button:disabled{opacity:.36;cursor:default;transform:none!important}
:focus-visible{outline:2px solid var(--lamp);outline-offset:3px}
textarea,select{
  color:var(--text);
  background:rgba(0,0,0,.28);
  border:1px solid var(--line-strong);
  border-radius:10px;
  padding:10px 12px;
  transition:border-color .2s var(--ease-out),box-shadow .2s var(--ease-out);
}
textarea:focus,select:focus{border-color:var(--lamp-line);box-shadow:0 0 0 3px var(--lamp-soft);outline:none}
textarea{width:100%;resize:vertical;max-height:140px}
textarea::placeholder{color:var(--faint)}
p{margin:0}
main{height:100dvh;min-height:540px;overflow:hidden;position:relative;isolation:isolate}

/* —— 舞台背景：暗场 + 地面灯光，地点只带来轻微色温 —— */
.backdrop{
  position:absolute;inset:0;z-index:-2;
  background:
    radial-gradient(60% 46% at 50% 100%,hsl(var(--scene-hue) 32% 40% / .3),transparent 70%),radial-gradient(40% 50% at 50% 30%,color-mix(in srgb,var(--lamp-strong) 8.0%,transparent),transparent 70%),
    radial-gradient(80% 60% at 50% -10%,hsl(var(--scene-hue) 30% 40% / .2),transparent 70%),
    linear-gradient(180deg,hsl(var(--scene-hue) 16% 9%),hsl(var(--scene-hue) 18% 12%) 58%,hsl(var(--scene-hue) 20% 7%));
}
.backdrop:before{
  /* 远景地平线与地面反光 */
  content:"";position:absolute;left:0;right:0;bottom:0;height:34%;
  background:linear-gradient(180deg,transparent,hsl(var(--scene-hue) 30% 18% / .35) 40%,rgba(0,0,0,.55));
}
.backdrop:after{
  content:"";position:absolute;inset:0;
  background:
    radial-gradient(ellipse at center,transparent 45%,rgba(0,0,0,.6)),
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E");
  mix-blend-mode:overlay;opacity:.5;
}

/* —— 顶栏：地点名 + 世界名，右侧是轻量工具 —— */
.world-header{
  position:absolute;top:0;left:0;right:0;z-index:3;
  display:flex;align-items:flex-start;justify-content:space-between;
  padding:22px 32px 40px;gap:18px;
  background:linear-gradient(color-mix(in srgb,var(--ink-0) 72.0%,transparent),transparent);
  transition:padding-right .3s var(--ease-out);
}
main[data-has-activity="true"] .world-header{padding-right:380px}
main[data-mode="activity"] .world-header{padding-right:400px}
.eyebrow{display:none}
.scene-heading{display:flex;align-items:center;gap:14px}
.scene-heading:before{
  content:"";width:3px;align-self:stretch;border-radius:3px;
  background:linear-gradient(var(--lamp-strong),var(--lamp) 60%,transparent);
}
h2{font:700 26px/1.25 var(--font-story);margin:0;letter-spacing:.08em;text-shadow:0 2px 18px rgba(0,0,0,.5)}
h1{font-size:12.5px;font-weight:400;color:var(--muted);margin:4px 0 0;letter-spacing:.04em}
/* 状态栏：玩家已知的状态值，跟在世界名之下 */
.status-bar{display:flex;flex-wrap:wrap;gap:4px 18px;margin-top:8px;font-size:12.5px;color:var(--muted)}
.status-group{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}
.status-group small{font-size:11.5px;letter-spacing:.14em;color:var(--lamp)}
.status-item strong{font-weight:600;color:var(--text)}
.status-item{min-width:0;overflow-wrap:anywhere}
.stage-tools{display:flex;align-items:center;gap:8px}
.stage-tools button{
  font-size:12.5px;padding:7px 14px;border-radius:999px;
  background:color-mix(in srgb,var(--ink) 55.0%,transparent);backdrop-filter:blur(10px);
}
#action-count{
  display:inline-grid;place-items:center;min-width:18px;height:18px;margin-left:4px;padding:0 5px;
  border-radius:9px;font-size:11px;font-weight:600;color:var(--lamp-ink);background:var(--lamp);
}
#actions-toggle:disabled #action-count{background:var(--faint)}
.status{
  display:inline-flex;align-items:center;gap:7px;
  font-size:12px;color:var(--muted);padding:6px 4px 6px 0;
}
.status:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--faint);transition:all .3s var(--ease-out)}
.status[data-state="ready"]:before{background:var(--lamp);box-shadow:0 0 10px color-mix(in srgb,var(--lamp) 70.0%,transparent)}
.status[data-state="busy"]:before{background:var(--lamp);box-shadow:0 0 10px color-mix(in srgb,var(--lamp) 90.0%,transparent);animation:pulse 1.2s ease-in-out infinite}
.status[data-state="error"]:before{background:var(--danger);box-shadow:0 0 8px rgba(240,138,126,.7)}
.status[data-state="paused"]:before,.status[data-state="disconnected"]:before{background:var(--faint)}
@keyframes pulse{50%{opacity:.3;transform:scale(.8)}}

/* —— 立绘区：说话者被照亮，其他人退入暗处 —— */
#characters{
  position:absolute;inset:84px 6% 96px;
  display:flex;justify-content:center;align-items:flex-end;
  gap:24px;pointer-events:none;overflow:hidden;
  transition:right .35s var(--ease-out);
}
.portrait{
  position:relative;flex:0 1 320px;height:100%;
  display:flex;flex-direction:column;align-items:center;justify-content:flex-end;
  animation:appear .5s var(--ease-out);
  filter:brightness(.55) saturate(.8);
  transform:translateY(10px) scale(.96);transform-origin:center bottom;
  transition:filter .45s var(--ease-out),transform .45s var(--ease-out);
}
.portrait.speaking{filter:none;transform:none;z-index:2}
.portrait.speaking:after{
  content:"";position:absolute;inset:-10% -25% 0;z-index:-1;
  background:radial-gradient(ellipse 55% 48% at 50% 30%,color-mix(in srgb,var(--lamp-strong) 20.0%,transparent),transparent 72%);
}
.portrait img{
  height:100%;width:100%;object-fit:contain;object-position:center bottom;
  mask-image:linear-gradient(#000 78%,transparent 99%);
}
/* 没有立绘时：按角色色调生成的半身剪影，首字落在胸前 */
.portrait-badge{
  position:absolute;left:50%;bottom:calc(24% + 16px);transform:translateX(-50%);width:min(62%,220px);aspect-ratio:4/5;
  display:flex;align-items:flex-end;justify-content:center;padding-bottom:16%;
  font:600 30px/1 var(--font-story);color:hsl(var(--hue,30) 30% 86% / .7);
  mask-image:linear-gradient(#000 70%,transparent);
}
.portrait-badge:before{
  content:"";position:absolute;left:50%;top:6%;width:38%;aspect-ratio:1;transform:translateX(-50%);
  border-radius:50%;
  background:radial-gradient(circle at 40% 35%,hsl(var(--hue,30) 26% 44%),hsl(var(--hue,30) 26% 24%));
  box-shadow:inset 0 0 0 1px hsl(var(--hue,30) 40% 75% / .18);
}
.portrait-badge:after{
  content:"";position:absolute;left:4%;right:4%;top:48%;bottom:0;z-index:-1;
  border-radius:48% 48% 8% 8%/60% 60% 6% 6%;
  background:linear-gradient(180deg,hsl(var(--hue,30) 26% 38%),hsl(var(--hue,30) 26% 18%));
  box-shadow:inset 0 0 0 1px hsl(var(--hue,30) 40% 75% / .14);
}
.character-name{
  position:absolute;bottom:24%;
  font:500 13px/1 var(--font-story);letter-spacing:.2em;
  padding:6px 14px 6px 16px;border-radius:999px;
  color:var(--muted);background:color-mix(in srgb,var(--ink) 70.0%,transparent);backdrop-filter:blur(8px);
  border:1px solid var(--line);
  transition:all .35s var(--ease-out);
}
.portrait.speaking .character-name{color:var(--lamp-strong);border-color:var(--lamp-line)}
.alone{align-self:center;color:color-mix(in srgb,var(--text) 32.0%,transparent);letter-spacing:.5em;font:16px var(--font-story)}

/* —— 底部对白框：名牌探出框外，像一页剧本 —— */
.stage-bottom{
  position:absolute;bottom:26px;left:50%;transform:translateX(-50%);
  width:min(1040px,calc(100% - 64px));z-index:4;
  display:flex;flex-direction:column;gap:8px;
  transition:width .35s var(--ease-out),left .35s var(--ease-out),transform .35s var(--ease-out);
}
.dialogue-wrap{
  position:relative;margin-top:18px;
  border:1px solid var(--line-strong);border-radius:18px;
  background:linear-gradient(180deg,color-mix(in srgb,var(--ink-3) 78.0%,transparent),color-mix(in srgb,var(--ink) 90.0%,transparent));
  box-shadow:0 24px 60px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.05);
  backdrop-filter:blur(22px) saturate(140%);-webkit-backdrop-filter:blur(22px) saturate(140%);
}
.dialogue-wrap:before{
  /* 上沿一条细灯光 */
  content:"";position:absolute;left:28px;right:28px;top:-1px;height:1px;
  background:linear-gradient(90deg,transparent,var(--lamp-line),transparent);
}
.dialogue-meta{
  position:absolute;top:-17px;left:22px;right:22px;
  display:flex;justify-content:space-between;align-items:center;pointer-events:none;
}
.speaker-label{
  font:700 16px/1 var(--font-story);letter-spacing:.16em;color:var(--lamp-ink);
  padding:9px 18px 9px 20px;border-radius:10px;
  background:linear-gradient(160deg,var(--lamp-strong),var(--lamp) 60%,var(--lamp-deep));
  box-shadow:0 6px 18px color-mix(in srgb,var(--lamp) 28.0%,transparent);
}
.reading-count{
  color:var(--faint);font-size:11.5px;padding:3px 10px;border-radius:999px;
  background:color-mix(in srgb,var(--ink) 80.0%,transparent);border:1px solid var(--line);margin-top:14px;
}
.dialogue{
  border:0;background:transparent!important;text-align:left;display:block;
  width:100%;min-height:96px;max-height:25dvh;overflow:auto;
  padding:30px 30px 8px;font:var(--fs-story)/var(--story-line-height) var(--font-story);
  white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text);letter-spacing:.02em;
}
.dialogue:hover:not(:disabled){transform:none}
.dialogue.fade-in{animation:dialogueGlideIn .3s var(--ease-out)}
@keyframes dialogueGlideIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.dialogue .say{color:var(--say)}
.dialogue .act{color:var(--act)}
.dialogue[data-type="narration"]{color:var(--narr)}
.dialogue-footer{
  display:flex;align-items:center;gap:4px;padding:2px 18px 14px 30px;
  color:var(--faint);font-size:12px;
}
.dialogue-footer>span{margin-right:auto}
.dialogue-footer>span:before{content:"▾";display:inline-block;margin-right:8px;color:var(--lamp);animation:nudge 1.6s ease-in-out infinite}
@keyframes nudge{50%{transform:translateY(3px);opacity:.5}}
.dialogue-footer button{
  font-size:12px;padding:5px 12px;color:var(--muted);background:transparent;border:1px solid transparent;border-radius:999px;
}
.dialogue-footer button:hover:not(:disabled){color:var(--text);border-color:var(--line-strong);background:color-mix(in srgb,var(--text) 5.0%,transparent)}
.dialogue-footer button.active{color:var(--lamp-strong);border-color:var(--lamp-line);background:var(--lamp-soft)}
.round-tools{display:flex;align-items:center;gap:4px;margin-left:6px;padding-left:10px;border-left:1px solid var(--line)}
.round-tools button{padding:4px 9px}
.round-tools span{font-size:11.5px;color:var(--muted)}
.round-tools svg{vertical-align:middle;transition:transform .3s var(--ease-out)}
.round-tools button:hover svg{transform:rotate(45deg)}
.auto-progress{position:absolute;left:30px;right:30px;bottom:6px;height:2px;border-radius:2px;background:color-mix(in srgb,var(--text) 6.0%,transparent);overflow:hidden}
.auto-progress-bar{height:100%;width:0%;background:linear-gradient(90deg,var(--lamp-line),var(--lamp));transition:width .1s linear}

/* —— 回应：左栏写话，右栏是可以直接尝试的行动 —— */
.composer{
  padding:14px 18px 12px 22px;border:1px solid var(--line-strong);border-radius:18px;
  background:linear-gradient(180deg,color-mix(in srgb,var(--ink-3) 95.0%,transparent),color-mix(in srgb,var(--ink) 97.0%,transparent));
  box-shadow:0 24px 60px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.05);
  backdrop-filter:blur(22px) saturate(140%);-webkit-backdrop-filter:blur(22px) saturate(140%);
  max-height:56dvh;overflow:visible;
  animation:composerPop .25s var(--ease-out);
}
@keyframes composerPop{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.reply-context{
  border-left:2px solid var(--lamp);padding:2px 0 2px 14px;
  margin:0 0 10px;color:var(--muted);cursor:pointer;border-radius:0 8px 8px 0;
  transition:background .2s var(--ease-out);
}
.reply-context:hover{background:var(--lamp-soft)}
.reply-context span{font:600 12px var(--font-story);color:var(--lamp);letter-spacing:.12em}
.reply-context p{font:14px/1.7 var(--font-story);white-space:pre-wrap;overflow-wrap:anywhere;max-height:48px;overflow:auto;margin:4px 0 0}
.composer-body{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;align-items:stretch}
.composer-body:has(.quick-actions:not([hidden])){grid-template-columns:minmax(0,1fr) 210px}
.composer-main{min-width:0;display:flex;flex-direction:column}
.composer-main textarea#input{min-height:64px;flex:1;max-height:none}

/* 底部工具条：受众按钮 · 接收对象 · 快捷键 · 发送 */
.composer-footer{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:11.5px;color:var(--faint)}
.composer-keys{margin-left:auto}
.audience-picker{position:relative}
.audience-button{
  display:inline-flex;align-items:center;gap:8px;padding:6px 12px 6px 10px;border-radius:999px;
  font-size:12.5px;color:var(--text);background:rgba(0,0,0,.28);
}
.audience-button[aria-expanded="true"]{border-color:var(--lamp-line);background:var(--lamp-soft)}
.audience-button .chevron{width:0;height:0;font-size:0;border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:5px solid var(--faint);transition:transform .2s var(--ease-out)}
.audience-button[aria-expanded="true"] .chevron{transform:rotate(180deg)}
.audience-dot{width:8px;height:8px;border-radius:50%;background:var(--lamp);box-shadow:0 0 8px color-mix(in srgb,var(--lamp) 60.0%,transparent)}
.audience-picker:has(input[value="direct"]:checked) .audience-dot{background:var(--teal);box-shadow:0 0 8px rgba(156,199,189,.6)}
.audience-picker:has(input[value="private"]:checked) .audience-dot{background:#c9a0dc;box-shadow:0 0 8px rgba(201,160,220,.6)}
.audience-picker:has(input[value="self"]:checked) .audience-dot{background:var(--faint);box-shadow:none}

/* 弹出菜单：向上展开，悬停时右侧浮出受众范围说明 */
.audience-menu{
  position:absolute;left:0;bottom:calc(100% + 8px);z-index:20;width:236px;padding:6px;
  background:color-mix(in srgb,var(--ink-3) 98.0%,transparent);border:1px solid var(--line-strong);border-radius:14px;
  box-shadow:0 18px 50px rgba(0,0,0,.6);
  animation:menuUp .18s var(--ease-out);
}
@keyframes menuUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.audience-options{display:grid;gap:2px;border:0;padding:0;margin:0}
.audience-options legend{padding:6px 10px 6px;font-size:11px;color:var(--faint);letter-spacing:.08em}
.audience-options label{
  position:relative;display:grid;grid-template-columns:auto 1fr;column-gap:10px;align-items:center;
  padding:8px 10px;border-radius:10px;cursor:pointer;user-select:none;color:var(--text);
}
.audience-options label:hover,.audience-options label:focus-within{background:color-mix(in srgb,var(--text) 7.0%,transparent)}
.audience-options label:has(input:checked){background:var(--lamp-soft)}
.audience-options label:has(input:checked) span{color:var(--lamp-strong)}
.audience-options label:has(input:disabled){opacity:.5;cursor:default}
.audience-options input{grid-row:1/3;margin:0;accent-color:var(--lamp)}
.audience-options span{font-size:13px;font-weight:600}
.audience-options small{grid-column:2;font-size:11.5px;color:var(--faint)}
.audience-options label:after{
  content:attr(data-tip);position:absolute;left:calc(100% + 14px);top:50%;transform:translate(-4px,-50%);
  width:220px;padding:9px 12px;border-radius:10px;font-size:12px;line-height:1.6;color:var(--text);
  background:color-mix(in srgb,var(--ink-3) 98.0%,transparent);border:1px solid var(--line-strong);box-shadow:0 12px 30px rgba(0,0,0,.5);
  opacity:0;pointer-events:none;transition:opacity .15s var(--ease-out),transform .15s var(--ease-out);
}
.audience-options label:hover:after,.audience-options label:focus-within:after{opacity:1;transform:translate(0,-50%)}

#recipient-panel{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
#recipient-panel select{max-width:160px;padding:5px 10px;border-radius:999px;font-size:12.5px}
#recipient-panel .hint{white-space:nowrap}

/* 右栏：每类行动一个按钮，按下向左弹出该类选项；与刚说话角色相关的带灯色标记 */
.quick-actions{display:flex;flex-direction:column;gap:5px;padding-left:18px;border-left:1px solid var(--line);min-width:0}
.quick-actions small{font-size:11px;font-weight:600;letter-spacing:.14em;color:var(--lamp);margin:2px 0 2px}
.quick-group{position:relative}
.quick-actions .group-button{
  display:flex;align-items:center;gap:8px;width:100%;text-align:left;
  font-size:13px;padding:6px 12px;border-radius:10px;
  color:var(--text);border-color:var(--line-strong);background:color-mix(in srgb,var(--text) 4.0%,transparent);
}
.group-button .count{margin-left:auto;font-size:11px;color:var(--faint);padding:0 7px;border-radius:999px;background:color-mix(in srgb,var(--text) 7.0%,transparent)}
.group-button:after{content:"";width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;border-right:5px solid var(--faint)}
.group-button.related{box-shadow:inset 3px 0 0 var(--lamp)}
.group-button.related .count{color:var(--lamp-ink);background:var(--lamp)}
.group-button[aria-expanded="true"]{border-color:var(--lamp-line);background:var(--lamp-soft);color:var(--lamp-strong)}
.group-button:hover:not(:disabled){border-color:var(--lamp-line)}
.quick-menu{
  position:absolute;right:calc(100% + 12px);bottom:0;z-index:20;width:250px;max-height:min(340px,48dvh);overflow:auto;
  display:flex;flex-direction:column;gap:2px;padding:6px;
  background:color-mix(in srgb,var(--ink-3) 98.0%,transparent);border:1px solid var(--line-strong);border-radius:14px;
  box-shadow:0 18px 50px rgba(0,0,0,.6);scrollbar-width:thin;
  animation:menuLeft .18s var(--ease-out);
}
@keyframes menuLeft{from{opacity:0;transform:translateX(6px)}to{opacity:1;transform:none}}
.quick-menu p{padding:6px 10px;font-size:11px;color:var(--faint);letter-spacing:.08em}
.quick-menu button{
  display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;text-align:left;
  padding:8px 10px;border:0;border-radius:10px;background:transparent;font-size:13px;color:var(--text);
}
.quick-menu button:after{content:"→";color:var(--lamp);opacity:0;transition:opacity .15s}
.quick-menu button.needs-choice:after{content:"⋯";opacity:.6}
.quick-menu button:hover:not(:disabled),.quick-menu button:focus-visible{background:color-mix(in srgb,var(--text) 7.0%,transparent)}
.quick-menu button:hover:not(:disabled):after{opacity:1}
.quick-menu button.related{color:var(--lamp-strong)}
.quick-menu button.related:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--lamp);flex-shrink:0;order:-1}
.quick-menu button.related{justify-content:flex-start}
.quick-menu button.related:after{margin-left:auto}

/* 描写：受众按钮右侧的小开关，展开后变成单行输入框，伸到发送按钮前 */
.narration-composer{display:flex;align-items:center;gap:8px;margin:0;min-width:0}
.narration-composer[open]{flex:1}
.narration-composer[open]::details-content{display:contents}
.narration-composer[open] textarea{width:100%}
.narration-composer summary{
  flex-shrink:0;display:inline-flex;align-items:center;gap:6px;list-style:none;user-select:none;outline:none;
  padding:6px 12px;border-radius:999px;border:1px solid var(--line-strong);background:rgba(0,0,0,.28);
  font-size:12.5px;color:var(--muted);cursor:pointer;transition:all .2s var(--ease-out);
}
.narration-composer summary::-webkit-details-marker{display:none}
.narration-composer summary:before{content:"+";color:var(--lamp);font-weight:600}
.narration-composer summary:hover{color:var(--text);border-color:color-mix(in srgb,var(--text) 28.0%,transparent)}
.narration-composer summary:focus-visible{outline:2px solid var(--lamp);outline-offset:2px}
.narration-composer[open] summary{color:var(--lamp-strong);border-color:var(--lamp-line);background:var(--lamp-soft)}
.narration-composer[open] summary:before{content:"−"}
.narration-composer textarea{
  flex:1;min-width:0;height:34px;min-height:34px;max-height:34px;resize:none;overflow:hidden;
  padding:6px 12px;border-radius:999px;white-space:nowrap;font-size:13px;line-height:20px;
  animation:narrationGrow .22s var(--ease-out);
}
@keyframes narrationGrow{from{opacity:0;transform:scaleX(.6);transform-origin:left}to{opacity:1;transform:none}}
.composer-footer:has(.narration-composer[open]) .composer-keys{display:none}
#send{
  background:linear-gradient(160deg,var(--lamp-strong),var(--lamp) 60%,var(--lamp-deep));
  color:var(--lamp-ink);border:0;min-width:96px;font-weight:700;letter-spacing:.08em;
  border-radius:10px;padding:8px 18px;box-shadow:0 6px 18px color-mix(in srgb,var(--lamp) 25.0%,transparent);
}
#send:hover:not(:disabled){filter:brightness(1.06);background:linear-gradient(160deg,var(--lamp-strong),var(--lamp) 60%,var(--lamp-deep))}
.feedback{font-size:12.5px;color:var(--lamp-strong)}
.feedback:has(#notice:not(:empty)){
  display:flex;align-items:center;gap:10px;
  padding:9px 18px;background:var(--glass-strong);border:1px solid var(--line-strong);border-radius:12px;
}
#retry{font-size:12px;padding:5px 12px;margin-left:auto}
.expression-choices{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.expression-choices:empty{display:none}
.expression-choices button{font:15px var(--font-story);padding:9px 18px;border-color:var(--lamp-line);background:rgba(0,0,0,.25);text-align:left}
.expression-choices button:hover:not(:disabled){border-color:var(--lamp);background:var(--lamp-soft);color:var(--lamp-strong)}

/* —— 覆盖面板（文字记录 / 行动） —— */
.panel{
  position:absolute;z-index:7;
  background:linear-gradient(180deg,color-mix(in srgb,var(--ink-3) 90.0%,transparent),color-mix(in srgb,var(--ink) 95.0%,transparent));
  border:1px solid var(--line-strong);border-radius:18px;
  box-shadow:0 24px 80px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.05);
  backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%);
  animation:panelPop .22s var(--ease-out);
}
@keyframes panelPop{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.panel-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:16px 22px;border-bottom:1px solid var(--line);font:600 15px var(--font-story);letter-spacing:.1em;
}
.panel-header button{padding:2px 10px;font-size:16px;border-radius:8px;border-color:transparent;background:transparent}
.history-panel{inset:88px max(24px,calc((100% - 900px)/2)) 24px;display:flex;flex-direction:column}
#history{flex:1;min-height:0;overflow:auto;padding:24px 32px;scrollbar-width:thin}
.line{display:flex;gap:16px;margin-bottom:22px;animation:lineFadeIn .2s var(--ease-out)}
@keyframes lineFadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.avatar{
  display:grid;place-items:center;flex-shrink:0;width:34px;height:34px;border-radius:50%;
  font:600 15px var(--font-story);color:hsl(var(--hue,30) 40% 86%);
  background:hsl(var(--hue,30) 24% 22%);box-shadow:inset 0 0 0 1px hsl(var(--hue,30) 40% 70% / .25);
}
.player .avatar{color:var(--lamp-ink);background:var(--lamp);box-shadow:none}
.message{min-width:0}
.speaker{font:600 13px var(--font-story);letter-spacing:.1em;color:var(--lamp)}
.player .speaker{color:var(--teal)}
.text{font:16px/1.9 var(--font-story);white-space:pre-wrap;overflow-wrap:anywhere}
.act{color:var(--act)}
.empty-history{color:var(--muted);padding:30px}
.empty-history strong{display:block;margin-bottom:6px;font-family:var(--font-story)}
.action-panel{
  top:84px;right:32px;width:320px;max-height:min(460px,calc(100dvh - 150px));overflow:auto;
  transition:right .3s var(--ease-out);
}
main[data-has-activity="true"] .action-panel,main[data-mode="activity"] .action-panel{right:360px}
.action-group{padding:14px 18px 6px}
.action-group h3{font-size:11.5px;font-weight:600;letter-spacing:.14em;color:var(--lamp);margin:0 0 4px}
.action-group button{
  display:flex;justify-content:space-between;align-items:center;width:100%;text-align:left;
  margin:6px 0;font-size:13px;overflow-wrap:anywhere;background:color-mix(in srgb,var(--text) 3.0%,transparent);
}
.action-group button span:last-child{color:var(--lamp)}
.action-group select{width:100%}
.no-actions{padding:20px;color:var(--muted)}
.hint{font-size:11.5px;color:var(--faint)}
#latest{align-self:center;margin-bottom:12px;font-size:12px;border-radius:999px}

/* —— 其余舞台元素 —— */
.movement-toast{
  position:absolute;top:96px;left:50%;transform:translateX(-50%);
  padding:10px 26px;background:var(--glass-strong);border:1px solid var(--lamp-line);
  border-radius:999px;color:var(--lamp-strong);font:15px var(--font-story);letter-spacing:.16em;z-index:5;
  max-width:80%;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.5);
  animation:toastPop .35s var(--ease-out);
}
@keyframes toastPop{from{opacity:0;transform:translate(-50%,-10px)}to{opacity:1;transform:translate(-50%,0)}}
.visually-hidden{position:absolute;clip:rect(0,0,0,0);width:1px;height:1px;overflow:hidden}
main[data-mode="activity"] .stage-bottom{left:calc((100% - 350px) / 2);transform:translateX(-50%);width:min(840px,calc(100% - 400px))}
main[data-mode="activity"] #characters{right:350px}
main[data-mode="activity"] .dialogue{font-size:16px;max-height:100px;min-height:0}

@keyframes appear{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

@media(min-width:1500px){
  .stage-bottom{bottom:36px}
  .portrait{flex-basis:420px}
}

@media(max-width:640px){
  main{min-height:480px}
  .world-header{padding:14px 14px 30px}
  h2{font-size:19px}h1{font-size:11px;max-width:170px}
  .stage-tools{flex-wrap:wrap;justify-content:flex-end;max-width:210px;gap:6px}
  .stage-tools button{padding:6px 10px;font-size:11.5px}
  #characters{inset:84px 0 120px;gap:0}
  .portrait{min-width:0}
  .character-name{font-size:11px;padding:4px 10px;letter-spacing:.1em}
  .stage-bottom{width:calc(100% - 24px);bottom:14px}
  .dialogue-meta{left:14px;right:14px}
  .speaker-label{font-size:14px;padding:8px 14px}
  .dialogue{padding:26px 18px 6px;min-height:80px;max-height:24dvh;font-size:calc(var(--fs-story) - 1px)}
  .dialogue-footer{padding:2px 10px 12px 18px;flex-wrap:wrap}
  .dialogue-footer>span{width:100%}
  .composer{padding:14px}
  .composer-body:has(.quick-actions:not([hidden])){grid-template-columns:minmax(0,1fr)}
  .quick-actions{flex-direction:row;flex-wrap:wrap;padding:10px 0 0;border-left:0;border-top:1px solid var(--line);max-height:none}
  .quick-actions small{width:100%}
  .quick-actions{position:relative}
  .quick-group{position:static}
  .quick-actions .group-button{width:auto}
  .quick-menu{right:0;left:0;bottom:calc(100% + 8px);width:auto}
  .group-button:after{transform:rotate(90deg)}
  .composer-keys{display:none}
  .composer-footer{flex-wrap:wrap}
  .narration-composer[open]{order:5;flex-basis:100%}
  #send{margin-left:auto}
  .audience-options label:after{left:8px;right:8px;top:auto;bottom:calc(100% + 6px);width:auto;transform:none}
  .audience-options label:hover:after{transform:none}
  .reply-context p{max-height:55px}
  .history-panel{inset:76px 12px 14px}
  .panel-header{padding:12px 16px}
  #history{padding:20px 16px}
  .action-panel{top:76px;right:12px;width:calc(100% - 24px);max-height:calc(100dvh - 100px)}
  main[data-has-activity="true"] .world-header,main[data-mode="activity"] .world-header{padding-right:14px}
  main[data-mode="activity"] .stage-bottom{left:50%;width:calc(100% - 24px)}
  main[data-mode="activity"] #characters{right:0}
}
`;
