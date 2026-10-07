<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RolePreset } from '../../../../packages/provider-chat/src/preset.ts'
import { namedPreset, importPresets, exportPresets, type NamedPreset } from '../../../../packages/provider-chat/src/preset-library.ts'
import { useLauncherStore } from '../stores/launcher.ts'
import { savePresetFile } from '../services/desktop.ts'
const props=defineProps<{preset:RolePreset;canApply:boolean}>()
const emit=defineEmits<{apply:[RolePreset]}>()
const store=useLauncherStore(),search=ref(''),selected=ref(''),name=ref(''),message=ref(''),error=ref(''),removing=ref(false)
const pending=ref<NamedPreset[]>([]),importText=ref(''),importName=ref(''),fileInput=ref<HTMLInputElement>(),fileBusy=ref(false)
const library=computed(()=>store.presets.library??[])
const entries=computed(()=>library.value.filter(e=>e.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())))
const entry=computed(()=>library.value.find(e=>e.id===selected.value))
watch(selected,()=>{name.value=entry.value?.name??'';removing.value=false;error.value='';message.value=''}, {flush:'sync'})
async function action(operation:string,data:Record<string,unknown>){
 error.value='';message.value=''
 if(!await store.libraryAction(operation,data)){error.value=store.notice;return false}
 return true
}
async function create(){try{if(await action('preset-library-add',{entry:namedPreset({name:name.value,preset:props.preset})})){selected.value=library.value.at(-1)?.id??'';message.value='已保存到预设库。'}}catch(e){error.value=e instanceof Error?e.message:'保存失败。'}}
async function update(renameOnly=false){
 if(!entry.value)return
 try{if(await action('preset-library-update',{id:entry.value.id,entry:namedPreset({name:name.value,preset:renameOnly?entry.value.preset:props.preset})}))message.value=renameOnly?'已重命名。':'已用当前草稿更新库中预设。'}catch(e){error.value=e instanceof Error?e.message:'更新失败。'}
}
async function remove(){if(!entry.value)return;if(await action('preset-library-remove',{id:entry.value.id})){selected.value='';message.value='已删除库中预设，已应用的副本继续保留。'}}
function apply(){if(entry.value){emit('apply',JSON.parse(JSON.stringify(entry.value.preset)) as RolePreset);message.value='已填入当前编辑范围，保存配置后生效。'}}
async function readFile(event:Event){
 const input=event.target as HTMLInputElement,file=input.files?.[0];input.value=''
 if(!file)return
 fileBusy.value=true;pending.value=[];error.value='';message.value=''
 try{
  if(file.size>4_000_000)throw new Error('预设文件过大，请控制在 4 MB 以内。')
  importName.value=file.name.replace(/\.json$/i,'').slice(0,80)||'导入预设'
  importText.value=await file.text();pending.value=importPresets(importText.value,importName.value)
 }catch(e){error.value=e instanceof Error?e.message:'无法读取文件。'}finally{fileBusy.value=false}
}
async function commitImport(){if(await action('preset-library-import',{text:importText.value,name:importName.value})){pending.value=[];importText.value='';selected.value=library.value.at(-1)?.id??'';message.value='导入完成；同名预设已另存。'}}
async function download(all=false,current=false){
 error.value='';message.value=''
 try{
  const values=current?[namedPreset({name:name.value||'当前预设',preset:props.preset})]:all?library.value:entry.value?[entry.value]:[]
  const filename=(all?'预设库':values[0]?.name??'预设').replace(/[<>:"/\\|?*]/g,'_')+'.json'
  if(await savePresetFile(exportPresets(values,!all),filename))message.value='已导出原生预设 JSON。'
 }catch(e){error.value=e instanceof Error?e.message:'导出失败。'}
}
</script>
<template>
 <section class="library-panel" aria-label="命名预设库">
  <h3>命名预设库 <small>{{ library.length }} 个</small></h3>
  <p>应用时复制内容；修改预设库不会自动改变实例或角色。</p>
  <input v-model="search" aria-label="搜索预设库" placeholder="搜索名称">
  <select v-model="selected" aria-label="库中预设"><option value="">选择预设</option><option v-for="item in entries" :key="item.id" :value="item.id">{{ item.name }}</option></select>
  <p v-if="entry">{{ entry.preset.nodes?.length??0 }} 个节点 · {{ entry.preset.textRules?.length??0 }} 条文本规则</p>
  <details v-if="entry"><summary>查看库中内容</summary><pre>{{ JSON.stringify(entry.preset,null,2) }}</pre></details>
  <label>预设名称<input v-model="name" maxlength="80" placeholder="例如：自然对白"></label>
  <div class="buttons"><button :disabled="store.busy||!entry||!canApply" @click="apply">应用到当前范围</button><button :disabled="store.busy||!name.trim()" @click="create">当前草稿另存为新预设</button></div>
  <div v-if="entry" class="buttons"><button :disabled="store.busy||!name.trim()" @click="update(true)">重命名</button><button :disabled="store.busy||!name.trim()" @click="update()">用当前草稿覆盖库中内容</button><button :disabled="store.busy" @click="removing=true">删除库中预设</button></div>
  <div v-if="removing&&entry" class="buttons"><span>删除「{{ entry.name }}」？已应用副本保留。</span><button :disabled="store.busy" @click="remove">确认删除</button><button @click="removing=false">取消删除</button></div>
  <hr><strong>导入导出</strong><p>导出带 format 与 schemaVersion: 1 的原生 JSON；支持单项与整库导入。</p>
  <input ref="fileInput" hidden type="file" accept=".json,application/json" @change="readFile">
  <div class="buttons"><button :disabled="store.busy||fileBusy" @click="fileInput?.click()">导入 JSON</button><button :disabled="store.busy" @click="download(false,true)">导出当前草稿</button><button :disabled="store.busy||!entry" @click="download()">导出所选预设</button><button :disabled="store.busy||!library.length" @click="download(true)">导出整个库</button></div>
  <div v-if="pending.length" class="import-preview"><strong>待导入 {{ pending.length }} 个预设</strong><p v-for="(item,index) in pending" :key="index">{{ item.name }} · {{ item.preset.nodes?.length??0 }} 节点 / {{ item.preset.textRules?.length??0 }} 规则</p><p>同名内容另存，不覆盖已有预设。</p><button :disabled="store.busy" @click="commitImport">加入预设库</button><button @click="pending=[];importText=''">取消导入</button></div>
  <p v-if="message" role="status">{{ message }}</p><p v-if="error" role="alert">{{ error }}</p>
 </section>
</template>
<style scoped>
.library-panel { align-self:start;position:sticky;top:0;max-height:calc(100dvh - 100px);overflow:auto;display:grid;gap:10px;font-size:12px;align-content:start;padding:14px;background:#f2f4ed;border-radius:8px; }
@media(max-width:760px){.library-panel{position:static;max-height:none;}}
h3,p { margin:0; } p { line-height:1.6; } small { font-weight:normal; } label { display:grid;gap:5px; } input,select { min-width:0;width:100%;border:1px solid #dce1d5;border-radius:6px;padding:8px;background:white; }
.buttons { display:flex;gap:6px;flex-wrap:wrap; } button { padding:6px 8px;border:1px solid #dce1d5;border-radius:5px;background:white;cursor:pointer; } button:disabled { opacity:.45;cursor:default; } pre { white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto; } [role=alert] { color:#a03728; } [role=status] { color:#365b39; } summary {cursor:pointer;}
</style>
