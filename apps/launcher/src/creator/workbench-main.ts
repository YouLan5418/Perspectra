import { createApp } from 'vue'
import WorldWorkbench from './WorldWorkbench.vue'
import { setEditorToken, selectEditorWorkspace } from './editor-api.ts'
import '../style.css'

const supplied = /^#token=([a-f0-9]{64})$/.exec(location.hash)?.[1]
const tokenKey = 'perspectra-editor-token'
if (supplied) sessionStorage.setItem(tokenKey, supplied)
selectEditorWorkspace(new URLSearchParams(location.search).get('workspace') ?? '')
setEditorToken(supplied ?? sessionStorage.getItem(tokenKey) ?? '')
if (location.hash) history.replaceState(null, '', location.pathname + location.search)
document.documentElement.dataset.theme = 'light'
createApp(WorldWorkbench).mount('#app')
