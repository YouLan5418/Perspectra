import { createApp } from 'vue'
import { createPinia } from 'pinia'
import LauncherShell from './components/LauncherShell.vue'
import './style.css'
createApp(LauncherShell).use(createPinia()).mount('#app')
