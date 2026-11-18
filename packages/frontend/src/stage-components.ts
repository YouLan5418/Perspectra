// Embedded only into the official stage. Inputs arrive normalized by the pack loader.
// Move original navigation nodes, so their events, disabled state and accessible relations travel with them.
export const COMPONENT_SCRIPT = String.raw`
 const componentWidth=matchMedia('(max-width:640px)');
 const componentSlots={
   index:document.querySelector('.index-browse'),
   story:document.querySelector('.stage-action-bar'),
   toolbar:document.querySelector('.stage-tools')
 };
 let currentComponents={},lastComponentLayout='';
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
   for(const [id,elementId,semantic] of [['inventory','inventory-toggle','背包'],['nearby','nearby-toggle','周围物品']]){
     const style=currentComponents[id];if(!style)continue;
     const button=node(elementId);
     componentAppearance(button,style);
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
   lastComponentLayout='';
 }
 function placeComponents(contextVisible){
   const {inventory,nearby}=currentComponents;
   if(!inventory&&!nearby)return;
   const bag=node('inventory-toggle'),around=node('nearby-toggle');
   const bagSlot=node('action-panel').hidden?(inventory?.anchor||'index'):'index';
   const aroundSlot=nearby?.anchor||'story';
   const layout=[bagSlot,aroundSlot,inventory?.order,nearby?.order].join('/');
   const active=document.activeElement;
   if(layout!==lastComponentLayout){
     lastComponentLayout=layout;
     const entries=[[bag,bagSlot,inventory?.order??5],[around,aroundSlot,nearby?.order??5]];
     for(const [element,slot] of entries.sort((a,b)=>a[2]-b[2])){
       const parent=componentSlots[slot];
       if(parent.lastElementChild!==element)parent.append(element);
     }
   }
   bag.hidden=bagSlot!=='index'&&!contextVisible;
   if((active===bag||active===around)&&(!isVisible(active)||document.activeElement!==active))
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
@media(pointer:coarse){.stage-tools button[data-stage-component]{min-height:44px;min-width:44px}}
/* The rail can scroll if all contextual entries coexist with unusually long labels. */
.stage-action-bar:has(#inventory-toggle),
.stage-action-bar:has(#nearby-toggle[aria-label]){max-width:100%;overflow-x:auto;scrollbar-width:thin;padding:3px;margin:-3px}
`
