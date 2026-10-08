<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import type { InspectorSnapshot } from '../../../../packages/provider-chat/src/request-inspector.ts'
import { inspectRequests } from '../services/desktop.ts'
import DialogFrame from './DialogFrame.vue'
import { Button } from './ui/button/index.ts'
const props=defineProps<{open:boolean;instanceId:string;characters?:{id:string;name:string}[]}>()
const emit=defineEmits<{close:[]}>()
const snapshot=ref<InspectorSnapshot>(),selected=ref<number>(),busy=ref(false),error=ref(''),notice=ref('')
const actor=ref(''),search=ref(''),tab=ref('messages'),automatic=ref(true),followLatest=ref(true)
let epoch=0,timer:ReturnType<typeof setInterval>|undefined
const label=(id:string)=>props.characters?.find(c=>c.id===id)?.name??id
const actors=computed(()=>[...new Set(snapshot.value?.requests.map(r=>r.characterId)??[])])
const requests=computed(()=>snapshot.value?.requests.filter(r=>!actor.value||r.characterId===actor.value)??[])
const current=computed(()=>requests.value.find(r=>r.id===selected.value))
const matches=(text:string)=>!search.value||text.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())
const messages=computed(()=>current.value?.messages.map((m,index)=>({...m,index})).filter(m=>matches(m.content+' '+m.source.name+' '+(m.source.original??'')))??[])
const parts=computed(()=>current.value?.contextParts.filter(p=>matches(p.name+' '+p.content))??[])
const partNames:Record<string,string>={character:'当前角色',stimulus:'本次刺激',memories:'记忆',cognition:'认知',scene:'当前场景',observations:'可见观察',selfObservations:'自身观察',claims:'认识与声明',goals:'目标',items:'物品',affordances:'可用行动'}
async function refresh(enabled?:boolean){
 if(busy.value)return
 const ticket=++epoch;busy.value=true;error.value=''
 try{
  const next=await inspectRequests(props.instanceId,enabled)
  if(ticket!==epoch||!props.open)return
  snapshot.value=next
  if(actor.value&&!actors.value.includes(actor.value))actor.value=''
  if(followLatest.value||!requests.value.some(r=>r.id===selected.value))selected.value=requests.value.at(-1)?.id
 }catch{if(ticket===epoch)error.value='读取失败，请确认当前实例仍在运行。'}
 finally{if(ticket===epoch)busy.value=false}
}
function latest(){followLatest.value=true;selected.value=requests.value.at(-1)?.id}
watch(actor,latest)
watch(()=>[props.open,props.instanceId] as const,([open])=>{
 epoch++;if(timer)clearInterval(timer);timer=undefined
 snapshot.value=undefined;selected.value=undefined;error.value='';notice.value='';busy.value=false;actor.value='';search.value='';followLatest.value=true
 if(open){void refresh();timer=setInterval(()=>{if(automatic.value&&snapshot.value?.enabled&&!busy.value)void refresh()},3000)}
},{immediate:true})
onBeforeUnmount(()=>{epoch++;if(timer)clearInterval(timer)})
async function copy(text:string){try{await navigator.clipboard.writeText(text);notice.value='已复制。'}catch{notice.value='复制未完成，可在正文中选中文本复制。'}}
</script>
<template>
 <DialogFrame wide :open="open" title="实际角色请求 Inspector" description="检查真实调用的消息、授权上下文与请求参数。" @close="emit('close')">
  <div class="toolbar"><strong>{{ snapshot?.enabled?'正在采集':'采集未启用' }} · {{ snapshot?.requests.length??0 }}/4 条</strong><Button :disabled="busy||!snapshot" @click="refresh(!snapshot?.enabled)">{{ snapshot?.enabled?'停止并清空':'启用采集' }}</Button><Button variant="outline" :disabled="busy" @click="refresh()">刷新</Button><Button variant="outline" :disabled="busy||!snapshot?.requests.length" @click="refresh(snapshot?.enabled)">清空记录</Button><label><input v-model="automatic" type="checkbox"> 自动刷新（3 秒）</label></div>
  <p class="hint">仅保留本次运行最近 4 次角色调用；私有上下文不进入游戏前端。停止采集会清空，关闭窗口会继续采集。</p>
  <p v-if="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
  <p v-if="snapshot&&!snapshot.requests.length">{{ snapshot.enabled?'等待角色互动。进行一次游戏互动后，这里会更新。':'启用采集后，再进行一次角色互动。' }}</p>
  <div v-if="snapshot?.requests.length" class="toolbar"><label>角色<select v-model="actor"><option value="">全部角色</option><option v-for="id in actors" :key="id" :value="id">{{ label(id) }}</option></select></label><label>调用<select v-model="selected" @change="followLatest=false"><option v-for="request in requests" :key="request.id" :value="request.id">#{{ request.id }} · {{ label(request.characterId) }} · {{ request.continuation?'继续处理':'新刺激' }} · {{ request.status }}</option></select></label><button @click="latest">{{ followLatest?'跟随最新调用':'切回最新调用' }}</button></div>
  <template v-if="current">
   <div class="summary"><strong>{{ label(current.characterId) }}</strong><span>{{ current.model }} · {{ current.durationMs??'…' }} ms · {{ current.status }}</span><small>{{ current.startedAt }}</small><span>服务计数：输入 {{ current.usage?.inputTokens??'未提供' }} / 输出 {{ current.usage?.outputTokens??'未提供' }} / 合计 {{ current.usage?.totalTokens??'未提供' }}</span><span>请求 JSON 估算 {{ current.estimatedBodyTokens }} token（其中工具 {{ current.estimatedToolTokens }}）。</span></div>
   <p class="hint">本地估算不等于模型 tokenizer 计数；服务 total 可能包含其他计数。ok 表示传输成功，不代表决策通过 Core 校验。</p>
   <div class="toolbar tabs"><button :aria-pressed="tab==='messages'" @click="tab='messages'">消息 {{ current.messages.length }}</button><button :aria-pressed="tab==='context'" @click="tab='context'">上下文分项 {{ current.contextParts.length }}</button><button :aria-pressed="tab==='body'" @click="tab='body'">完整请求 JSON</button><input v-if="tab!=='body'" v-model="search" placeholder="查找名称或正文" aria-label="查找请求内容"></div>
   <p v-if="current.omitted">{{ current.omitted }}</p>
   <section v-if="tab==='messages'"><p v-if="!messages.length">没有匹配的消息。</p><details v-for="message in messages" :key="message.index" :open="message.source.source!=='context'"><summary>{{ message.index+1 }}. {{ message.source.name }} · {{ message.role }} · 估算 {{ message.estimatedTokens }} token</summary><div class="toolbar"><button @click="copy(message.content)">复制消息</button></div><details v-if="message.source.original!==undefined"><summary>预设原文{{ message.source.macroExpanded?'（已展开宏）':'' }}</summary><pre>{{ message.source.original }}</pre></details><pre>{{ message.content }}</pre></details></section>
   <section v-else-if="tab==='context'"><p v-if="!parts.length">没有匹配的上下文分项。</p><details v-for="part in parts" :key="part.name"><summary>{{ partNames[part.name]??part.name }} · {{ part.name }} · 估算 {{ part.estimatedTokens }} token</summary><button @click="copy(part.content)">复制分项</button><pre>{{ part.content }}</pre></details></section>
   <section v-else><button :disabled="!current.body" @click="copy(JSON.stringify(current.body,null,2))">复制完整请求 JSON</button><pre>{{ JSON.stringify(current.body,null,2) }}</pre></section>
  </template>
  <div class="dialog-actions"><Button variant="outline" @click="emit('close')">关闭窗口</Button></div>
 </DialogFrame>
</template>
<style scoped>
.toolbar { display:flex;gap:10px;align-items:center;flex-wrap:wrap; } label { display:flex;gap:6px;align-items:center;font-size:13px; } .hint {font-size:13px;color:var(--muted-foreground);margin:0;line-height:1.7;}
.summary {display:grid;gap:6px;padding:12px;background:var(--muted);border-radius:8px;font-size:13px;}.summary small{color:var(--muted-foreground);}
pre { white-space:pre-wrap;overflow-wrap:anywhere;max-height:350px;overflow:auto;font-size:13px;padding:12px;background:var(--muted); }
details { margin:10px 0; } summary {cursor:pointer;} button:not([data-slot="button"]),select,input:not([type=checkbox]) { border:1px solid var(--border);border-radius:6px;background:var(--background);padding:7px; } button{cursor:pointer;font-size:13px;}button[aria-pressed=true]{background:var(--selected);}input:not([type=checkbox]){flex:1;min-width:160px;}select{max-width:100%;} [role=alert]{color:var(--danger);}[role=status]{color:var(--success);}
button:not([data-slot="button"]),input,select,textarea{color:var(--foreground)}
</style>
