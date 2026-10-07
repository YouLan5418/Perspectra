<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLauncherStore } from '../stores/launcher.ts'
import DialogFrame from './DialogFrame.vue'
import { Button } from './ui/button/index.ts'
const props=defineProps<{open:boolean}>()
const emit=defineEmits<{close:[]}>()
const store=useLauncherStore(),confirmed=ref(false)
const info=computed(()=>store.currentFrontend)
watch(()=>props.open,async open=>{confirmed.value=false;if(open)await store.inspectFrontend()})
async function grant(){if(await store.grantFrontend(info.value?.digest??'',confirmed.value))emit('close')}
async function revoke(){if(await store.revokeFrontend())emit('close')}
</script>
<template>
 <DialogFrame :open="open" title="游戏前端权限" description="默认使用沙箱。授权只属于此实例和当前这份前端内容。" @close="emit('close')">
  <p v-if="!info">正在检查前端内容…</p>
  <p v-else-if="info.kind==='default'">此游戏使用官方默认前端，无需额外授权。</p>
  <template v-else>
   <p>当前授权：<strong>{{ info.mode==='trusted'?'受信任':'沙箱' }}</strong></p>
   <p>游戏包：{{ store.selectedPackage?.title }} · {{ store.selectedPackage?.version }}</p>
   <p>实例：{{ store.currentInstance?.name }}</p>
   <details><summary>查看当前内容摘要</summary><code style="overflow-wrap:anywhere">{{ info.digest }}</code></details>
   <p>受信任前端可访问外部网络（包括本机其他服务）、存储浏览器数据、收集你的输入和公开游戏历史。Perspectra 无法保证第三方代码安全。</p>
   <p>受信任前端访问的远程内容可以在不改变游戏包摘要的情况下发生变化。</p>
   <p>它仍不能读取 Core 令牌、模型密钥、角色私有上下文、实例数据库或 Launcher 原生权限；世界操作继续经过 Core 裁定。</p>
   <p>内容变化后授权失效，恢复沙箱。授权不自动应用到其他实例。</p>
   <label v-if="info.mode!=='trusted'"><input v-model="confirmed" type="checkbox" :disabled="store.busy || store.core.state==='running'"> 我已检查来源，愿意信任当前这份前端内容</label>
   <p v-if="store.core.state==='running' && info.mode!=='trusted'">启用受信任模式前请先结束当前游戏。</p>
  </template>
  <div class="dialog-actions">
   <Button variant="outline" @click="emit('close')">保持当前模式</Button>
   <Button v-if="info?.kind==='custom' && (info.mode==='trusted' || store.core.state==='running')" variant="outline" :disabled="store.busy" @click="revoke">撤销授权并恢复沙箱</Button>
   <Button v-if="info?.kind==='custom' && info.mode!=='trusted'" :disabled="!confirmed || store.busy || store.core.state==='running'" @click="grant">授权当前前端</Button>
  </div>
 </DialogFrame>
</template>
