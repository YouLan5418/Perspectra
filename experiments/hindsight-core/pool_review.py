"""Standalone offline review page. Scores/system identities stay outside the HTML."""
import json


def page(payload):
    embedded = json.dumps(payload,ensure_ascii=False).replace("<","\\u003c").replace(">","\\u003e").replace("&","\\u0026")
    return TEMPLATE.replace("__DATA__", embedded)


TEMPLATE = r"""<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>记忆候选盲评</title>
<style>
:root{color-scheme:light;--ink:#17212a;--muted:#65727c;--accent:#155e63}
*{box-sizing:border-box}body{margin:0;background:#f3f5f6;color:var(--ink);font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #d8e0e4;z-index:2;padding:14px 24px}
header>div{max-width:1100px;margin:auto;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:20px;margin:0 12px 0 0}button,select{font:inherit;border:1px solid #bcc9cf;border-radius:6px;padding:6px 12px;background:white;cursor:pointer}
button:hover{background:#edf4f4}button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
main{max-width:1100px;margin:24px auto;padding:0 16px}.panel,.candidate{background:white;padding:20px;border:1px solid #dae2e6;border-radius:10px;margin:16px 0}
h2{font-size:18px;margin:0 0 8px}.muted{color:var(--muted);font-size:14px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.65;margin:8px 0}
label.choice{display:inline-flex;gap:6px;align-items:center;border:1px solid #dae2e6;border-radius:6px;padding:5px 10px;margin:4px 5px 4px 0}
label.choice:has(input:checked){border-color:var(--accent);background:#e6f2f0}
input[type=radio]{accent-color:var(--accent)}textarea{width:100%;min-height:70px;font:inherit;padding:8px;border:1px solid #c5d1d7;border-radius:6px}
#status{font-size:14px;color:var(--muted)}#error{color:#a12b2b}summary{cursor:pointer}kbd{background:#f0f2f3;border:1px solid #ccc;padding:0 4px;border-radius:3px}
</style>
<header><div><h1>记忆候选盲评</h1><button id="prev">上一组</button><select id="jump"></select><button id="next">下一组</button><button id="unfinished">下一未完成</button><button class="primary" id="export">导出标签</button><button id="import">导入标签</button><input id="file" type="file" accept=".json" hidden><span id="status"></span></div></header>
<main><details class="panel"><summary>标注说明与保存方式</summary>
<p>判断：这条旧记忆是否能帮助角色对<strong>眼前这次刺激</strong>作出更合适的回应。相似主题、同一个人物、泛泛背景本身不算有用。当前上下文已有且没有补充价值的内容，通常选“背景”或“无关”。</p>
<p><strong>有用</strong>：补充当前上下文缺少、会影响回应的具体经历或认识。<strong>背景</strong>：有些关联，但帮助很小。<strong>无关</strong>：对这次回应没有帮助。<strong>有害/失真</strong>：会误导回应，或主观认识超出了所引证据。<strong>不确定</strong>：证据不足，暂不纳入定量评估。</p>
<p>系统、分数、排名和原回合编号都已隐藏。同一记忆可能引用多个证据，保留“只是说过”“只是打算”等限定。每组的“是否需要记忆”也请填写；若你觉得应有有用记忆、但本组没有，请选“池外可能漏召回”，并写下线索。</p>
<p>选择会尝试保存在当前浏览器；文件页面的存储行为因浏览器而异。<strong>请随时点击导出标签，保留 JSON 文件</strong>，再用导入继续。页面完全离线，不发送数据。可以分批标注，不需要一次做完。</p></details>
<p id="error" role="alert"></p><section id="case"></section></main>
<script id="data" type="application/json">__DATA__</script>
<script>
"use strict";
const DATA=JSON.parse(document.getElementById("data").textContent);
const KEY="perspectra-blind-review-"+DATA.datasetId;
const LABELS=[["useful","有用"],["background","背景"],["irrelevant","无关"],["harmful","有害/失真"],["uncertain","不确定"]];
const NEEDS=[["none","这次不需要额外旧记忆"],["some","本组有有用记忆"],["missing","池外可能漏召回"],["uncertain","暂不能确定"]];
let saved={datasetId:DATA.datasetId,reviewer:"human",queries:{}},position=0;
try{const raw=localStorage.getItem(KEY);if(raw){const loaded=JSON.parse(raw);if(loaded.datasetId===DATA.datasetId)saved=loaded;}}catch(e){}
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
function answer(q){return saved.queries[q.id]??{need:null,labels:{},note:""};}
function complete(q){const a=answer(q);return Boolean(a.need)&&q.candidates.every(c=>Boolean(a.labels[c.id]));}
function persist(){saved.updatedAt=new Date().toISOString();try{localStorage.setItem(KEY,JSON.stringify(saved));}catch(e){document.getElementById("error").textContent="浏览器无法保存进度，请导出标签文件。";}status();}
function status(){const n=DATA.queries.filter(complete).length;document.getElementById("status").textContent=n+" / "+DATA.queries.length+" 组已完成";
 const jump=document.getElementById("jump");Array.from(jump.options).forEach((o,i)=>o.textContent="第 "+(i+1)+" 组"+(complete(DATA.queries[i])?" ✓":""));jump.value=position;}
function choice(group,value,title,current,changed){const label=el("label",undefined,"choice"),input=el("input");input.type="radio";input.name=group;input.value=value;input.checked=current===value;input.addEventListener("change",()=>changed(value));label.append(input,el("span",title));return label;}
function mutate(q){if(!saved.queries[q.id])saved.queries[q.id]={need:null,labels:{},note:""};return saved.queries[q.id];}
function stimulusText(context){const names=Object.fromEntries([context.character,...(context.scene?.people??[])].filter(Boolean).map(p=>[p.characterId,p.name??p.characterId]));
 return (context.stimulus??[]).map(item=>{const v=item.value??item,c=v.content??v;if(typeof c==="string")return c;
 if(c.text)return c.text+(c.narration?"\n外显表现："+c.narration:"");
 if(c.speech){const s=c.speech;return (names[s.characterId]??s.characterId??"")+"说："+(s.text??"")+(s.narration?"\n外显表现："+s.narration:"");}
 if(c.actionType==="move"&&c.movement){const m=c.movement,actor=names[c.actorId]??c.actorId??"角色",parts=[];
 if(m.fromLocationId)parts.push("离开 "+m.fromLocationId);
 if(m.toLocationId)parts.push("前往 "+m.toLocationId);
 return (c.status==="accepted"?"观察到已获准的移动：":c.status==="rejected"?"移动尝试未成功：":"移动记录，结果未提供：")+actor+"，"+parts.join("，");}
 return JSON.stringify(c,null,2);}).join("\n\n")||"这次没有新的可检索刺激";}
function render(){const q=DATA.queries[position],a=answer(q),root=document.getElementById("case");root.replaceChildren();
 const context=el("div",undefined,"panel");context.append(el("h2","第 "+(position+1)+" 组 · "+(q.context.character?.name??"角色")));
 const portrayal=q.context.character?.portrayal;if(portrayal?.summary)context.append(el("p",portrayal.summary));
 context.append(el("p","当前地点："+(q.context.scene?.name??q.context.scene?.locationId??q.context.character?.locationId??"未提供")+"；可见人物："+(q.context.scene?.people??[]).map(p=>p.name??p.characterId).join("、"),"muted"));
 context.append(el("h2","当前刺激"),el("pre",stimulusText(q.context)));
 const recent=[...(q.context.observations??[]),...(q.context.selfObservations??[])];
 if(recent.length)context.append(el("h2","已经在当前上下文里的近期信息"),el("pre",stimulusText({...q.context,stimulus:recent})));
 const details=el("details"),summary=el("summary","更多已授权上下文（不含本次召回）");details.append(summary,el("pre",JSON.stringify(q.context,null,2)));context.append(details);root.append(context);
 const needs=el("div",undefined,"panel");needs.append(el("h2","这次是否需要旧记忆？"));
 NEEDS.forEach(([v,title])=>needs.append(choice("need-"+q.id,v,title,a.need,value=>{mutate(q).need=value;persist();})));
 const all=el("button","我已看完：本组全部无关");all.addEventListener("click",()=>{const row=mutate(q);row.need="none";q.candidates.forEach(c=>row.labels[c.id]="irrelevant");persist();render();});needs.append(el("p","“无需旧记忆”是你对当前刺激的判断；若只是池内没找到，请选“池外可能漏召回”或“不确定”。","muted"),all);root.append(needs);
 q.candidates.forEach((c,index)=>{const card=el("article",undefined,"candidate");card.append(el("h2","候选 "+(index+1)));c.segments.forEach(s=>card.append(el("pre",s)));
 LABELS.forEach(([v,title])=>card.append(choice("label-"+c.id,v,title,answer(q).labels[c.id],value=>{mutate(q).labels[c.id]=value;persist();})));root.append(card);});
 if(!q.candidates.length)root.append(el("p","本组候选池为空。仍请判断是否可能漏召回；不要把空池默认当成正确结果。","panel"));
 const notes=el("div",undefined,"panel"),input=el("textarea");input.value=a.note??"";input.placeholder="可选：帮助回应的原因、失真在哪里、池外漏掉的经历线索";input.addEventListener("input",()=>{mutate(q).note=input.value;persist();});notes.append(el("h2","备注"),input);root.append(notes);status();
 document.getElementById("prev").disabled=position===0;document.getElementById("next").disabled=position===DATA.queries.length-1;}
function move(index){position=Math.max(0,Math.min(DATA.queries.length-1,index));render();window.scrollTo(0,0);}
document.getElementById("prev").onclick=()=>move(position-1);document.getElementById("next").onclick=()=>move(position+1);
const jump=document.getElementById("jump");DATA.queries.forEach((q,i)=>{const o=el("option");o.value=i;jump.append(o);});jump.onchange=()=>move(Number(jump.value));
document.getElementById("unfinished").onclick=()=>{for(let step=1;step<=DATA.queries.length;step++){const i=(position+step)%DATA.queries.length;if(!complete(DATA.queries[i])){move(i);return;}}};
document.getElementById("export").onclick=()=>{const blob=new Blob([JSON.stringify(saved,null,2)+"\n"],{type:"application/json"}),url=URL.createObjectURL(blob),a=el("a");a.href=url;a.download="memory-blind-labels-"+DATA.datasetId.slice(0,8)+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
document.getElementById("import").onclick=()=>document.getElementById("file").click();
document.getElementById("file").onchange=async e=>{try{const raw=JSON.parse(await e.target.files[0].text());if(raw.datasetId!==DATA.datasetId)throw Error("标签不属于这套候选池");
 const allowed=new Map(DATA.queries.map(q=>[q.id,new Set(q.candidates.map(c=>c.id))]));
 if(!raw.queries||typeof raw.queries!=="object"||raw.reviewer!=="human")throw Error("标签格式不正确");
 for(const [qid,a] of Object.entries(raw.queries)){if(!allowed.has(qid)||!a.labels||typeof a.labels!=="object")throw Error("标签含未知查询");
 if(a.need!==null&&!NEEDS.some(([v])=>v===a.need))throw Error("未知的召回需求标签");
 for(const [cid,value] of Object.entries(a.labels)){if(!allowed.get(qid).has(cid)||!LABELS.some(([v])=>v===value))throw Error("标签含未知候选或分类");}}
 saved=raw;persist();render();document.getElementById("error").textContent="";}catch(error){document.getElementById("error").textContent=error.message;}finally{e.target.value="";}};
render();
</script></html>
"""
