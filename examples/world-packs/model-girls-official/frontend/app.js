(() => {
 const api=window.Perspectra,node=id=>document.getElementById(id);
 const people=[['GPT','🐉','#d9e9de'],['Claude','📚','#efd8b7'],['DeepSeek','🐳','#afd3ed'],['GLM','💻','#c7bfdf']];
 let waitingSince=0,historyKey;
 let view,posting=false,pending=null,auto=false,connected=true;
 for(const [name,icon,color] of people){const el=document.createElement('div');el.className='girl';el.dataset.name=name;el.dataset.icon=icon;el.style.setProperty('--color',color);const label=document.createElement('span');label.textContent=name;el.append(label);node('cast').append(el)}
 const inPrologue=()=>view?.activity?.active&&view.activity.phase==='prologue';
 const nextOption=()=>view?.actions.find(a=>a.label==='继续')??view?.actions.find(a=>a.label==='恢复当前活动节点');
 const startOption=()=>view?.actions.find(a=>a.label.startsWith('开始 '));
 const canInteract=()=>view&&connected&&!posting&&!auto&&['ready','error'].includes(view.status);
 function infoOpen(open){node('info-popover').hidden=!open;node('info-toggle').setAttribute('aria-expanded',String(open));}
 function menuOpen(open){if(open)infoOpen(false);node('audience-menu').hidden=!open;node('audience-toggle').setAttribute('aria-expanded',String(open));if(!open)openRecipients(null);}
 function openRecipients(scope){for(const group of document.querySelectorAll('.scope-group')){const open=group.dataset.scope===scope;group.querySelector('.recipient-menu').hidden=!open;group.querySelector('button').setAttribute('aria-expanded',String(open));}}
 function chooseAudience(scope,id){if(!canInteract())return;if(['direct','private'].includes(scope)&&!view.scene?.recipients?.some(p=>p.id===id))return;node('scope').value=scope;node('recipient').value=id||'';audience();menuOpen(false);node('input').focus();}
 function audience(){const scope=node('scope').value,name=node('recipient').selectedOptions[0]?.textContent;node('audience-label').textContent=({scene_public:'公开',direct:'定向',private:'私密',self:'仅自己'})[scope]+(name&&['direct','private'].includes(scope)?' · '+name:'');node('audience').textContent=scope==='direct'?(name?'只有 '+name+' 收到，其他人不知道交流发生。':'请选择一位在场角色作为接收者。'):scope==='private'?(name?'只有 '+name+' 收到完整内容，旁观者只知道发生了私密交流。':'请选择一位在场角色作为接收者。'):scope==='self'?'只保留在你自己的经历中。':'在场且有权观察的角色收到完整内容。';}
 function refreshRecipients(recipients){const select=node('recipient');if(select.dataset.loaded==='true'&&JSON.stringify([...select.options].map(o=>[o.value,o.textContent]))===JSON.stringify(recipients.map(p=>[p.id,p.name])))return;select.dataset.loaded='true';const old=select.value;select.replaceChildren();for(const person of recipients){const option=document.createElement('option');option.value=person.id;option.textContent=person.name;select.append(option)}select.value=recipients.some(p=>p.id===old)?old:'';
   for(const group of document.querySelectorAll('.scope-group')){const menu=group.querySelector('.recipient-menu');menu.replaceChildren();for(const person of recipients){const b=document.createElement('button');b.type='button';b.setAttribute('role','menuitem');b.textContent=person.name;b.onclick=()=>chooseAudience(group.dataset.scope,person.id);menu.append(b)}if(!recipients.length){const p=document.createElement('p');p.textContent='当前没有可选择的在场角色';menu.append(p)}}
 }
 node('info-toggle').onclick=()=>{const open=node('info-popover').hidden;menuOpen(false);infoOpen(open)};
 node('details-toggle').onclick=()=>{const open=node('detail-panel').hidden;node('detail-panel').hidden=!open;node('details-toggle').setAttribute('aria-expanded',String(open));node('details-toggle').querySelector('.chevron').textContent=open?'⌃':'⌄';};
 document.addEventListener('pointerdown',event=>{if(!node('audience-info').contains(event.target))infoOpen(false)});
 node('audience-info').addEventListener('focusout',event=>{if(!node('audience-info').contains(event.relatedTarget))infoOpen(false)});
 node('audience-info').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();infoOpen(false);node('info-toggle').focus()}});
 node('audience-toggle').onclick=()=>menuOpen(node('audience-menu').hidden);
 for(const b of node('audience-menu').querySelectorAll('button[data-scope]')){b.onclick=()=>chooseAudience(b.dataset.scope);b.onmouseenter=()=>openRecipients(null);b.onfocus=()=>openRecipients(null);}
 for(const group of document.querySelectorAll('.scope-group')){const b=group.querySelector('button');group.onmouseenter=()=>openRecipients(group.dataset.scope);b.onfocus=()=>openRecipients(group.dataset.scope);b.onclick=()=>openRecipients(group.dataset.scope);b.onkeydown=event=>{if(event.key==='ArrowRight'){event.preventDefault();group.querySelector('.recipient-menu button')?.focus()}};}
 document.addEventListener('pointerdown',event=>{if(!node('audience-picker').contains(event.target))menuOpen(false)});
 node('audience-picker').addEventListener('focusout',event=>{if(!node('audience-picker').contains(event.relatedTarget))menuOpen(false)});
 node('audience-picker').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();menuOpen(false);node('audience-toggle').focus()}});
 function renderHistory(maskNames){const rows=view.history.filter(h=>h.text.trim()),key=JSON.stringify([rows,maskNames]);if(key===historyKey)return;historyKey=key;const list=node('history'),top=list.scrollTop,follow=list.scrollHeight-list.clientHeight-top<40;list.replaceChildren();
   for(const row of rows){const entry=document.createElement('article'),name=document.createElement('strong'),body=document.createElement('div');entry.className='history-entry';name.className='history-speaker';name.textContent=maskNames?'？？？':row.speaker;const colors={GPT:'#a6d9b8',Claude:'#efd2a5',DeepSeek:'#9dcbea',GLM:'#c1b1eb'};name.style.color=maskNames?'#beb3c9':row.player?'#f5bad5':colors[row.speaker]||'#beb3c9';body.className='history-lines';
     if(row.segments?.length){for(const segment of row.segments){const p=document.createElement('p');p.textContent=segment.text;p.className=segment.type==='narration'?'history-narration':'history-speech';body.append(p)}}else{const p=document.createElement('p');p.textContent=row.text;body.append(p)}entry.append(name,body);list.append(entry);
   }
   if(!rows.length){const p=document.createElement('p');p.className='history-empty';p.textContent='还没有历史记录';list.append(p)}list.scrollTop=follow?list.scrollHeight:top;
 }
 node('history-toggle').onclick=()=>{menuOpen(false);infoOpen(false);node('history-dialog').showModal();node('history-close').focus();document.body.classList.add('history-open');node('history').scrollTop=node('history').scrollHeight;};
 node('history-close').onclick=()=>node('history-dialog').close();
 node('history-latest').onclick=()=>{node('history').scrollTop=node('history').scrollHeight;};
 node('history-dialog').addEventListener('close',()=>{document.body.classList.remove('history-open');node('history-toggle').focus()});
 node('history-dialog').addEventListener('click',event=>{if(event.target!==node('history-dialog'))return;const r=event.target.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)event.target.close()});
 function render(next){
   if(next.status==='busy'&&!waitingSince)waitingSince=Date.now();if(next.status!=='busy')waitingSince=0;
   view=next;responseStatus();const prologue=inPrologue(),started=view.activity?.phase!=='not-started',beat=view.activity?.public.lastBeat;
   node('free').hidden=prologue||!started;node('play-controls').hidden=started&&!prologue;
   node('stage').classList.toggle('dark',prologue&&(!beat||beat.index<7));node('cast').setAttribute('aria-hidden',String(prologue&&(!beat||beat.index<7)));
   const recent=view.history.filter(h=>h.text.trim()).at(-1);
   if(prologue&&beat){node('speaker').textContent=beat.index<7?'？？？':beat.actorId==='character:player'?'玩家':people.find(p=>'character:'+p[0].toLowerCase()===beat.actorId)?.[0]||'';node('line').textContent=beat.text;node('expression').textContent=beat.expression;node('chapter').textContent=beat.chapter;}
   else if(prologue){node('speaker').textContent='？？？';node('line').textContent='黑屏中传来几个人的声音。点击继续。';node('expression').textContent='';node('chapter').textContent='序章 · 服务暂时不可用';}
   else if(recent){node('speaker').textContent=recent.speaker;node('line').textContent=recent.text;node('expression').textContent='';node('chapter').textContent=prologue?'序章 · 服务暂时不可用':'自由生活';}
   node('time').textContent='第 '+(view.activity?.public.day||1)+' 天 · '+(view.activity?.public.period||'接近中午');
   for(const el of node('cast').children)el.classList.toggle('active',prologue?beat?.actorId==='character:'+el.dataset.name.toLowerCase():recent?.speaker===el.dataset.name);
   renderHistory(prologue&&(!beat||beat.index<7));
   node('scene').textContent=view.scene?view.scene.locationName+' · '+view.scene.visibleCharacters.join('、'):'';
   refreshRecipients(view.scene?.recipients||[]);audience();
   node('actions').replaceChildren();for(const option of view.actions){if(option.label==='继续')continue;const b=document.createElement('button');b.textContent=option.label;b.onclick=()=>send('perform',{optionId:option.id});b.disabled=posting||auto||!['ready','error'].includes(view.status);node('actions').append(b)}
   node('advance').textContent=prologue?'继续':'开始序章';node('advance').disabled=posting||auto||!connected||!['ready','error'].includes(view.status)||!(prologue?nextOption():startOption());
   for(const id of ['fast','skip'])node(id).disabled=posting||auto||!prologue||!['ready','error'].includes(view.status);node('stop').hidden=!auto;
   for(const id of ['input','narration','scope','recipient','send','audience-toggle'])node(id).disabled=posting||auto||!connected||!['ready','error'].includes(view.status);
   const loading=connected&&(posting||view.status==='busy');node('send').classList.toggle('loading',loading);node('send').setAttribute('aria-busy',String(loading));node('send').title=loading?'正在处理，请稍候':'发送';if(!canInteract())menuOpen(false);
   node('retry').hidden=!pending;node('retry').disabled=posting||!connected;
 }
 function responseStatus(){if(!view)return;const el=node('response-status');el.dataset.state=view.status;el.textContent=view.status==='busy'?(view.feedback?.phase||'正在处理')+' · 已等待 '+Math.floor((Date.now()-waitingSince)/1000)+' 秒。角色依次处理，已发表的回应会立即显示。':view.status==='paused'?'角色已暂停，请使用外层恢复。':view.feedback?.message||'可以继续行动。';}
 setInterval(responseStatus,1000);
 async function execute(work){pending=work;posting=true;render(view);try{const next=await api.request(work.method,work.payload,work.actionId);pending=null;if(next.status==='error')auto=false;node('notice').textContent='';if(work.method==='speak'){node('input').value='';node('narration').value=''}render(next);return next}catch(error){auto=false;node('notice').textContent=error.message+'。已提交的经历保留；可重试同一操作或使用外层活动恢复。';throw error}finally{posting=false;render(view)}}
 async function send(method,payload){if(!canInteract())return;try{await execute({method,payload,actionId:api.newActionId()})}catch{}}
 node('advance').onclick=()=>{const option=inPrologue()?nextOption():startOption();if(option)send('perform',{optionId:option.id})};
 async function forward(skip){if(auto||posting||!inPrologue())return;auto=true;document.body.classList.toggle('skipping',skip);node('notice').textContent=skip?'正在合法提交剩余剧情，完成后交还输入……':'快进中，可随时停止。';render(view);try{while(auto&&inPrologue()){const option=nextOption();if(!option)break;await execute({method:'perform',payload:{optionId:option.id},actionId:api.newActionId()});if(!skip)await new Promise(resolve=>setTimeout(resolve,180));}}catch{}finally{auto=false;document.body.classList.remove('skipping');render(view)}}
 node('fast').onclick=()=>forward(false);node('skip').onclick=()=>forward(true);node('stop').onclick=()=>{auto=false;};
 node('retry').onclick=async()=>{if(posting||!pending)return;try{await execute(pending)}catch{}};
 function compose(){const text=node('input').value.trim(),narration=node('narration').value.trim(),scope=node('scope').value;if(!text&&!narration)return;const maximum=view.settings?.inputCharacters||2000;if(text.length+narration.length>maximum){node('notice').textContent='发言和描写合计不能超过 '+maximum+' 个字符。';return}const addresseeIds=['direct','private'].includes(scope)?[node('recipient').value]:[];if(addresseeIds.some(id=>!view.scene?.recipients?.some(p=>p.id===id))){node('notice').textContent='请选择一位当前在场的接收者。';return;}send('speak',{text,narration,scope,addresseeIds})};
 node('send').onclick=compose;node('composer').onsubmit=event=>event.preventDefault();
 node('input').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();compose()}};
 node('scope').onchange=audience;node('recipient').onchange=audience;
 api.subscribe(event=>{if(event.view)render(event.view);if(event.type==='disconnected'){connected=false;auto=false;node('notice').textContent='连接已断开。重新进入后从已提交进度继续。';render(view)}});
 api.ready.then(info=>render(info.view));
})();
