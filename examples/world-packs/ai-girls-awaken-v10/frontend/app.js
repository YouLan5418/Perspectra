(() => {
 const api=window.Perspectra,node=id=>document.getElementById(id);
 let latest,posting=false,pending;
 function render(view){
   latest=view;node('title').textContent=view.game.title;
   node('scene').textContent=view.scene?view.scene.locationName+' · '+(view.scene.visibleCharacters.join('、')||'眼前没有其他角色'):'场景尚未开始';
   node('status').textContent=({ready:'可以输入',busy:'角色正在回应',paused:'已暂停',error:'处理未完成'})[view.status];
   node('history').replaceChildren();
   for(const line of view.history){
     const article=document.createElement('article');article.className='line'+(line.player?' player':'');
     const speaker=document.createElement('strong');speaker.className='speaker';speaker.textContent=line.speaker;
     article.append(speaker,document.createTextNode(line.text));node('history').append(article);
   }
   node('history').scrollTop=node('history').scrollHeight;
   node('actions').replaceChildren();
   for(const option of view.actions){
     const button=document.createElement('button');button.textContent=option.label;button.disabled=posting||view.status!=='ready';
     button.onclick=()=>send('perform',{optionId:option.id});node('actions').append(button);
   }
   node('send').disabled=posting||view.status!=='ready';
 }
 async function send(method,payload){
   if(posting)return;posting=true;
   pending={method,payload,actionId:api.newActionId()};node('send').disabled=true;node('notice').textContent='正在提交……';
   try{render(await api.request(method,payload,pending.actionId));if(method==='speak')node('input').value='';pending=null;node('notice').textContent=''}
   catch(error){node('notice').textContent=error.message+' 同一请求可点击“重试同一操作”，不会重复执行。'}
   finally{posting=false;render(await api.getView());node('retry').hidden=!pending}
 }
 const retry=document.createElement('button');retry.id='retry';retry.textContent='重试同一操作';retry.hidden=true;node('notice').after(retry);
 retry.onclick=async()=>{if(posting||!pending)return;posting=true;try{render(await api.request(pending.method,pending.payload,pending.actionId));pending=null;node('notice').textContent='';retry.hidden=true}catch(error){node('notice').textContent=error.message}finally{posting=false;render(await api.getView())}};
 node('send').onclick=()=>{const text=node('input').value.trim();if(text)send('speak',{text})};
 node('input').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();node('send').click()}};
 api.subscribe(event=>{if(event.view)render(event.view);if(event.type==='disconnected'){node('status').textContent='连接断开';node('send').disabled=true}});
 api.ready.then(info=>render(info.view));
})();