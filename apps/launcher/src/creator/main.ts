import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import CreatorConsole from './CreatorConsole.vue'
import '../style.css'

/** 系统浏览器里的创作者页面：token 随 `#token=` 传入，读到后立即从地址栏移除。 */
const token = /^#token=([a-f0-9]{64})$/.exec(location.hash)?.[1] ?? ''
if (location.hash) history.replaceState(null, '', location.pathname + location.search)
createApp({ render: () => h(CreatorConsole, { token }) })
  .use(createPinia())
  .mount('#app')
