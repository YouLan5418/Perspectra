import { createApp } from 'vue'
import { createPinia } from 'pinia'
import LensWindow from './LensWindow.vue'
import { setLensToken } from './api.ts'
import '../style.css'

/** 系统浏览器里的透视页面：token 随 `#token=` 传入，读到后立即从地址栏移除。 */
setLensToken(/^#token=([a-f0-9]{64})$/.exec(location.hash)?.[1] ?? '')
if (location.hash) history.replaceState(null, '', location.pathname + location.search)
createApp(LensWindow).use(createPinia()).mount('#app')
