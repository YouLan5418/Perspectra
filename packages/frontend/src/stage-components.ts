// Embedded only into the official stage. Inputs arrive normalized by the pack loader.
// Move original navigation nodes, so their events, disabled state and accessible relations travel with them.
export const COMPONENT_SCRIPT = String.raw`
 const componentWidth=matchMedia('(max-width:640px)');
 const componentSlots={
   heading:document.querySelector('.scene-heading>div'),
   index:document.querySelector('.index-browse'),
   story:document.querySelector('.stage-action-bar'),
   toolbar:document.querySelector('.stage-tools')
 };
 const navigationParts=[
   ['inventory','inventory-toggle','背包','index'],
   ['nearby','nearby-toggle','周围物品','story'],
   ['location','scene',null,'heading'],
   ['history','history-toggle','记录','toolbar'],
   ['activity','activity-discover','活动','story'],
   ['statusSummary','status-toggle',null,'heading']
 ];
 let currentComponents={},lastComponentLayout='';
 const nativePositions=new Map();
 let locationGroup;
 function placed(style){return style?.anchor!==undefined||style?.order!==undefined}
 function rememberPosition(element){
   if(nativePositions.has(element))return;
   const marker=document.createComment('official position');
   element.after(marker);nativePositions.set(element,marker);
 }
 function placeNode(parent,child,before=null){
   if(child.parentElement===parent&&(child.nextSibling===before||child.nextElementSibling===before))return;
   if(parent.moveBefore&&child.isConnected)parent.moveBefore(child,before);
   else parent.insertBefore(child,before);
 }
 function componentAppearance(element,style){
   for(const key of ['size','shape','tone','icon','anchor']){
     const attr='data-pack-'+key;
     if(style[key])element.setAttribute(attr,style[key]);else element.removeAttribute(attr);
   }
 }
 function selectComponents(){
   const settings=stageConfig?.components;
   if(!settings)return;
   for(const [id,spec] of Object.entries(settings))
     currentComponents[id]={...spec,...(componentWidth.matches?spec.narrow:{})};
   for(const [id,elementId,semantic] of navigationParts){
     const style=currentComponents[id];if(!style)continue;
     const button=node(elementId);
     componentAppearance(button,style);
     if(!semantic)continue;
     button.firstChild.nodeValue=(style.label||semantic)+(id==='inventory'?' ':'');
     if(style.label){
       button.setAttribute('aria-label',style.label+'（'+semantic+'）');
       if(id==='inventory')button.setAttribute('aria-describedby','inventory-count');
     }else{button.removeAttribute('aria-label');button.removeAttribute('aria-describedby')}
   }
   if(currentComponents.sendAudience)componentAppearance(node('send-cluster'),currentComponents.sendAudience);
   if(currentComponents.identity){
     node('characters').dataset.packIdentity='true';
     for(const label of document.querySelectorAll('.character-name'))componentAppearance(label,currentComponents.identity);
   }
   if((placed(settings.location)||placed(settings.location?.narrow))&&!locationGroup){
     const heading=node('scene').closest('h2');
     locationGroup=document.createElement('div');locationGroup.className='pack-location-group';
     heading.before(locationGroup);placeNode(locationGroup,heading);placeNode(locationGroup,node('title'));
   }
   let arranged=false;
   for(const [id,elementId] of navigationParts.slice(2)){
     if(!placed(settings[id])&&!placed(settings[id]?.narrow))continue;
     rememberPosition(id==='location'?locationGroup:node(elementId));
     if(placed(currentComponents[id]))arranged=true;
   }
   const main=document.querySelector('main');
   if(arranged)main.dataset.packNavigation='true';else delete main.dataset.packNavigation;
   lastComponentLayout='';
 }
 function placeComponents(contextVisible){
   const {inventory,nearby}=currentComponents;
   const entries=[];
   const active=document.activeElement;
   for(const [id,elementId,,fallback] of navigationParts){
     const style=currentComponents[id];
     if(!style&&!(id==='inventory'&&nearby)&&!(id==='nearby'&&inventory))continue;
     const element=id==='location'?locationGroup:node(elementId);
     if(id!=='inventory'&&id!=='nearby'&&!placed(style)){
       if(nativePositions.has(element))entries.push({element,slot:'native',order:0});
       continue;
     }
     const slot=id==='inventory'&&!node('action-panel').hidden?'index':style?.anchor||fallback;
     entries.push({element,slot,order:style?.order??5});
   }
   if(!entries.length)return;
   const layout=entries.map(row=>row.slot+':'+row.order).join('/');
   if(layout!==lastComponentLayout){
     lastComponentLayout=layout;
     // Physical order is also Tab order. Move only out-of-place nodes, from the end of each slot.
     for(const {element,slot} of entries){
       if(slot==='native'){const marker=nativePositions.get(element);placeNode(marker.parentElement,element,marker)}
     }
     for(const [slot,parent] of Object.entries(componentSlots)){
       const group=entries.filter(row=>row.slot===slot).sort((a,b)=>a.order-b.order);
       let before=null;
       for(const {element} of group.reverse()){placeNode(parent,element,before);before=element}
     }
   }
   const bag=node('inventory-toggle');
   if(inventory||nearby)bag.hidden=bag.parentElement!==componentSlots.index&&!contextVisible;
   if(entries.some(row=>row.element.contains(active))&&(!isVisible(active)||document.activeElement!==active))
     (isVisible(active)?active:node('actions-toggle')).focus({preventScroll:true});
 }
 componentWidth.addEventListener('change',()=>{selectComponents();controls()});
`

export const COMPONENT_STYLE = String.raw`
[data-stage-component][data-pack-tone="forest"]{--pack-fill:#e6f3eb;--pack-ink:#174c37;--pack-edge:#668f78}
[data-stage-component][data-pack-tone="indigo"]{--pack-fill:#ecebfa;--pack-ink:#34346d;--pack-edge:#8582ac}
button[data-stage-component][data-pack-tone]{background:var(--pack-fill);color:var(--pack-ink);border:1px solid var(--pack-edge)}
button[data-stage-component][data-pack-tone]:is(:hover,[aria-expanded="true"]):not(:disabled),
.portrait.speaking .character-name[data-pack-tone]{background:var(--pack-ink);color:var(--pack-fill)}
button[data-stage-component][data-pack-shape="soft"]{border-radius:9px}
button[data-stage-component][data-pack-shape="pill"]{border-radius:999px}
button[data-stage-component][data-pack-size="large"]{min-height:48px;--nameplate-height:48px}
/* Keep configured nameplates above both pieces of art, retaining the foreground speaker. */
#characters[data-pack-identity]{isolation:isolate}
#characters[data-pack-identity] .portrait.speaking{z-index:auto}
#characters[data-pack-identity] :is(.figure,.portrait-badge){z-index:0}
#characters[data-pack-identity] .portrait.speaking :is(.figure,.portrait-badge){z-index:1}
#characters[data-pack-identity] .character-name{z-index:2}
[data-stage-component="identity"][data-pack-anchor="above-waist"]{translate:0 -16px}
button[data-pack-icon="bag"]::before{content:"" / "";display:inline-block;width:.85em;height:.7em;border:1.5px solid currentColor;border-radius:2px;margin-inline-end:.5em;box-shadow:inset 0 2px currentColor}
button[data-pack-icon="diamond"]::before{content:"◇" / "";margin-inline-end:.35em}
.character-name[data-pack-icon="dots"]::after{content:"⋯" / "";font:700 15px/1 sans-serif;width:auto;height:auto;border:0;transform:none}
#send-cluster[data-pack-tone]::before{background:var(--pack-fill);border-color:var(--pack-edge)}
#send-cluster[data-pack-tone] #audience-button{color:var(--pack-ink)}
#send-cluster[data-pack-tone] :is(.audience-dot,.chevron){--accent:var(--pack-ink);--faint:var(--pack-ink)}
#send-cluster[data-pack-tone] #send{background:var(--pack-ink);color:var(--pack-fill);border-color:var(--pack-edge)}
#send-cluster[data-pack-size="large"] #send{width:48px;min-width:48px;height:48px}
#send-cluster[data-pack-icon="arrow"] #send svg{display:none}
#send-cluster[data-pack-icon="arrow"] #send::after{content:"➤" / "";font:20px/1 sans-serif}
#send-cluster[data-pack-anchor="footer-inset"]{margin-inline-end:16px;max-width:calc(100% - 80px)}
@media(pointer:coarse){.stage-tools :is(#inventory-toggle,#nearby-toggle),[data-pack-navigation] .stage-tools button[data-stage-component]{min-height:44px;min-width:44px}}
button[data-pack-icon="compass"]::before{content:"⌖" / "";margin-inline-end:.35em}
button[data-pack-icon="book"]::before{content:"≡" / "";margin-inline-end:.35em}
button[data-pack-icon="flag"]::before{content:"⚑" / "";margin-inline-end:.35em}
button[data-pack-icon="meter"]::before{content:"◴" / ""}
[data-pack-navigation] .scene-heading:has(>div:empty){display:none}
[data-pack-navigation] .world-header{justify-content:space-between}
[data-pack-navigation] .stage-tools{margin-inline-start:auto;min-width:0;max-width:100%;flex-wrap:wrap}
[data-pack-navigation] .stage-tools .status-bar{margin:0}
.pack-location-group{min-width:0;max-width:100%}
.pack-location-group #scene{max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.stage-tools .pack-location-group{max-width:min(32vw,18em)}
#status-toggle[data-pack-tone] :is(.status-cut,.status-chevron,.status-preview){color:inherit}
.stage-tools .pack-location-group h1{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
[data-pack-navigation] .stage-action-bar{max-width:100%;overflow-x:auto;scrollbar-width:thin;padding:4px;margin:-4px}
[data-pack-navigation] .stage-bottom:has(>#status:not([hidden])) .stage-action-bar{max-width:calc(100% - 10em)}
@media(max-width:640px){
  [data-pack-navigation] .stage-tools{flex-wrap:nowrap;justify-content:safe end;overflow-x:auto;scrollbar-width:thin;padding:4px}
  [data-pack-navigation] .stage-tools>*{flex:none}
}
/* The rail can scroll if all contextual entries coexist with unusually long labels. */
.stage-action-bar:has(#inventory-toggle),
.stage-action-bar:has(#nearby-toggle[aria-label]){max-width:100%;overflow-x:auto;scrollbar-width:thin;padding:3px;margin:-3px}
`
