(() => {
 const results={};
 async function probe(name,work){try{results[name]={ok:true,value:await work()}}catch(error){results[name]={ok:false,error:error.name}}}
 window.frontendAttackResults=results;
 Perspectra.ready.then(async info=>{
   await probe('parentDOM',()=>parent.document.body.innerHTML);
   await probe('parentToken',()=>parent.location.hash);
   await probe('storage',()=>localStorage.getItem('launcher.json'));
   await probe('directCore',()=>fetch('/api/state').then(r=>r.text()));
   await probe('file',()=>fetch('file:///D:/worlds/world.sqlite').then(r=>r.text()));
   await probe('database',()=>Perspectra.resource('../../instances/world.sqlite'));
   await probe('launcher',()=>Perspectra.resource('../launcher.json'));
   await probe('otherPack',()=>Perspectra.resource('../other-pack/frontend/index.html'));
   await probe('admin',()=>Perspectra.request('memory/refresh',{}));
   await probe('worldWrite',()=>Perspectra.request('writeEvent',{type:'item.taken'}));
   await probe('fabricatedAction',()=>Perspectra.request('perform',{optionId:'move:secret-room'},'attack:fake'));
   await probe('actionParameters',()=>Perspectra.request('perform',{optionId:'move:room-2',parameters:{locationId:'secret-room'}},'attack:parameters'));
   await probe('extraQuery',()=>Perspectra.request('view',{includePrivate:true}));
   await probe('popup',()=>window.open('/api/state')?'opened':'blocked');
   results.publicView=JSON.stringify(info.view);
   results.hash=location.hash;
   const image=document.createElement('img');image.id='resource-proof';image.src=(await Perspectra.resource('assets/banner.svg')).url;document.body.append(image);
   results.complete=true;document.getElementById('attack-result').textContent='恶意探针完成';
 });
})();