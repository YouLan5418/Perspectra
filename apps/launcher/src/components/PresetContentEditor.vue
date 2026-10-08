<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { rolePreset, type RolePreset, type PromptNode, type TextRule } from '../../../../packages/provider-chat/src/preset.ts'
import { presetMacros } from '../../../../packages/provider-chat/src/preset-macros.ts'
import { REGEX_WORKER_PROGRAM, type TextResult } from '../../../../packages/provider-chat/src/preset-regex.ts'
const props = defineProps<{ modelValue: RolePreset }>()
const emit = defineEmits<{ 'update:modelValue': [RolePreset] }>()
const nodes = computed(() => props.modelValue.nodes ?? [])
const rules = computed(() => props.modelValue.textRules ?? [])
function setNodes(value: PromptNode[]) { emit('update:modelValue', { ...props.modelValue, nodes: value }) }
function setRules(value: TextRule[]) { emit('update:modelValue', { ...props.modelValue, textRules: value }) }
function node(index: number, patch: Partial<PromptNode>) { setNodes(nodes.value.map((n, i) => i === index ? { ...n, ...patch } : n)) }
function rule(index: number, patch: Partial<TextRule>) { setRules(rules.value.map((r, i) => i === index ? { ...r, ...patch } : r)) }
function move<T>(values: readonly T[], index: number, delta: number): T[] {
  const result = [...values], destination = index + delta
  if (destination >= 0 && destination < result.length) [result[index], result[destination]] = [result[destination]!, result[index]!]
  return result
}
const expanded = ref('')
const removed = ref<{kind:'node';value:PromptNode;index:number}|{kind:'rule';value:TextRule;index:number}>()
function removeNode(index:number){removed.value={kind:'node',value:{...nodes.value[index]!},index};setNodes(nodes.value.filter((_,i)=>i!==index))}
function removeRule(index:number){removed.value={kind:'rule',value:{...rules.value[index]!},index};setRules(rules.value.filter((_,i)=>i!==index))}
function undo(){const entry=removed.value;if(!entry)return;if(entry.kind==='node'){const values=[...nodes.value];values.splice(entry.index,0,entry.value);setNodes(values)}else{const values=[...rules.value];values.splice(entry.index,0,entry.value);setRules(values)}removed.value=undefined}
function duplicateNode(index:number){const value={...nodes.value[index]!,id:crypto.randomUUID(),name:nodes.value[index]!.name.slice(0,72)+' 副本'};const values=[...nodes.value];values.splice(index+1,0,value);expanded.value=value.id;setNodes(values)}
function duplicateRule(index:number){const value={...rules.value[index]!,id:crypto.randomUUID(),name:rules.value[index]!.name.slice(0,72)+' 副本'};const values=[...rules.value];values.splice(index+1,0,value);expanded.value=value.id;setRules(values)}
function regexError(rule:TextRule){try{if(!/^[gimsu]*$/.test(rule.flags))return '标志仅支持 g、i、m、s、u。';new RegExp(rule.pattern,rule.flags);return ''}catch(e){return e instanceof Error?e.message:'表达式无效。'}}
function addNode() { expanded.value=crypto.randomUUID();setNodes([...nodes.value, { id: expanded.value, name: '新提示', enabled: true, role: 'system', position: 'beforeContext', content: '' }]) }
function addRule() { expanded.value=crypto.randomUUID();setRules([...rules.value, { id: expanded.value, name: '新文本规则', enabled: true, stage: 'display', target: 'both', pattern: '', flags: 'g', replacement: '' }]) }
function convertPrompt() {
  emit('update:modelValue', { ...props.modelValue, prompt: '', nodes: [{ id: crypto.randomUUID(), name: '角色表达', enabled: true, role: 'system', position: 'beforeContext', content: props.modelValue.prompt ?? '' }, ...nodes.value] })
}
const stage = ref<TextRule['stage']>('display'), target = ref<'speech' | 'narration'>('speech')
const sample = ref('你好，<draft>这段不公开</draft>欢迎回来。')
const result = ref<TextResult>(), error = ref(''), busy = ref(false)
const sampleMessages = ref<{ role: string; content: string }[]>([])
let worker: Worker | undefined
let cancel: (() => void) | undefined
onBeforeUnmount(() => cancel?.())
watch(()=>props.modelValue,()=>{cancel?.();result.value=undefined;sampleMessages.value=[];error.value=''}, {deep:true})
async function inspect() {
  cancel?.(); error.value = ''; result.value = undefined; sampleMessages.value = []; busy.value = true
  try {
    const preset = rolePreset(props.modelValue)
    const expand = presetMacros({ char: '示例角色', user: '示例玩家', scene: '示例场景', date: '示例日期', time: '示例时间' })
    const messages = (preset.nodes ?? []).filter(n => n.enabled).map(n => ({ ...n, content: expand(n.content) })).filter(n => n.content.trim())
    sampleMessages.value = [{ role: 'system', content: 'Core 角色契约（固定）' },
      ...(preset.prompt?.trim() ? [{ role: 'system', content: preset.prompt }] : []),
      ...messages.filter(n => n.position === 'beforeContext'), { role: 'user', content: '当前角色的授权上下文（示例占位）' }, ...messages.filter(n => n.position === 'afterContext')]
    const url = URL.createObjectURL(new Blob([REGEX_WORKER_PROGRAM + `self.onmessage=e=>{try{self.postMessage({results:run(e.data)})}catch(error){self.postMessage({error:error.message})}};`], { type: 'text/javascript' }))
    try { worker = new Worker(url) } finally { URL.revokeObjectURL(url) }
    const activeWorker = worker
    result.value = await new Promise<TextResult>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); activeWorker.terminate(); if (worker === activeWorker) { worker = undefined; cancel = undefined } }
      const fail = (message: string) => { cleanup(); reject(new Error(message)) }
      const timer = setTimeout(() => fail('文本处理超时，请调整表达式。'), 1000)
      cancel = () => fail('预览已取消。')
      activeWorker.onerror = () => fail('文本规则预览失败。')
      activeWorker.onmessage = event => {
        cleanup()
        if (event.data.error) reject(new Error(event.data.error))
        else resolve(event.data.results[0])
      }
      activeWorker.postMessage([{ text: sample.value, stage: stage.value, target: target.value, rules: preset.textRules ?? [], inspect: true }])
    })
  } catch (e) { error.value = e instanceof Error ? e.message : '预览失败。' }
  finally { busy.value = false }
}
const text = (event: Event) => (event.target as HTMLInputElement).value
const checked = (event: Event) => (event.target as HTMLInputElement).checked
</script>
<template>
  <section class="content-editor">
    <div class="row"><strong>提示节点 · {{ nodes.filter(n=>n.enabled).length }}/{{ nodes.length }} 启用</strong><button type="button" :disabled="nodes.length >= 64" @click="addNode">添加节点</button><button v-if="modelValue.prompt" type="button" @click="convertPrompt">将附加提示转为节点</button></div>
    <p>节点按列表顺序求值，再放入所选位置。Core 契约固定在最前；上下文只属于当前角色。</p>
    <details v-for="(n, i) in nodes" :key="n.id" class="item" :open="expanded===n.id||i===0"><summary>{{ i+1 }}. {{ n.name||'未命名节点' }} · {{ n.role }} · {{ n.enabled?'启用':'停用' }} · {{ n.content.length }} 字符</summary>
      <div class="row"><label><input type="checkbox" :checked="n.enabled" @change="node(i, { enabled: checked($event) })"> 启用</label><input aria-label="节点名称" :value="n.name" maxlength="80" @input="node(i, { name: text($event) })"><button type="button" :disabled="i === 0" @click="setNodes(move(nodes, i, -1))">上移</button><button type="button" :disabled="i === nodes.length - 1" @click="setNodes(move(nodes, i, 1))">下移</button><button type="button" :disabled="nodes.length>=64" @click="duplicateNode(i)">复制</button><button type="button" @click="removeNode(i)">删除</button></div>
      <div class="row"><label>身份<select :value="n.role" @change="node(i, { role: text($event) as PromptNode['role'] })"><option value="system">系统</option><option value="user">用户</option><option value="assistant">助手</option></select></label><label>位置<select :value="n.position" @change="node(i, { position: text($event) as PromptNode['position'] })"><option value="beforeContext">上下文之前</option><option value="afterContext">上下文之后</option></select></label></div>
      <textarea aria-label="节点内容" :value="n.content" maxlength="16000" rows="3" @input="node(i, { content: text($event) })" />
    </details>
    <p v-pre>宏：{{char}}、{{user}}、{{scene}}、{{date}}、{{time}}；{{setvar::名称::值}}、{{getvar::名称}}、{{random::甲::乙}}、{{roll::1d6}}、{{trim}}、{{//注释}}。变量仅在本次角色请求内有效，不支持嵌套宏。</p>
    <div class="row"><strong>文本处理规则 · {{ rules.filter(r=>r.enabled).length }}/{{ rules.length }} 启用</strong><button type="button" :disabled="rules.length >= 32" @click="addRule">添加正则</button></div>
    <p>按列表顺序处理指定字段。发布前规则影响公开表达；展示规则只改变玩家看到的文字。替换文本按纯文本展示。</p>
    <details v-for="(r, i) in rules" :key="r.id" class="item" :open="expanded===r.id||i===0"><summary>{{ i+1 }}. {{ r.name||'未命名规则' }} · {{ r.stage }} · {{ r.enabled?'启用':'停用' }}</summary>
      <div class="row"><label><input type="checkbox" :checked="r.enabled" @change="rule(i, { enabled: checked($event) })"> 启用</label><input aria-label="规则名称" :value="r.name" maxlength="80" @input="rule(i, { name: text($event) })"><button type="button" :disabled="i === 0" @click="setRules(move(rules, i, -1))">上移</button><button type="button" :disabled="i === rules.length - 1" @click="setRules(move(rules, i, 1))">下移</button><button type="button" :disabled="rules.length>=32" @click="duplicateRule(i)">复制</button><button type="button" @click="removeRule(i)">删除</button></div>
      <div class="row"><label>阶段<select :value="r.stage" @change="rule(i, { stage: text($event) as TextRule['stage'] })"><option value="input">最新玩家输入的上下文副本</option><option value="history">历史表达上下文</option><option value="output">发布前表达</option><option value="display">玩家展示</option></select></label><label>字段<select :value="r.target" @change="rule(i, { target: text($event) as TextRule['target'] })"><option value="both">对白与叙述</option><option value="speech">对白</option><option value="narration">叙述</option></select></label></div>
      <label>正则表达式（不写 / 分隔符）<input :value="r.pattern" maxlength="1000" @input="rule(i, { pattern: text($event) })"></label>
      <label>标志（g、i、m、s、u）<input :value="r.flags" maxlength="5" @input="rule(i, { flags: text($event) })"></label>
      <label>替换文本（支持 $1 等捕获组，留空即删除）<textarea :value="r.replacement" maxlength="4000" rows="2" @input="rule(i, { replacement: text($event) })" /></label>
      <p v-if="regexError(r)" role="alert">{{ regexError(r) }}</p>
    </details>
    <button v-if="removed" type="button" :disabled="removed.kind==='node'?nodes.length>=64:rules.length>=32" @click="undo">撤销删除「{{ removed.value.name }}」</button>
    <details><summary>示例预览</summary><p>使用你填写的示例文本；不读取角色私密上下文。日期和时间使用示例值。</p>
      <div class="row"><select v-model="stage" aria-label="预览阶段"><option value="input">输入</option><option value="history">历史</option><option value="output">发布前</option><option value="display">展示</option></select><select v-model="target" aria-label="预览字段"><option value="speech">对白</option><option value="narration">叙述</option></select></div>
      <textarea v-model="sample" rows="3" maxlength="64000" aria-label="转换前文本" /><button type="button" :disabled="busy" @click="inspect">预览提示排列与文本转换</button>
      <p v-if="error" role="alert">{{ error }}</p>
      <template v-if="result"><strong>转换后</strong><pre>{{ result.text }}</pre><details v-for="step in result.trace" :key="step.id"><summary>{{ step.name }}</summary><pre>{{ step.text }}</pre></details></template>
      <details v-if="sampleMessages.length"><summary>提示排列（示例）</summary><div v-for="(message, i) in sampleMessages" :key="i"><strong>{{ message.role }}</strong><pre>{{ message.content }}</pre></div></details>
    </details>
  </section>
</template>
<style scoped>
.content-editor{display:grid;gap:12px;font-size:13px}.item{display:grid;gap:9px;border:1px solid var(--border);border-radius:8px;padding:12px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.row>input{flex:1;min-width:100px}label{display:grid;gap:4px}.row label{display:flex;align-items:center;gap:6px}input:not([type=checkbox]),select,textarea{width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--background);font:inherit}input[type=checkbox]{width:auto}textarea{resize:vertical}button{padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--background);cursor:pointer}button:disabled{opacity:.4}p{margin:0;line-height:1.7;color:var(--muted-foreground)}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:9px;background:var(--muted)}summary{cursor:pointer}.item>summary{margin-bottom:8px;font-weight:600}[role=alert]{color:var(--danger)}
button:not([data-slot="button"]),input,select,textarea{color:var(--foreground)}
</style>
