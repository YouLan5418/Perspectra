// Shared default-stage widgets consume only the public PlayerView; all content is plain text.
export const GAMEPLAY_WIDGETS = String.raw`
 let gameplayPanelsKey='',pluginControlsKey='';
 const changingControls=new Set();
 function renderGameplayPanels(view){
   const panels=view.panels||[],key=JSON.stringify(panels);if(key===gameplayPanelsKey)return;gameplayPanelsKey=key;
   const area=node('gameplay-panels');area.replaceChildren();
   for(const panel of panels){
     const section=document.createElement('section');section.className='gameplay-panel';section.dataset.panelId=panel.id;
     const heading=document.createElement('h3');heading.textContent=panel.title;section.append(heading);
     if(panel.kind==='property-table'){
       const table=document.createElement('dl');table.className='gameplay-properties';
       for(const row of panel.properties){const term=document.createElement('dt'),value=document.createElement('dd');
         term.textContent=row.label;value.textContent=typeof row.value==='string'?row.value:JSON.stringify(row.value);table.append(term,value)}
       section.append(table);
     }else{
       const list=document.createElement('ul');list.className='gameplay-entries';
       for(const entry of panel.entries){const item=document.createElement('li'),title=document.createElement('strong'),content=document.createElement('p');
         title.textContent=entry.title;content.textContent=entry.content;item.append(title,content);list.append(item)}
       if(!panel.entries.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='暂时没有条目。';section.append(empty)}
       section.append(list);
     }
     area.append(section);
   }
 }
 function updateGameplayControls(blocked){
   for(const input of node('gameplay-controls').querySelectorAll('input,select'))
     input.disabled=input.dataset.unavailable==='true'||changingControls.has(input.dataset.controlId)||(input.dataset.scope==='world'&&blocked);
 }
 function renderPluginControls(view){
   const entries=view.pluginControls||[],key=JSON.stringify([entries,[...changingControls]]);
   node('gameplay-settings').hidden=!entries.length;
   if(key===pluginControlsKey)return;pluginControlsKey=key;
   const area=node('gameplay-controls');area.replaceChildren();
   for(const control of entries){
     const label=document.createElement('label');label.className='setting-check';
     const text=document.createElement('span');text.textContent=control.label;
     const note=document.createElement('small');note.textContent=control.description||(control.scope==='world'?'通过游戏规则生效，随世界状态保存。':'保存在当前游玩偏好中。');text.append(note);
     let input;
     if(control.kind==='boolean'){input=document.createElement('input');input.type='checkbox';input.setAttribute('role','switch');input.checked=control.value}
     else{input=document.createElement('select');for(const option of control.options){const item=document.createElement('option');item.value=option.value;item.textContent=option.label;input.append(item)}input.value=control.value}
     input.dataset.controlId=control.id;input.dataset.scope=control.scope;input.dataset.unavailable=String(!!control.disabled);
     input.onchange=async()=>{
       const value=control.kind==='boolean'?input.checked:input.value;
       changingControls.add(control.id);input.disabled=true;node('gameplay-control-notice').textContent='正在更新…';
       let result;
       try{result=await api.setPluginControl(control.id,value);
         const applied=result.pluginControls?.find(row=>row.id===control.id);
         node('gameplay-control-notice').textContent=applied?.value===value?'已更新。':result.feedback?.message||'设置未改变，请检查当前条件。';
       }catch(error){node('gameplay-control-notice').textContent=error.message}
       finally{changingControls.delete(control.id);pluginControlsKey='';render(result||latest)}
     };
     label.append(text,input);area.append(label);
   }
 }
`
